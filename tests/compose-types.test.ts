import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { composeTypes } from "../src/rules/compose-types.ts"
import { plannedDiagnosticsOf } from "../src/testing.ts"
import { loadWorkspace } from "../src/workspace.ts"
import { choice, modelStub } from "./support.ts"

/**
 * The containment is a fact; whether B is genuinely an A is the question.
 */
const fixture = () => loadWorkspace("tests/fixtures/compose-types", ["src"])

it.effect("a containment the model reads as composition is a finding", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(composeTypes, workspace)
    expect(result.diagnostics.length).toBe(2)
    expect(result.diagnostics.some((entry) => entry.message.includes("lists all"))).toBe(true)
    expect(result.diagnostics.every((entry) => entry.judged)).toBe(true)
  }).pipe(
    Effect.provide(modelStub({ verdict: choice("composes", 0.95) })),
    Effect.provide(NodeServices.layer),
  ),
)

it.effect("a containment the model reads as coincidence is dropped, not reported", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(composeTypes, workspace)
    expect(result.diagnostics).toEqual([])
    expect(result.drops.some((drop) => drop.reason.includes("coincidence"))).toBe(true)
  }).pipe(
    Effect.provide(modelStub({ verdict: choice("independent", 0.95) })),
    Effect.provide(NodeServices.layer),
  ),
)
