import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { everyFile } from "../src/rule.ts"
import { duplicateCallRun } from "../src/rules/duplicate-call-run.ts"
import { loadWorkspace } from "../src/workspace.ts"
import { modelStub, noConfig } from "./support.ts"

it.effect("a function that inlines a helper's calls is reported", () =>
  Effect.gen(function* () {
    const workspace = yield* loadWorkspace("tests/fixtures/call-run", ["."])
    const { diagnostics } = yield* duplicateCallRun.run(workspace, everyFile, noConfig)
    expect(diagnostics.length).toBe(1)
    expect(diagnostics[0]?.message).toContain("share 4 call(s)")
  }).pipe(Effect.provide(modelStub({})), Effect.provide(NodeServices.layer)),
)
