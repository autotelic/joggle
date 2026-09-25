import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { objectShape } from "../src/rules/object-shape.ts"
import { plannedDiagnosticsOf } from "../src/testing.ts"
import { loadWorkspace } from "../src/workspace.ts"
import { choice, modelStub } from "./support.ts"

/**
 * The deterministic half finds the shape; the judged half decides what it is.
 *
 * A repeated key set is a fact. Whether that shape is one concept that deserves a
 * name, or two concepts that happen to share field names, is the question.
 */
const fixture = () => loadWorkspace("tests/fixtures/object-shape", ["."])

const oneConcept = { verdict: choice("one_concept", 0.95) }

it.effect("a repeated shape the model reads as one concept is a finding", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(objectShape, workspace)
    const messages = result.diagnostics.map((diagnostic) => diagnostic.message)
    // { alpha, beta, gamma } appears in other.ts and third.ts and no type names it.
    expect(messages.some((message) => message.includes("{ alpha; beta; gamma }"))).toBe(true)
    // A literal that uses a declared type is not a missing type: { x; y } is a use
    // of Point, { label; x; y } is a use of Labelled (Base plus its own field,
    // resolved across `extends`), and { admin; member; viewer } is named by an
    // annotation, a `satisfies` and a cast.
    expect(messages.some((message) => message.includes("{ x; y }"))).toBe(false)
    expect(messages.some((message) => message.includes("{ label; x; y }"))).toBe(false)
    expect(messages.some((message) => message.includes("{ admin; member; viewer }"))).toBe(false)
    expect(result.diagnostics.every((entry) => entry.judged)).toBe(true)
    // A decisive answer is the rule's own claim, so it is a warning; the band a
    // shrug lands in is a notice.
    expect(result.diagnostics.every((entry) => entry.severity === "warn")).toBe(true)
  }).pipe(Effect.provide(modelStub(oneConcept)), Effect.provide(NodeServices.layer)),
)

it.effect("a shape the model reads as coincidental is dropped, not reported", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(objectShape, workspace)
    expect(result.diagnostics).toEqual([])
    expect(result.drops.some((drop) => drop.reason.includes("different concepts"))).toBe(true)
  }).pipe(
    Effect.provide(modelStub({ verdict: choice("coincidental", 0.95) })),
    Effect.provide(NodeServices.layer),
  ),
)

it.effect("a non-decisive answer is a notice, not withheld", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const result = yield* plannedDiagnosticsOf(objectShape, workspace)
    // Score above the probability floor, margin below minMargin: a real answer the
    // model is unsure of. A band is not a reason to discard it, so it is reported
    // at notice severity rather than dropped.
    expect(result.diagnostics.length).toBe(1)
    expect(result.diagnostics[0]?.severity).toBe("info")
    expect(result.drops.some((drop) => drop.reason.startsWith("flagged:"))).toBe(false)
  }).pipe(
    Effect.provide(
      modelStub({
        verdict: {
          type: "choice",
          choice: "one_concept",
          probabilities: { one_concept: 0.6, coincidental: 0.4, already_named: 0 },
          confidence: 0.9,
        },
      }),
    ),
    Effect.provide(NodeServices.layer),
  ),
)
