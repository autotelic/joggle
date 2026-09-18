import { Effect, Layer, Option } from "effect"
import { NodeServices } from "@effect/platform-node"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { Service as JudgeService } from "../src/judge.ts"
import { JudgeUnavailable, type Answer, type WorkspaceError } from "../src/schema.ts"
import { Service as TsgoService } from "../src/tsgo.ts"
import { loadWorkspace, type Workspace } from "../src/workspace.ts"
import type { RunContext } from "../src/rule.ts"

export const corpus = "tests/fixtures/corpus"

/** Everything a test needs to run the real workspace and judge layers. */
export const nodeLayer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)

export const tsgoStub = Layer.succeed(
  TsgoService,
  TsgoService.of({
    listFiles: () => Effect.succeed([]),
    typecheck: () => Effect.succeed([]),
  }),
)

const stubStats = {
  requests: 1,
  replayed: 0,
  calls: 0,
  unavailable: 0,
  inputTokens: 0,
  outputTokens: 0,
}

export const judgeStub = (answers: Readonly<Record<string, Answer>>) =>
  Layer.succeed(
    JudgeService,
    JudgeService.of({
      ask: () => Effect.succeed({ answers, replayed: false }),
      // Every candidate gets the same stubbed verdict, batched or not: the
      // stubs are about policy, and batching must not change the policy.
      askMany: (requests) =>
        Effect.succeed(requests.map(() => ({ answers, replayed: false }))),
      stats: Effect.succeed(stubStats),
    }),
  )

export const judgeFailing = (reason: string) =>
  Layer.succeed(
    JudgeService,
    JudgeService.of({
      ask: () => Effect.fail(new JudgeUnavailable({ reason })),
      askMany: () => Effect.fail(new JudgeUnavailable({ reason })),
      stats: Effect.succeed(stubStats),
    }),
  )

/**
 * Load the fixture workspace once per test and hand it to the body. The body's
 * remaining requirements are the test's business (usually a judge stub).
 */
export const withWorkspace = <A, E, R>(
  use: (workspace: Workspace) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | WorkspaceError, Exclude<R, NodeServices.NodeServices>> =>
  Effect.gen(function* () {
    const workspace = yield* loadWorkspace(corpus, ["src"])
    return yield* use(workspace)
  }).pipe(Effect.provide(NodeServices.layer))

export const noul = (value: number): Answer => ({ type: "noul", noul: value })

export const choice = (value: string, confidence: number): Answer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
})

export const noApiKey = Option.none<string>()

/**
 * The run context for a rule that needs no configuration.
 *
 * The architecture rules read the declared layering, so every rule now takes a
 * context; most rules ignore it, and a test that is not about layering should
 * not have to invent one.
 */
export const noConfig: RunContext = { config: {} }
