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
import type { Workspace } from "../workspace.ts"

const RULE_ID = "joggle/name-as-address"

/**
 * A name too common to be an address.
 *
 * The reference material this rule comes from opens with the measurement that
 * motivates it: an agent finds code by searching for a name, so `grep create`
 * returning 1,585 hits is not a style problem, it is a retrieval problem.
 *
 * The CANDIDATE is structural and free: an exported single-word name, called from
 * at least `minFiles` files, where the call RESOLVES to this declaration. The
 * resolution matters -- thirty call sites named `parse` reaching three different
 * functions are not sixty hits on any one of them -- and the single word matters,
 * because `fetchPayrollProjections` used in thirty files is a good address used
 * often.
 *
 * The JUDGEMENT is whether THIS word at THAT count fails as an address. The count
 * is a fact; the verdict is not. `range` reached from thirty files is a bad
 * address, while a one-word domain term reached from the same number may be the
 * right one. The first version answered with the threshold and asserted the
 * verdict in the message -- "searching for it finds everything and nothing" --
 * which moved a judgement into code. The model answers now, and code reports what
 * it picked.
 */
const isSingleWord = (name: string): boolean => /^[a-z][a-z0-9]*$/.test(name)

const Evidence = Schema.Struct({
  name: Schema.Struct({
    identifier: Schema.String,
    declared: Schema.String,
    files: Schema.Number,
    callers: Schema.Array(Schema.String),
  }),
})

const NameReview = Decision.make({
  input: Evidence,
  decisions: {
    fails_as_address: Decision.probability({
      instructions: [
        "Is `name.identifier`, declared at `name.declared`, a bad retrieval address?",
        "It is a single-word export, and `name.files` files call it. `name.callers` is a sample of them.",
        "An agent finds code by searching for a name, so a name that matches everything finds nothing.",
        "Answer true when the word is generic enough that a search cannot narrow to this declaration: `range`, `create`, `handle`, `parse`, `data`.",
        "Answer false when the single word is a term specific to this codebase, or when the declaration is easy to reach from the callers anyway.",
      ].join("\n"),
      criteria: {
        false: "The name still finds this declaration.",
        true: "The name finds everything and nothing.",
      },
    }),
    address: Decision.classify({
      instructions: "If the name is a bad address, what kind of word is it? Choose `no_issue` when the name still finds the declaration.",
      criteria: {
        generic_verb: "A generic verb: create, get, handle, parse, build.",
        generic_noun: "A generic noun: data, config, value, state, item.",
        overloaded_domain: "A domain word used for more than one thing.",
        no_issue: "The name still finds the declaration.",
      },
    }),
  },
})

export const nameAsAddress = defineRule({
  id: RULE_ID,
  severity: "info",
  description: "A generic single-word export called from too many files to be searchable.",
  judged: true,
  run: Effect.fn("joggle/name-as-address")(function* (workspace: Workspace, scope: Scope) {
    const { minFiles, maxFiles, maxCallers } = policy.nameAsAddress
    const exported = workspace.units.filter((unit) => unit.exported)

    // Which files call each declaration, by resolved identity.
    const calledFrom = new Map<string, Set<string>>()
    for (const unit of workspace.units) {
      for (const callee of unit.calls) {
        const files = calledFrom.get(callee) ?? new Set<string>()
        files.add(unit.file)
        calledFrom.set(callee, files)
      }
    }

    const candidates = exported
      .filter((unit) => isSingleWord(unit.name))
      .filter((unit) => scope.changed === undefined || scope.changed.has(unit.file))
      .map((unit) => ({
        unit,
        callers: [...(calledFrom.get(unit.file + "#" + unit.name) ?? new Set<string>())].sort(),
      }))
      .filter((entry) => entry.callers.length >= minFiles)
      .sort((left, right) => right.callers.length - left.callers.length)

    if (candidates.length === 0) {
      return outcome([], [
        exported.length +
          " exported declaration(s), none of them a single-word name called from " +
          minFiles +
          " or more files",
      ])
    }

    const judged = candidates.slice(0, maxFiles)
    const results = yield* Effect.forEach(
      judged,
      (candidate) =>
        DecisionModel.decide(NameReview, {
          input: {
            name: {
              identifier: candidate.unit.name,
              declared: candidate.unit.file,
              files: candidate.callers.length,
              callers: candidate.callers.slice(0, maxCallers),
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
    const drops: Array<Drop> = candidates.slice(maxFiles).map((candidate) => ({
      ruleId: RULE_ID,
      subject: candidate.unit.file + "#" + candidate.unit.name,
      stage: "budget" as const,
      reason: "past the budget of " + maxFiles + " common names",
    }))

    judged.forEach((candidate, index) => {
      const answer = results[index]
      if (answer === undefined || Option.isNone(answer)) {
        drops.push({
          ruleId: RULE_ID,
          subject: candidate.unit.file + "#" + candidate.unit.name,
          stage: "unreadable",
          reason: "the response did not judge this name",
        })
        return
      }
      const fails = answer.value["fails_as_address"]
      const address = answer.value["address"]
      if (fails === undefined || !("probability" in fails) || address === undefined || !("label" in address)) {
        drops.push({
          ruleId: RULE_ID,
          subject: candidate.unit.file + "#" + candidate.unit.name,
          stage: "unreadable",
          reason: "the response did not contain a usable verdict",
        })
        return
      }
      if (declined(address.label)) {
        drops.push({
          ruleId: RULE_ID,
          subject: candidate.unit.file + "#" + candidate.unit.name,
          stage: "declined",
          reason: "the name still finds this declaration",
        })
        return
      }
      const quality = qualityOf({
        score: fails.probability,
        margin: marginOfAnswer(address),
        confidence: address.confidence,
      })
      if (quality.quality === "drop") {
        drops.push({
          ruleId: RULE_ID,
          subject: candidate.unit.file + "#" + candidate.unit.name,
          stage: "gated",
          reason: quality.reason,
        })
        return
      }
      const review = quality.quality === "review"
      diagnostics.push(
        finding({
          ruleId: RULE_ID,
          severity: review ? "info" : "warn",
          message:
            "`" +
            candidate.unit.name +
            "` is called from " +
            candidate.callers.length +
            " files, and it is a " +
            address.label.replace(/_/g, " ") +
            " rather than an address.",
          help:
            "A name is how this declaration is found: it is the address, not a summary. Rename it to say what it is for -- \`" +
            candidate.unit.name +
            "\` gives a reader and an agent nothing to narrow by, while a name of two or three specific words makes every future search cheaper." +
            (review ? " For review: " + quality.reason + "." : ""),
          location: candidate.unit.location,
          identity: [RULE_ID, candidate.unit.file, candidate.unit.name].join("\u0000"),
          confidence: address.confidence ?? 1,
          score: fails.probability,
          judged: true,
        }),
      )
    })

    return outcome(
      diagnostics,
      budgetNote("common names", maxFiles, candidates.length, candidates.slice(maxFiles).map((c) => c.unit.name)),
      drops,
    )
  }),
})
