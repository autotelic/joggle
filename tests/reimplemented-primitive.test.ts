import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { reimplementedPrimitive } from "../src/rules/reimplemented-primitive.ts"
import { diagnosticsOf } from "../src/testing.ts"
import { loadWorkspace } from "../src/workspace.ts"
import { NodeServices } from "@effect/platform-node"

it.effect("a function that inlines an existing primitive says which call to make", () =>
  Effect.gen(function* () {
    const workspace = yield* loadWorkspace("tests/fixtures/reimplemented", ["src"])
    const diagnostics = yield* diagnosticsOf(reimplementedPrimitive, workspace)
    expect(diagnostics.length).toBe(1)
    const found = diagnostics[0]!
    // The primitive is named, and it is the one whose whole body is the run.
    expect(found.message).toContain("cleanRow")
    expect(found.message).toContain("cleanInline")
    // Two functions with the same callee names but different INPUTS are not
    // re-implementations of each other. Keying the body on names alone reported
    // exactly this pair.
    expect(diagnostics.some((entry) => entry.message.includes("Ownership"))).toBe(false)
    // The operation is replace, because the call sequences are identical: a fact,
    // not a judgement.
    expect(found.repair?.operation).toBe("replace")
    expect(found.repair?.keep?.file).toBe("src/helper.ts")
    expect(found.repair?.settled).toContain("fact")
    // The cascade: replace the run, and add the import.
    expect(found.repair?.cascade.length).toBe(2)
    expect(found.repair?.cascade[0]?.instruction).toContain("replace these 3 call(s)")
    expect(found.repair?.cascade[0]?.instruction).toContain("cleanRow")
    expect(found.repair?.cascade[1]?.instruction).toContain("import")
    // The run starts where the first inlined call is.
    expect(found.repair?.cascade[0]?.file).toBe("src/inline.ts")
  }).pipe(Effect.provide(NodeServices.layer)),
)
