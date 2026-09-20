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
import type { SourceFile, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/rule-judgment"

/**
 * A rule that decides in code a question only a judgement can answer.
 *
 * This is the tool applied to itself. joggle's own rule is: code finds the
 * candidate, the model makes the judgement. A rule that computes a structural
 * signal and then asserts a semantic quality from it has moved the judgement back
 * into code, which is the disease this program exists to remove -- a person's
 * guess wearing a number.
 *
 * The candidate is structural: a file that calls `defineRule`. That is any rule
 * in this repository or in a plugin. The judgement is the model's, because "is
 * this a fact or an opinion?" is not checkable by a linter either.
 *
 * `rule.judged` is part of the state on purpose. A rule that already asks the
 * model is not deciding in code, and the model should be told which it is looking
 * at rather than inferring it from an import.
 */
const Evidence = Schema.Struct({
  rule: Schema.Struct({
    path: Schema.String,
    judged: Schema.Boolean,
    /**
     * Whether this rule ships in a preset rather than running by default.
     *
     * A preset rule checks conformance to a pattern a repository OPTED INTO, so
     * the pattern is the contract and checking it is a fact. Without this flag
     * the model reads `{ state, actions, meta }` as an opinion the rule invented
     * and flags the rule that enforces it.
     */
    preset: Schema.Boolean,
    source: Schema.String,
  }),
})

const RuleReview = Decision.make({
  input: Evidence,
  decisions: {
    decides_in_code: Decision.probability({
      instructions: [
        "Does `rule.path` decide in code a question that needs a judgement?",
        "Judge the rule's MESSAGE. Advice in the help text is not the verdict: a rule may state what it found and suggest a fix, and the finding is still a fact.",
        "A rule that states a measurement is NOT deciding in code: it says what it found and the reader decides. \"This file exports nine things over twenty lines\" is a fact, even when the help suggests a fix.",
        "A rule whose `rule.preset` is true checks conformance to a pattern the repository DECLARES. That pattern is the contract, so checking it is a fact about the declaration rather than a judgement about the code.",
        "A rule DOES decide in code when either:",
        "- a NUMBER in it decides a verdict rather than bounding a search: a rule that reports a name as unsearchable because it is reached from fewer than N files, or a file as shallow because a ratio is below a threshold;",
        "- its MESSAGE asserts a quality rather than a measurement: \"these are one thing\", \"this is a grab bag\", \"this name is an address\", \"this is not worth keeping\".",
        "A number that only bounds how much work a run does -- a budget, a maximum, a token limit -- is not a judgement.",
        "`rule.judged` says whether the rule already asks the model. A rule that asks the model is not deciding in code, whatever its candidate filter looks like.",
      ].join("\n"),
      criteria: {
        false: "The rule states a fact, or it already asks the model.",
        true: "The rule decides a judgement in code.",
      },
    }),
    kind: Decision.classify({
      instructions: [
        "If `rule.path` decides in code, what kind of judgement is it?",
        "Choose `no_issue` when the rule states a fact, or when it already asks the model.",
      ].join("\n"),
      criteria: {
        semantic_verdict: "It computes something structural and then asserts a semantic quality from it.",
        magic_threshold: "A number in the rule encodes a person's opinion rather than a bound on search.",
        name_meaning: "It matches names and then asserts what they mean.",
        no_issue: "It states a fact, or it already asks the model.",
      },
    }),
  },
})

/**
 * Whether the rule file ships in a preset.
 *
 * A preset is a module that imports rules and re-exports them, so the edge from a
 * `presets/` file to this one is the declaration that the rule is opt-in.
 */
const isPreset = (workspace: Workspace, path: string): boolean =>
  workspace.imports.edges.some((edge) => edge.to === path && edge.from.includes("/presets/"))

/** A rule file: a file that calls `defineRule`. */
const candidatesIn = (workspace: Workspace, scope: Scope): ReadonlyArray<SourceFile> =>
  workspace.files.filter(
    (file) =>
      (scope.changed === undefined || scope.changed.has(file.path)) &&
      file.facts.callSites.some((site) => site.name === "defineRule"),
  )

export const ruleJudgment = defineRule({
  id: RULE_ID,
  severity: "info",
  description: "A rule that decides in code a question only a judgement can answer.",
  judged: true,
  run: Effect.fn("joggle/rule-judgment")(function* (workspace: Workspace, scope: Scope) {
    const candidates = candidatesIn(workspace, scope)
    if (candidates.length === 0) {
      return outcome([], ["no file calls defineRule, so there was no rule to audit"])
    }
    const budget = policy.ruleJudgment.maxRules
    const judged = candidates.slice(0, budget)

    const results = yield* Effect.forEach(
      judged,
      (file) =>
        DecisionModel.decide(RuleReview, {
          input: {
            rule: {
              path: file.path,
              judged: file.text.includes("judged: true"),
              preset: isPreset(workspace, file.path),
              source: file.text.slice(0, policy.evidence.maxSourceChars * 6),
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
    const drops: Array<Drop> = candidates.slice(budget).map((file) => ({
      ruleId: RULE_ID,
      subject: file.path,
      stage: "budget" as const,
      reason: "past the budget of " + budget + " rule files",
    }))

    judged.forEach((file, index) => {
      const answer = results[index]
      if (answer === undefined || Option.isNone(answer)) {
        drops.push({
          ruleId: RULE_ID,
          subject: file.path,
          stage: "unreadable",
          reason: "the response did not audit this rule",
        })
        return
      }
      const decides = answer.value["decides_in_code"]
      const kind = answer.value["kind"]
      if (decides === undefined || !("probability" in decides) || kind === undefined || !("label" in kind)) {
        drops.push({
          ruleId: RULE_ID,
          subject: file.path,
          stage: "unreadable",
          reason: "the response did not contain a usable verdict",
        })
        return
      }
      if (declined(kind.label)) {
        drops.push({
          ruleId: RULE_ID,
          subject: file.path,
          stage: "declined",
          reason: "the rule states a fact or already asks the model",
        })
        return
      }
      const quality = qualityOf({
        score: decides.probability,
        margin: marginOfAnswer(kind),
        confidence: kind.confidence,
      })
      if (quality.quality === "drop") {
        drops.push({ ruleId: RULE_ID, subject: file.path, stage: "gated", reason: quality.reason })
        return
      }
      const review = quality.quality === "review"
      diagnostics.push(
        finding({
          ruleId: RULE_ID,
          severity: review ? "info" : "warn",
          message:
            file.path +
            " decides in code what only a judgement can decide: " +
            kind.label.replace(/_/g, " ") +
            ".",
          help:
            "Code should find the candidate; the model should make the call. Keep the structural filter and ask a Decision for the verdict." +
            (review ? " For review: " + quality.reason + "." : ""),
          location: { file: file.path, line: 1, column: 1 },
          identity: [RULE_ID, file.path].join("\u0000"),
          confidence: kind.confidence ?? 1,
          score: decides.probability,
          judged: true,
        }),
      )
    })

    return outcome(
      diagnostics,
      budgetNote("rule files", budget, candidates.length, candidates.slice(budget).map((file) => file.path)),
      drops,
    )
  }),
})
