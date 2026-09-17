import { expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { runCheck } from "../src/check.ts"
import { layer as judgeLayer } from "../src/judge.ts"
import { corpus, nodeLayer, tsgoStub } from "./support.ts"

const cacheDir = "/tmp/joggle-check-test"

it.effect("runs the deterministic rules and reports judged rules as skipped", () =>
  Effect.gen(function* () {
    const report = yield* runCheck({
      cwd: corpus,
      paths: ["src"],
      rules: undefined,
      typecheck: false,
      useTsgo: false,
    }).pipe(
      Effect.provide(judgeLayer({ cacheDir, offline: false, apiKey: Option.none() })),
      Effect.provide(tsgoStub),
      Effect.provide(nodeLayer),
    )

    expect(report.files).toBe(2)
    expect(report.rules).toBe(3)
    expect(report.diagnostics.length).toBe(2)
    expect(report.skipped.map((skip) => skip.ruleId).sort()).toEqual([
      "joggle/duplicate-meaning",
      "joggle/naming-drift",
    ])
    for (const skip of report.skipped) {
      expect(skip.reason).toContain("TYPESAFE_API_KEY")
    }
  }),
)

it.effect("a rule filter runs exactly one rule and skips nothing", () =>
  Effect.gen(function* () {
    const report = yield* runCheck({
      cwd: corpus,
      paths: ["src"],
      rules: ["joggle/duplicate-implementation"],
      typecheck: false,
      useTsgo: false,
    }).pipe(
      Effect.provide(judgeLayer({ cacheDir, offline: true, apiKey: Option.none() })),
      Effect.provide(tsgoStub),
      Effect.provide(nodeLayer),
    )
    expect(report.rules).toBe(1)
    expect(report.skipped.length).toBe(0)
    expect(report.diagnostics.length).toBe(2)
  }),
)
