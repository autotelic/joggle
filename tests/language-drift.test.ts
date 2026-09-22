import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { languageDrift } from "../src/rules/language-drift.ts"
import { plannedDiagnosticsOf } from "../src/testing.ts"
import { loadWorkspace } from "../src/workspace.ts"
import { modelStub } from "./support.ts"

/**
 * A capitalized English word mid-sentence is not a domain concept.
 *
 * "None of these values is required" put `None` into the candidate list, the
 * model -- correctly, given the option -- chose it, and the rule reported that
 * the prose says "none" and no declaration uses the word. It also collides with
 * the Choice's own decline option. It is filtered now, before the question.
 */
it.effect("an ordinary English word is not a candidate", () =>
  Effect.gen(function* () {
    const workspace = yield* loadWorkspace("tests/fixtures/language-drift", ["src"])
    const result = yield* plannedDiagnosticsOf(languageDrift, workspace)
    expect(result.diagnostics).toEqual([])
  }).pipe(Effect.provide(modelStub({})), Effect.provide(NodeServices.layer)),
)
