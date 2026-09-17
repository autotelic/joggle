import { expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { runCheck } from "../src/check.ts"
import { layer as judgeLayer } from "../src/judge.ts"
import { corpus, nodeLayer, tsgoStub } from "./support.ts"

const cacheDir = "/tmp/joggle-check-test"

it.effect("refuses to persist judgements for code outside the analysis root", () =>
  Effect.gen(function* () {
    const report = yield* runCheck({
      cwd: `${corpus}/src`,
      paths: ["../../outside"],
      rules: undefined,
      typecheck: false,
      useTsgo: false,
      cacheDirExplicit: false,
    }).pipe(
      Effect.provide(judgeLayer({ cacheDir, offline: true, apiKey: Option.none() })),
      Effect.provide(tsgoStub),
      Effect.provide(nodeLayer),
    )

    const boundary = report.diagnostics.find((entry) => entry.ruleId === "joggle/cache-boundary")
    expect(boundary?.severity).toBe("error")
    expect(boundary?.message).toContain("outside the project root")

    // Deterministic rules still run; the judged ones are withheld, not guessed.
    expect(report.rules).toBe(1)
    expect(report.diagnostics.every((entry) => !entry.judged)).toBe(true)
    expect(report.skipped.map((skip) => skip.ruleId).sort()).toEqual([
      "joggle/duplicate-meaning",
      "joggle/naming-drift",
    ])
    expect(report.skipped.every((skip) => skip.reason.includes("cache boundary"))).toBe(true)
  }),
)

it.effect("runs the deterministic rules and reports judged rules as skipped", () =>
  Effect.gen(function* () {
    const report = yield* runCheck({
      cwd: corpus,
      paths: ["src"],
      rules: undefined,
      typecheck: false,
      useTsgo: false,
      cacheDirExplicit: true,
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
      cacheDirExplicit: true,
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
