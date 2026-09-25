import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { singlePath } from "../src/rules/single-path.ts"
import { plannedDiagnosticsOf } from "../src/testing.ts"
import { loadWorkspace } from "../src/workspace.ts"
import { choice, modelStub } from "./support.ts"

const fixture = () => loadWorkspace("tests/fixtures/single-path", ["src"])

it.effect("a money string built beside formatDollar is a finding", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(singlePath, workspace)
    expect(result.diagnostics.length).toBe(1)
    expect(result.diagnostics[0]?.message).toContain("formatDollar")
    expect(result.diagnostics[0]?.move).toBe("contract")
  }).pipe(
    Effect.provide(modelStub({ verdict: choice("reimplements", 0.95) })),
    Effect.provide(NodeServices.layer),
  ),
)

it.effect("a local case the helper does not cover is declined", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(singlePath, workspace)
    expect(result.diagnostics).toEqual([])
    expect(result.drops.some((drop) => drop.stage === "declined")).toBe(true)
  }).pipe(
    Effect.provide(modelStub({ verdict: choice("legitimate_local", 0.95) })),
    Effect.provide(NodeServices.layer),
  ),
)
