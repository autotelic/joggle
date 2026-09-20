import { Effect, Layer } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import { DecisionModel } from "effect/unstable/ai"
import { judgeError } from "./decision.ts"
import { everyFile, type Rule, type RunContext } from "./rule.ts"
import type { Diagnostic } from "./schema.ts"
import type { Workspace } from "./workspace.ts"

/** A test's answer for one decision, in the vocabulary the tests already use. */
export type StubAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "choice"
      readonly choice: string
      readonly probabilities: Readonly<Record<string, number>>
      readonly confidence: number
    }

/**
 * What a rule author needs in order to test a rule.
 *
 * Writing a second rule is the point of the registry, and nobody writes a second
 * rule without a way to run it. Every test in this repository hand-rolled the
 * same three lines to get a rule's diagnostics out of an Effect; that is exactly
 * the boilerplate a published surface should absorb.
 *
 * Deliberately small. A tester is not a framework: it runs one rule over one
 * already-loaded workspace and hands back what the rule said.
 */
export interface RuleTestOptions {
  /** What the rule is told about the run. Empty config by default. */
  readonly context?: RunContext | undefined
  /**
   * The answers to give, when the rule asks for any.
   *
   * Absent means a model that refuses with a clear reason. A structural rule
   * never reaches it -- and the type has to ask for a service either way, because
   * a rule that turns out to be judged must not be a compile error. Defaulting to
   * refusal rather than to silence means a rule that DOES ask fails loudly
   * instead of quietly reporting nothing.
   */
  readonly judge?: Layer.Layer<DecisionModel.DecisionModel> | undefined
}

export const diagnosticsOf = (
  rule: Rule,
  workspace: Workspace,
  options: RuleTestOptions = {},
): Effect.Effect<ReadonlyArray<Diagnostic>, AiError.AiError> =>
  rule.run(workspace, everyFile, options.context ?? { config: {} }).pipe(
    Effect.map((result) => result.diagnostics),
    Effect.provide(
      options.judge ?? refusingJudge("this rule asked for a judgement and none was provided"),
    ),
  )

/** A model that answers every decision from one table. */
export const answeringJudge = (
  answers: Readonly<Record<string, StubAnswer>>,
): Layer.Layer<DecisionModel.DecisionModel> => decisionStub(answers)

/** A model that cannot answer, for testing what a rule does without one. */
export const refusingJudge = (reason: string): Layer.Layer<DecisionModel.DecisionModel> =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () =>
        Effect.fail(
          judgeError(["joggle/testing", "decide"], new AiError.UnknownError({ description: reason })),
        ),
    }),
  )

/**
 * A DecisionModel that answers from a table of answers.
 *
 * The tests are about policy, so the model is a stub. A distribution with labels
 * missing gets the remainder spread over them, so a test can name only the
 * options it is about and still pass Effect's validation.
 */
export const decisionStub = (
  supplied: Readonly<Record<string, StubAnswer>> = {},
): Layer.Layer<DecisionModel.DecisionModel> =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ decisions }) =>
        Effect.succeed({
          answers: Object.fromEntries(
            Object.entries(decisions).map(([key, decision]) => {
              const answer = supplied[key]
              if (decision._tag === "Classify") {
                const labels = Object.keys(decision.criteria)
                const label =
                  answer !== undefined && answer.type === "choice" ? answer.choice : (labels[0] ?? "")
                const given =
                  answer !== undefined && answer.type === "choice" ? answer.probabilities : {}
                const missing = labels.filter((candidate) => given[candidate] === undefined)
                const total = Object.values(given).reduce((sum, value) => sum + value, 0)
                const remainder = missing.length === 0 ? 0 : Math.max(0, (1 - total) / missing.length)
                return [
                  key,
                  {
                    _tag: "Classify" as const,
                    label,
                    probabilities: Object.fromEntries(
                      labels.map((candidate) => [candidate, given[candidate] ?? remainder]),
                    ),
                    confidence:
                      answer !== undefined && answer.type === "choice" ? answer.confidence : 0.9,
                  },
                ]
              }
              if (decision._tag === "Rate") {
                const levels = decision.criteria
                return [
                  key,
                  {
                    _tag: "Rate" as const,
                    rating: 0,
                    probabilities: Object.fromEntries(
                      levels.map((level, index) => [level, index === 0 ? 1 : 0]),
                    ),
                    confidence: 0.9,
                  },
                ]
              }
              return [
                key,
                {
                  _tag: "Probability" as const,
                  probability: answer !== undefined && answer.type === "noul" ? answer.noul : 0.9,
                },
              ]
            }),
          ),
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
    }),
  )
