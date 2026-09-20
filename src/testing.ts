import { Effect, Layer } from "effect"
import { DecisionModel } from "effect/unstable/ai"
import type * as AiError from "effect/unstable/ai/AiError"
import { Service as JudgeService, type JudgeResult } from "./judge.ts"
import { everyFile, type Rule, type RunContext } from "./rule.ts"
import { JudgeUnavailable, type Answer, type Diagnostic, type JudgeError } from "./schema.ts"
import type { Workspace } from "./workspace.ts"

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
   * Absent means a judge that refuses with a clear reason. A structural rule
   * never reaches it -- and the type has to ask for a service either way, because
   * a rule that turns out to be judged must not be a compile error. Defaulting to
   * refusal rather than to silence means a rule that DOES ask fails loudly
   * instead of quietly reporting nothing.
   */
  readonly judge?: Layer.Layer<JudgeService | DecisionModel.DecisionModel> | undefined
}

export const diagnosticsOf = (
  rule: Rule,
  workspace: Workspace,
  options: RuleTestOptions = {},
): Effect.Effect<ReadonlyArray<Diagnostic>, JudgeError | AiError.AiError> =>
  rule.run(workspace, everyFile, options.context ?? { config: {} }).pipe(
    Effect.map((result) => result.diagnostics),
    Effect.provide(
      options.judge ?? refusingJudge("this rule asked for a judgement and none was provided"),
    ),
  )

/**
 * A judge that answers every question the same way.
 *
 * Batching must not change policy, so the stub answers each request identically
 * whether they arrived together or apart -- which is what lets a test assert
 * about a RULE rather than about how its requests happened to be packed.
 */
export const answeringJudge = (
  answers: Readonly<Record<string, Answer>>,
): Layer.Layer<JudgeService | DecisionModel.DecisionModel> =>
  Layer.mergeAll(
    Layer.succeed(
      JudgeService,
      JudgeService.of({
        ask: () => Effect.succeed({ answers, replayed: false }),
        askMany: (requests) =>
          Effect.succeed(
            requests.map((): JudgeResult => ({ answers, replayed: false })),
          ),
        stats: Effect.succeed({
          requests: 0,
          replayed: 0,
          calls: 0,
          unavailable: 0,
          inputTokens: 0,
          outputTokens: 0,
        }),
      }),
    ),
    decisionStub(answers),
  )

/** A judge that cannot answer, for testing what a rule does without one. */
export const refusingJudge = (reason: string): Layer.Layer<JudgeService | DecisionModel.DecisionModel> =>
  Layer.mergeAll(
    Layer.succeed(
      JudgeService,
      JudgeService.of({
        ask: () => Effect.fail(new JudgeUnavailable({ reason })),
        askMany: () => Effect.fail(new JudgeUnavailable({ reason })),
        stats: Effect.succeed({
          requests: 0,
          replayed: 0,
          calls: 0,
          unavailable: 0,
          inputTokens: 0,
          outputTokens: 0,
        }),
      }),
    ),
    decisionStub(),
  )

/**
 * A DecisionModel that answers every decision consistently.
 *
 * A test asserts policy, not the provider, so classify decisions choose one label
 * and probability decisions answer one number. The answers still pass Effect's
 * validation, so a rule under test sees a real Decision answer.
 */
export const decisionStub = (
  supplied: Readonly<Record<string, Answer>> = {},
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
                    confidence: answer !== undefined && answer.type === "choice" ? answer.confidence : 0.9,
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
