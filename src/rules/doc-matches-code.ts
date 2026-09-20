import { Effect, Option, Schema } from "effect"
import { Decision, DecisionModel } from "effect/unstable/ai"
import { isUnreachable } from "../decision.ts"
import { policy } from "../policy.ts"
import {
  budgetNote,
  declined,
  defineRule,
  finding,
  marginOfAnswer,
  outcome,
  qualityOf,
  type DecisionAnswers,
  type Scope,
} from "../rule.ts"
import type { Diagnostic, Drop } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/doc-matches-code"

/**
 * A JSDoc that makes a claim the implementation contradicts.
 *
 * Three comments in three merged PRs on one repository were the same defect: a
 * doc block that had drifted from the code it sat on.
 *
 *   "comment says 'null for people with no project role' but band is typed as
 *    ReportingBand (not nullable)"
 *   "This points at a compareYears note that does not exist."
 *   "JSDoc says title-cased but there is no capitalization in here"
 *
 * None is a type error and none is a lint error. The type checker reads the type,
 * not the prose, and a linter reads syntax. The doc is the one artefact with no
 * checker at all, which is why it is the one that drifts.
 *
 * The model is the right instrument because the question is about meaning: does
 * the sentence describe what the code does? The prompt is strict on purpose --
 * a concrete contradiction only -- so the rule reports drift rather than style.
 */

const DocEvidence = Schema.Struct({
  declaration: Schema.Struct({
    name: Schema.String,
    path: Schema.String,
    kind: Schema.String,
    doc: Schema.String,
    source: Schema.String,
    types: Schema.Array(Schema.String),
  }),
})

const decisions = {
  verdict: Decision.classify({
    instructions: [
      "Does the JSDoc on `declaration.name` state a fact that `declaration.source` contradicts?",
      "Choose `no_issue` when the doc states no fact the code contradicts. This is the answer for a doc that is short, informal, high-level, or a summary rather than a full description.",
      "Choose a contradiction ONLY when you can point to the source that contradicts the doc:",
      "- `stale_reference`: the doc names a symbol, note, option or parameter that does not exist.",
      "- `wrong_contract`: the doc states a nullability, default, type, casing or format the code contradicts.",
      "- `wrong_behavior`: the doc describes behaviour the code does not have.",
    ].join("\n"),
    criteria: {
      no_issue: "The doc states no fact the code contradicts.",
      stale_reference: "The doc names a symbol, note, option or parameter that does not exist.",
      wrong_contract: "The doc states a nullability, default, type, casing or format the code contradicts.",
      wrong_behavior: "The doc describes behaviour the code does not have.",
    },
  }),
}

const DocReview = Decision.make({
  input: DocEvidence,
  decisions,
})

/**
 * The prose of a doc block.
 *
 * `@param`, `@returns` and `@see` are a second contract, and the type checker
 * already reads the real one. Comparing the tags to the code reports the tag's
 * wording rather than the doc's meaning, so the model sees the prose only.
 */
const proseOf = (doc: string): string =>
  doc
    .split("\n")
    .filter((line) => !line.trim().startsWith("@"))
    .join("\n")
    .trim()

/** An exported declaration with a doc block and enough in it to document. */
const candidatesIn = (workspace: Workspace, scope: Scope): ReadonlyArray<Unit> =>
  workspace.units
    .filter((unit) => unit.exported && unit.doc !== undefined && unit.doc.trim().length > 0)
    .filter((unit) => unit.tokens.length >= policy.docMatchesCode.minTokens)
    .filter((unit) => scope.changed === undefined || scope.changed.has(unit.file))
    .sort((left, right) => left.file.localeCompare(right.file) || left.start - right.start)

export const docMatchesCode = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "A JSDoc that makes a claim the implementation contradicts.",
  judged: true,
  run: Effect.fn("joggle/doc-matches-code")(function* (
    workspace: Workspace,
    scope: Scope,
  ) {
    const candidates = candidatesIn(workspace, scope)
    if (candidates.length === 0) {
      return outcome([], [
        "no exported declaration carries a doc block long enough to document a contract",
      ])
    }

    const budget = policy.docMatchesCode.maxDeclarations
    const judged = candidates.slice(0, budget)
    const label = (unit: Unit): string => unit.name + " (" + unit.file + ")"

    const results = yield* Effect.forEach(
      judged,
      (unit) =>
        DecisionModel.decide(DocReview, {
          input: {
            declaration: {
              name: unit.name,
              path: unit.file,
              kind: unit.kind,
              doc: proseOf(unit.doc ?? "").slice(0, policy.evidence.maxDocChars * 4),
              source: unit.text.slice(0, policy.evidence.maxSourceChars * 2),
              types: unit.typeRefs,
            },
          },
        }).pipe(
          Effect.map((result) => Option.some(result.answers)),
          Effect.catch((error) =>
            isUnreachable(error) ? Effect.fail(error) : Effect.succeed(Option.none<DecisionAnswers>()),
          ),
        ),
      { concurrency: policy.decision.requestConcurrency },
    )

    const diagnostics: Array<Diagnostic> = []
    const drops: Array<Drop> = candidates.slice(budget).map((unit) => ({
      ruleId: RULE_ID,
      subject: label(unit),
      stage: "budget" as const,
      reason: "past the budget of " + budget + " documented declarations",
    }))

    judged.forEach((unit, index) => {
      const answer = results[index]
      if (answer === undefined || Option.isNone(answer)) {
        drops.push({
          ruleId: RULE_ID,
          subject: label(unit),
          stage: "unreadable",
          reason: "the response did not judge this doc block",
        })
        return
      }
      const verdict = answer.value["verdict"]
      if (verdict === undefined || !("label" in verdict)) {
        drops.push({
          ruleId: RULE_ID,
          subject: label(unit),
          stage: "unreadable",
          reason: "the response did not contain a usable verdict",
        })
        return
      }
      if (declined(verdict.label)) {
        drops.push({
          ruleId: RULE_ID,
          subject: label(unit),
          stage: "declined",
          reason: "the doc matches the code",
        })
        return
      }
      const margin = marginOfAnswer(verdict)
      const chosen = Object.entries(verdict.probabilities).find(([label]) => label === verdict.label)?.[1] ?? 0
      const quality = qualityOf({ score: chosen, margin, confidence: verdict.confidence })
      if (quality.quality === "drop") {
        drops.push({
          ruleId: RULE_ID,
          subject: label(unit),
          stage: "gated",
          reason: quality.reason,
        })
        return
      }
      diagnostics.push(
        finding({
          ruleId: RULE_ID,
          severity: quality.quality === "review" ? "info" : "warn",
          message: label(unit) + " has a doc block that contradicts the code: " + verdict.label.replace(/_/g, " ") + ".",
          help: "Fix the doc to match the code, or the code to match the doc. The doc is the one artefact no checker reads, so it is the one that drifts.",
          location: unit.location,
          identity: [RULE_ID, unit.file, unit.name].join("\u0000"),
          confidence: verdict.confidence ?? 1,
          score: chosen,
          judged: true,
        }),
      )
    })

    return outcome(
      diagnostics,
      budgetNote("documented declarations", budget, candidates.length, candidates.slice(budget).map(label)),
      drops,
    )
  }),
})
