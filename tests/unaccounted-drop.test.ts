import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { unaccountedDrop } from "../src/rules/unaccounted-drop.ts"
import { plannedDiagnosticsOf } from "../src/testing.ts"
import { loadWorkspace } from "../src/workspace.ts"
import { choice, modelStub } from "./support.ts"

/**
 * Two facts: an exported function, and a `continue` inside it. Nothing decides
 * whether the function is an "adapter" or whether it "accounts" -- the same rule
 * reads any repository.
 */
const fixture = () => loadWorkspace("tests/fixtures/unaccounted-drop", ["src"])

it.effect("an exported path that skips items is a candidate", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(unaccountedDrop, workspace)
    expect(result.diagnostics.length).toBe(1)
    expect(result.diagnostics[0]?.message).toContain("adaptRows")
    expect(result.diagnostics[0]?.move).toBeUndefined()
  }).pipe(
    Effect.provide(modelStub({ verdict: choice("unaccounted", 0.95) })),
    Effect.provide(NodeServices.layer),
  ),
)

it.effect("a skip the caller does not need to see is declined", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(unaccountedDrop, workspace)
    expect(result.diagnostics).toEqual([])
    expect(result.drops.some((drop) => drop.stage === "declined")).toBe(true)
  }).pipe(
    Effect.provide(modelStub({ verdict: choice("internal_only", 0.95) })),
    Effect.provide(NodeServices.layer),
  ),
)
