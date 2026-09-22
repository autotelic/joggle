import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import { NodeServices } from "@effect/platform-node"
import { importCycle } from "../src/rules/import-architecture.ts"
import { everyFile } from "../src/rule.ts"
import type { WorkspaceError } from "../src/schema.ts"
import { loadWorkspace } from "../src/workspace.ts"

/**
 * A cycle is only this run's business when one of its members moved.
 *
 * A PR-scoped run on a real repository reported all eight of the repository's
 * cycles while saying it had narrowed to the changed files: a~b is a cycle, so
 * neither file is "outside" the other, and the rule ignored the scope entirely.
 */
it.effect("a scoped run reports only cycles a changed file participates in", () =>
  Effect.gen(function* () {
    const workspace = yield* loadWorkspace("tests/fixtures/cycles", ["src"])

    const all = yield* importCycle.run(workspace, everyFile, { config: {} })
    expect(all.diagnostics.length).toBe(1)

    const inside = yield* importCycle.run(workspace, { changed: new Set(["src/b.ts"]) }, { config: {} })
    expect(inside.diagnostics.length).toBe(1)
    expect(inside.diagnostics[0]?.location.file).toBe("src/b.ts")

    const outside = yield* importCycle.run(
      workspace,
      { changed: new Set(["src/untouched.ts"]) },
      { config: {} },
    )
    expect(outside.diagnostics.length).toBe(0)
    expect(outside.notes.join(" ")).toContain("outside the scope of this run")
  }).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<void, AiError.AiError | WorkspaceError, never>,
)
