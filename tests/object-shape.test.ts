import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { everyFile } from "../src/rule.ts"
import { objectShape } from "../src/rules/object-shape.ts"
import { loadWorkspace } from "../src/workspace.ts"
import { modelStub, noConfig } from "./support.ts"

it.effect("a literal that uses a declared type is not a missing type", () =>
  Effect.gen(function* () {
    const workspace = yield* loadWorkspace("tests/fixtures/object-shape", ["."])
    const { diagnostics } = yield* objectShape.run(workspace, everyFile, noConfig)
    const messages = diagnostics.map((diagnostic) => diagnostic.message)
    // { x, y } is a use of Point, whose required keys are x and y and whose label
    // is optional, so the literal is not a shape nobody named.
    expect(messages.some((message) => message.includes("{ x; y }"))).toBe(false)
    // { alpha, beta, gamma } has no declared type anywhere.
    expect(messages.some((message) => message.includes("{ alpha; beta; gamma }"))).toBe(true)
  }).pipe(Effect.provide(modelStub({})), Effect.provide(NodeServices.layer)),
)
