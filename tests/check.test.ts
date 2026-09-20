import { expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { runCheck } from "../src/check.ts"
import { layer as decisionLayer } from "../src/decision.ts"
import { builtIn } from "../src/rules/index.ts"
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
      cacheDir: "/tmp/joggle-check-test",
      replayUnchanged: false,
      changed: false,
      baselinePath: undefined,
      updateBaselinePath: undefined,
      config: {},
    }).pipe(
      Effect.provide(decisionLayer({ cacheDir, offline: true, apiKey: Option.none() })),
      Effect.provide(tsgoStub),
      Effect.provide(builtIn),
      Effect.provide(nodeLayer),
    )

    const boundary = report.diagnostics.find((entry) => entry.ruleId === "joggle/cache-boundary")
    expect(boundary?.severity).toBe("error")
    expect(boundary?.message).toContain("outside the project root")

    // A breach withholds every JUDGED rule, because their evidence would cross
    // repositories. The structural rules persist nothing, so they still run.
    expect(report.rules).toBe(9)
    expect(report.diagnostics.every((entry) => !entry.judged)).toBe(true)
    expect(report.skipped.map((skip) => skip.ruleId).sort()).toEqual([
      "joggle/dependency-fit",
      "joggle/doc-matches-code",
      "joggle/duplicate-implementation",
      "joggle/duplicate-meaning",
      "joggle/hoist-to-domain",
      "joggle/language-drift",
      "joggle/module-direction",
      "joggle/name-as-address",
      "joggle/naming-drift",
      "joggle/rule-judgment",
      "joggle/shallow-module",
      "joggle/temporal-coupling",
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
      cacheDir: "/tmp/joggle-check-test",
      replayUnchanged: false,
      changed: false,
      baselinePath: undefined,
      updateBaselinePath: undefined,
      config: {},
    }).pipe(
      Effect.provide(decisionLayer({ cacheDir, offline: false, apiKey: Option.none() })),
      Effect.provide(tsgoStub),
      Effect.provide(builtIn),
      Effect.provide(nodeLayer),
    )

    expect(report.files).toBe(2)
    // Ten structural rules plus eleven judged ones. The composition rules are a
    // preset and are not in this run at all, which is what makes them an opinion
    // rather than an inheritance.
    expect(report.rules).toBe(21)
    expect(report.diagnostics.length).toBe(1)
    // The fixture has no bundles, pages or modals, so the structural rules find
    // nothing and the page rule produces no candidates. A rule with nothing to
    // look at never reaches the judge, so it is idle rather than skipped.
    // dependency-fit is absent rather than skipped: the fixture imports nothing
    // external, so it has no candidates and never reaches the judge. Idle, not
    // skipped -- the same distinction the page rule makes.
    // module-direction is here because the fixture HAS modules: it classifies them
    // before it can say anything about direction, so it reaches the judge on a
    // repository that declares no layers.
    expect(report.skipped.map((skip) => skip.ruleId).sort()).toEqual([
      "joggle/duplicate-meaning",
      "joggle/module-direction",
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
      cacheDir: "/tmp/joggle-check-test",
      replayUnchanged: false,
      changed: false,
      baselinePath: undefined,
      updateBaselinePath: undefined,
      config: {},
    }).pipe(
      Effect.provide(decisionLayer({ cacheDir, offline: true, apiKey: Option.none() })),
      Effect.provide(tsgoStub),
      Effect.provide(builtIn),
      Effect.provide(nodeLayer),
    )
    expect(report.rules).toBe(1)
    expect(report.skipped.length).toBe(0)
    expect(report.diagnostics.length).toBe(1)
  }),
)
