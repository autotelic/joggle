import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { typesOverLogic } from "../src/rules/types-over-logic.ts"
import { plannedDiagnosticsOf } from "../src/testing.ts"
import { loadWorkspace } from "../src/workspace.ts"
import { choice, modelStub } from "./support.ts"

const fixture = () => loadWorkspace("tests/fixtures/types-over-logic", ["src"])

it.effect("a guard the model reads as a type's job is reported", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(typesOverLogic, workspace)
    // Two guards on wide types: `email: string` and `raw: unknown`. The stub
    // reads both as a type's job, so both are findings; the question is what
    // separates them in a real run.
    expect(result.diagnostics.length).toBe(2)
    expect(result.diagnostics.some((entry) => entry.message.includes("email"))).toBe(true)
    expect(result.diagnostics.every((entry) => entry.message.includes("a check a type could carry"))).toBe(true)
  }).pipe(
    Effect.provide(modelStub({ verdict: choice("type_should_carry_it", 0.95) })),
    Effect.provide(NodeServices.layer),
  ),
)

it.effect("a guard the model reads as the boundary is dropped", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(typesOverLogic, workspace)
    expect(result.diagnostics).toEqual([])
    expect(result.drops.some((drop) => drop.reason.includes("parse boundary"))).toBe(true)
  }).pipe(
    Effect.provide(modelStub({ verdict: choice("boundary_check", 0.95) })),
    Effect.provide(NodeServices.layer),
  ),
)
