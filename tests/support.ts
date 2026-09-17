import { Effect, Layer, Option } from "effect"
import { NodeServices } from "@effect/platform-node"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { Service as JudgeService } from "../src/judge.ts"
import { JudgeUnavailable, type Answer, type WorkspaceError } from "../src/schema.ts"
import { Service as TsgoService } from "../src/tsgo.ts"
import { loadWorkspace, type Workspace } from "../src/workspace.ts"

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

export const judgeStub = (answers: Readonly<Record<string, Answer>>) =>
  Layer.succeed(
    JudgeService,
    JudgeService.of({
      ask: () => Effect.succeed({ answers, replayed: false }),
      stats: Effect.succeed({ requests: 1, replayed: 0, calls: 0, unavailable: 0 }),
    }),
  )

export const judgeFailing = (reason: string) =>
  Layer.succeed(
    JudgeService,
    JudgeService.of({
      ask: () => Effect.fail(new JudgeUnavailable({ reason })),
      stats: Effect.succeed({ requests: 1, replayed: 0, calls: 0, unavailable: 0 }),
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
