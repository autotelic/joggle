import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { inferredOverRecorded } from "../src/rules/inferred-over-recorded.ts"
import { plannedDiagnosticsOf } from "../src/testing.ts"
import { loadWorkspace } from "../src/workspace.ts"
import { choice, modelStub } from "./support.ts"

/**
 * Three facts: the checker's type at the returned expression (the node-type
 * layer), a type the unit names, and a boolean field on it that the unit does not
 * read. Whether the computation reconstructs the recorded field is the question.
 */
const fixture = () => loadWorkspace("tests/fixtures/inferred-over-recorded", ["src"])

// A stub for the node-type layer: the fixture's one return is a boolean.
const nodeTypes = () => "boolean"

it.effect("a derived boolean beside a recorded one is a candidate", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(inferredOverRecorded, workspace, { config: {}, nodeTypes })
    expect(result.diagnostics.length).toBe(1)
    expect(result.diagnostics[0]?.message).toContain("useSwaDayRate")
    expect(result.diagnostics[0]?.move).toBe("contract")
  }).pipe(
    Effect.provide(modelStub({ verdict: choice("inferred", 0.95) })),
    Effect.provide(NodeServices.layer),
  ),
)

it.effect("without the node-type layer the rule says so", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(inferredOverRecorded, workspace)
    expect(result.diagnostics).toEqual([])
    expect(result.notes.join(" ")).toContain("--types")
  }).pipe(
    Effect.provide(modelStub({ verdict: choice("inferred", 0.95) })),
    Effect.provide(NodeServices.layer),
  ),
)
