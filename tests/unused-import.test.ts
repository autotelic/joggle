import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { unusedImport } from "../src/rules/unused-import.ts"
import { diagnosticsOf } from "../src/testing.ts"
import { loadWorkspace } from "../src/workspace.ts"

const fixture = () => loadWorkspace("tests/fixtures/unused-import", ["src"])

it.effect("a name imported and never mentioned again is a finding", () =>
  Effect.gen(function* () {
    const workspace = yield* fixture()
    const diagnostics = yield* diagnosticsOf(unusedImport, workspace)
    expect(diagnostics.length).toBe(1)
    expect(diagnostics[0]?.message).toContain("spare")
    expect(diagnostics[0]?.ruleId).toBe("joggle/unused-import")
  }).pipe(Effect.provide(NodeServices.layer)),
)
