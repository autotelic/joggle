import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { everyFile } from "../src/rule.ts"
import { bundleRules } from "../src/rules/bundle-conformance.ts"
import { loadWorkspace } from "../src/workspace.ts"
import { modelStub, noConfig } from "./support.ts"

/** Run every producer rule over one fixture directory, keyed by rule id. */
const runAll = (root: string) =>
  Effect.gen(function* () {
    const workspace = yield* loadWorkspace(root, ["."])
    const byRule = new Map<string, ReadonlyArray<string>>()
    for (const rule of bundleRules) {
      const { diagnostics } = yield* rule.run(workspace, everyFile, noConfig)
      byRule.set(rule.id, diagnostics.map((entry) => entry.help ?? entry.message))
    }
    return byRule
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(modelStub({})))

it.effect("a bundle that follows the pattern produces nothing", () =>
  Effect.gen(function* () {
    const byRule = yield* runAll("tests/fixtures/bundle/good")
    for (const [id, found] of byRule) {
      expect(id + ": " + found.length).toBe(id + ": 0")
    }
  }),
)

it.effect("each deviation is reported by its own rule", () =>
  Effect.gen(function* () {
    const byRule = yield* runAll("tests/fixtures/bundle/bad")
    expect(byRule.get("joggle/bundle-dot-notation")?.length).toBe(1)
    expect(byRule.get("joggle/bundle-tripartite-value")?.length).toBe(1)
    expect(byRule.get("joggle/bundle-one-file-per-block")?.length).toBe(1)
    expect(byRule.get("joggle/bundle-context-hook")?.length).toBe(1)
    // And each one names the specific thing that is wrong, not just the bundle.
    expect(byRule.get("joggle/bundle-context-hook")?.[0]).toContain("useContext")
    expect(byRule.get("joggle/bundle-tripartite-value")?.[0]).toContain("meta")
    expect(byRule.get("joggle/bundle-one-file-per-block")?.[0]).toContain("one per file")
  }),
)
