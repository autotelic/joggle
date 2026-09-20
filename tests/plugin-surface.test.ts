import { expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import { Decision, DecisionModel } from "effect/unstable/ai"
import * as plugin from "../src/plugin.ts"
import { answeringJudge, diagnosticsOf } from "../src/testing.ts"
import { composeTypes } from "../src/rules/compose-types.ts"
import { loadWorkspace } from "../src/workspace.ts"
import { choice } from "./support.ts"

/**
 * The published surface, pinned.
 *
 * A rule author depends on these names. Removing or renaming one is a breaking
 * change for every opinion anyone has written, and it is the kind of break that
 * happens by accident during a refactor -- so the list is asserted rather than
 * remembered.
 */
const SURFACE = [
  // writing a rule
  "defineRule",
  "finding",
  "outcome",
  "budgetNote",
  // reading answers, and deciding in code
  "marginOfAnswer",
  "qualityOf",
  "declined",
  "decline",
  "declineNames",
  // the code under analysis
  "loadWorkspace",
  "makeCluster",
  "components",
  // shape helpers
  "policy",
  "layersFrom",
  "layerOf",
  "canImport",
  "sharedLayerFor",
  "assessClusters",
  "collapseQuestionnaire",
  // and the thing every rule's run returns
  "Effect",
] as const

test("the authoring surface exports what a rule needs", () => {
  const missing = SURFACE.filter((name) => (plugin as Record<string, unknown>)[name] === undefined)
  expect(missing).toEqual([])
})

test("a rule can be written against the surface and run by the tester", async () => {
  // A structural rule needs no model and no answers, which is the point: most
  // opinions are free and the API makes the free path the easy one.
  const diagnostics = await Effect.runPromise(
    Effect.gen(function* () {
      const workspace = yield* loadWorkspace("tests/fixtures/layers", ["."])
      return yield* diagnosticsOf(composeTypes, workspace)
    }).pipe(Effect.provide(NodeServices.layer)),
  )
  expect(Array.isArray(diagnostics)).toBe(true)
})

test("the tester can answer for a judged rule", async () => {
  const judge = answeringJudge({ answer: choice("x", 0.9) })
  const answer = await Effect.runPromise(
    Effect.gen(function* () {
      const model = yield* DecisionModel.DecisionModel
      const definition = Decision.make({
        input: Schema.Struct({}),
        decisions: {
          answer: Decision.classify({ instructions: "?", criteria: { x: "yes", y: "no" } }),
        },
      })
      const result = yield* model.decide(definition, { input: {} })
      return result.answers.answer.label
    }).pipe(Effect.provide(judge)),
  )
  expect(answer).toBe("x")
})
