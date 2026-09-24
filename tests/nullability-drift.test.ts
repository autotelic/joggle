import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { nullabilityDrift } from "../src/rules/nullability-drift.ts"
import { diagnosticsOf } from "../src/testing.ts"
import { loadWorkspace } from "../src/workspace.ts"

/**
 * One column, two nullabilities, across the artifact boundary no linter reaches.
 *
 * The migration leaves `payroll_crew.shakti_user_id` nullable; the row contract
 * requires it. The mapping is an annotation (`sourceColumn`), because the field
 * is called `personId` and no name convention turns one into the other.
 */
it.effect("a column nullable in the migration and required in the schema", () =>
  Effect.gen(function* () {
    const workspace = yield* loadWorkspace("tests/fixtures/nullability-drift", ["src"])
    const diagnostics = yield* diagnosticsOf(nullabilityDrift, workspace)
    expect(diagnostics.length).toBe(1)
    const found = diagnostics[0]!
    expect(found.message).toContain("payroll_crew.shakti_user_id")
    expect(found.message).toContain("nullable in the migration")
    expect(found.message).toContain("required in the schema")
    expect(found.message).toContain("personId")
  }).pipe(Effect.provide(NodeServices.layer)),
)
