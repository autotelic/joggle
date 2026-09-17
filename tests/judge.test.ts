import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Option } from "effect"
import { cacheKeyFor, layer as judgeLayer, Service as JudgeService } from "../src/judge.ts"
import { policy } from "../src/policy.ts"
import { JudgeUnavailable } from "../src/schema.ts"
import { nodeLayer } from "./support.ts"

const cacheDir = "/tmp/joggle-judge-test"

const request = {
  evidence: { left: { symbol: "a" }, right: { symbol: "b" } },
  questions: {
    same_concept: {
      type: "noul" as const,
      instructions: "Are these the same concept?",
    },
  },
}

it.effect("replays a judgement from the persisted cache with no API key", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const key = cacheKeyFor(request)
    yield* fs.makeDirectory(cacheDir, { recursive: true })
    yield* fs.writeFileString(
      `${cacheDir}/judgements.json`,
      JSON.stringify({
        version: policy.version,
        entries: { [key]: { same_concept: { type: "noul", noul: 0.91 } } },
      }),
    )

    const result = yield* Effect.gen(function* () {
      const judge = yield* JudgeService
      return yield* judge.ask(request)
    }).pipe(Effect.provide(judgeLayer({ cacheDir, offline: true, apiKey: Option.none() })))

    expect(result.replayed).toBe(true)
    expect(result.answers["same_concept"]).toEqual({ type: "noul", noul: 0.91 })
  }).pipe(Effect.provide(nodeLayer)),
)

it.effect("offline without a cached judgement fails with a typed error", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(cacheDir, { recursive: true, force: true })
    const error = yield* Effect.gen(function* () {
      const judge = yield* JudgeService
      return yield* judge.ask(request)
    }).pipe(
      Effect.provide(judgeLayer({ cacheDir, offline: true, apiKey: Option.none() })),
      Effect.flip,
    )
    expect(error).toBeInstanceOf(JudgeUnavailable)
  }).pipe(Effect.provide(nodeLayer)),
)

it.effect("the cache key carries the question version and the model", () =>
  Effect.sync(() => {
    const key = cacheKeyFor(request)
    expect(key).toContain(policy.questionVersion)
    expect(key).toContain(policy.model)
  }),
)
