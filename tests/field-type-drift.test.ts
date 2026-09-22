import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { fieldTypeDrift } from "../src/rules/field-type-drift.ts"
import { diagnosticsOf } from "../src/testing.ts"
import { loadWorkspace } from "../src/workspace.ts"

/**
 * Two types that only read differently are not drift.
 *
 * `PersonPayrollRecord["personId"]` and `PersonId` are one type, and the rule
 * reported them as two because it compared the written text. And a raw mirror
 * (`UnparsedPlanterDay.treesPlanted: number`) is SUPPOSED to be unbranded, so
 * comparing it with the domain's `Count` is the parser working.
 */
it.effect("resolves an indexed access, and leaves a raw mirror alone", () =>
  Effect.gen(function* () {
    const workspace = yield* loadWorkspace("tests/fixtures/field-type-drift", ["src"])
    const diagnostics = yield* diagnosticsOf(fieldTypeDrift, workspace)
    const fields = diagnostics.map((entry) => entry.message)
    // The indexed access resolves to PersonId, so it is not drift.
    expect(fields.some((message) => message.includes("personId"))).toBe(false)
    // The raw mirror is not drift either.
    expect(fields.some((message) => message.includes("treesPlanted"))).toBe(false)
    // The genuine disagreement still is.
    expect(fields.some((message) => message.includes("totalScore"))).toBe(true)
  }).pipe(Effect.provide(NodeServices.layer)),
)
