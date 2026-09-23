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
    // Two types computed from different consts cannot be compared as text.
    expect(fields.some((message) => message.includes("teamRole"))).toBe(false)
    // The genuine disagreement still is.
    expect(fields.some((message) => message.includes("totalScore"))).toBe(true)
  }).pipe(Effect.provide(NodeServices.layer)),
)

/**
 * A shared field name is a hazard only when a value can move between the two
 * declarations. Two packages that cannot reach each other share a word by
 * coincidence, and reporting it is how the rule told a UI constants module and
 * the domain wire vocabulary to reconcile.
 */
it.effect("drift across two packages with no import path is not reported", () =>
  Effect.gen(function* () {
    const workspace = yield* loadWorkspace("tests/fixtures/field-type-drift", ["packages"])
    const diagnostics = yield* diagnosticsOf(fieldTypeDrift, workspace)
    const messages = diagnostics.map((entry) => entry.message)
    // `One` and `OneOther` are one package: the finding stands.
    expect(messages.some((message) => message.includes("totalScore") && message.includes("OneOther"))).toBe(true)
    // `crossScore` only exists on `One` and `Two`, in packages with no path
    // between them, so the shared name is a coincidence and it is skipped.
    expect(messages.some((message) => message.includes("crossScore"))).toBe(false)
  }).pipe(Effect.provide(NodeServices.layer)),
)
