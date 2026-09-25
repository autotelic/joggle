import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { fieldTypeDrift } from "../src/rules/field-type-drift.ts"
import { plannedDiagnosticsOf } from "../src/testing.ts"
import { loadWorkspace } from "../src/workspace.ts"
import { choice, modelStub } from "./support.ts"

/**
 * The fact is a field name declared two ways; the question is what the
 * disagreement means. The generator used to decide that itself -- resolving an
 * indexed access, skipping a raw mirror, testing compatibility with a word
 * subset -- which is meaning decided in code (docs/rule-coupling.md). Now every
 * differing declaration is a candidate and the model settles it.
 */
const drift = { verdict: choice("drift", 0.95) }

it.effect("a field declared two ways is a candidate, and the model decides", () =>
  Effect.gen(function* () {
    const workspace = yield* loadWorkspace("tests/fixtures/field-type-drift", ["src"])
    const result = yield* plannedDiagnosticsOf(fieldTypeDrift, workspace)
    const fields = result.diagnostics.map((entry) => entry.message)
    expect(fields.some((message) => message.includes("totalScore"))).toBe(true)
    expect(fields.some((message) => message.includes("ownerId"))).toBe(true)
  }).pipe(Effect.provide(modelStub(drift)), Effect.provide(NodeServices.layer)),
)

it.effect("drift across two packages with no import path is not a candidate", () =>
  Effect.gen(function* () {
    const workspace = yield* loadWorkspace("tests/fixtures/field-type-drift", ["packages"])
    const result = yield* plannedDiagnosticsOf(fieldTypeDrift, workspace)
    const messages = result.diagnostics.map((entry) => entry.message)
    expect(messages.some((message) => message.includes("totalScore") && message.includes("OneOther"))).toBe(true)
    expect(messages.some((message) => message.includes("crossScore"))).toBe(false)
  }).pipe(Effect.provide(modelStub(drift)), Effect.provide(NodeServices.layer)),
)

it.effect("a disagreement the model reads as deliberate is dropped, not reported", () =>
  Effect.gen(function* () {
    const workspace = yield* loadWorkspace("tests/fixtures/field-type-drift", ["src"])
    const result = yield* plannedDiagnosticsOf(fieldTypeDrift, workspace)
    expect(result.diagnostics).toEqual([])
    expect(result.drops.some((drop) => drop.reason.includes("deliberate"))).toBe(true)
  }).pipe(
    Effect.provide(modelStub({ verdict: choice("compatible", 0.95) })),
    Effect.provide(NodeServices.layer),
  ),
)
