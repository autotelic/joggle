import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { dataErrorAsOutage } from "../src/rules/data-error-as-outage.ts"
import { plannedDiagnosticsOf } from "../src/testing.ts"
import { loadWorkspace } from "../src/workspace.ts"
import { choice, modelFailing, modelStub } from "./support.ts"

/**
 * The deterministic half finds the handler; the judged half says whether the
 * absent row is normal.
 *
 * The candidate is a lookup's result guarded for absence with a 5xx inside the
 * guard -- all syntax. Whether an empty row here is a normal outcome (a 404) or a
 * broken invariant (an honest 500) is meaning, and the model answers it.
 */
const fixture = () => loadWorkspace("tests/fixtures/data-error", ["src"])

const normal: ReturnType<typeof choice> = choice("row_absence_is_normal", 0.95)

it.effect("a 5xx guarded by a lookup's absence is a candidate, and the model reports it", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(dataErrorAsOutage, workspace)
    // Three candidates: the `!row`/`code(500)` guard, the `=== null`/
    // `statusCode = 503` guard, and the `try`/`catch` around a decode. The 404
    // and the unguarded lookup are not.
    expect(result.diagnostics.length).toBe(3)
    const messages = result.diagnostics.map((entry) => entry.message).join("\n")
    expect(messages).toContain("getProject")
    expect(messages).toContain("500")
    expect(messages).toContain("getCrew")
    expect(messages).toContain("503")
    expect(messages).toContain("getReview")
    expect(messages).toContain("row read")
    expect(messages).not.toContain("getProjectOk")
    expect(messages).not.toContain("listProjects")
    expect(result.diagnostics.every((entry) => entry.judged)).toBe(true)
  }).pipe(Effect.provide(modelStub({ verdict: normal })), Effect.provide(NodeServices.layer)),
)

it.effect("a 5xx the model reads as a broken invariant is dropped, not reported", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(dataErrorAsOutage, workspace)
    expect(result.diagnostics).toEqual([])
    expect(result.drops.some((drop) => drop.reason.includes("broken invariant"))).toBe(true)
  }).pipe(
    Effect.provide(modelStub({ verdict: choice("row_absence_is_an_error", 0.95) })),
    Effect.provide(NodeServices.layer),
  ),
)

it.effect("without a model the candidate surfaces unverified, not silently", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(dataErrorAsOutage, workspace)
    expect(result.diagnostics.length).toBe(3)
    expect(result.diagnostics.every((entry) => !entry.judged)).toBe(true)
    expect(result.diagnostics[0]?.help).toContain("Not verified")
  }).pipe(Effect.provide(modelFailing("the model was unreachable")), Effect.provide(NodeServices.layer)),
)
