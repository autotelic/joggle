import { Effect, Layer } from "effect"
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
  readonly judge?: Layer.Layer<JudgeService> | undefined
}

export const diagnosticsOf = (
  rule: Rule,
  workspace: Workspace,
  options: RuleTestOptions = {},
): Effect.Effect<ReadonlyArray<Diagnostic>, JudgeError> =>
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
): Layer.Layer<JudgeService> =>
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
  )

/** A judge that cannot answer, for testing what a rule does without one. */
export const refusingJudge = (reason: string): Layer.Layer<JudgeService> =>
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
  )
