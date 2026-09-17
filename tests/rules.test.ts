import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { duplicateImplementation } from "../src/rules/duplicate-implementation.ts"
import { duplicateMeaning } from "../src/rules/duplicate-meaning.ts"
import { namingDrift } from "../src/rules/naming-drift.ts"
import { everyFile } from "../src/rule.ts"
import { choice, judgeFailing, judgeStub, noul, withWorkspace } from "./support.ts"

const collapse = (canonical: string, confidence = 0.85) => ({
  verdict: choice("collapse", confidence),
  canonical: choice(canonical, 0.8),
  redundant: noul(0.9),
})

it.effect("a cluster of identical declarations is one finding", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* duplicateImplementation.run(workspace, everyFile)).diagnostics
      // One cluster, not two. The fixture's two files each declare their own
      // `User`, so the two functions that take one are NOT the same function:
      // resolved type identity says users.ts#User and orders.ts#User are
      // different types. The old rule called them identical.
      expect(findings.length).toBe(1)
      for (const entry of findings) {
        expect(entry.judged).toBe(true)
        expect(entry.score).toBeCloseTo(0.9)
        expect(entry.message).toContain("is declared 2 times")
        expect(entry.help).toContain("Delete or import instead of redeclaring")
      }
    }).pipe(Effect.provide(judgeStub(collapse("member_0")))),
  ),
)

it.effect("the model picks which member survives", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* duplicateImplementation.run(workspace, everyFile)).diagnostics
      expect(findings.length).toBe(1)
      // member_1 is src/users.ts, so the drop is src/orders.ts.
      for (const entry of findings) expect(entry.location.file).toBe("src/orders.ts")
    }).pipe(Effect.provide(judgeStub(collapse("member_1")))),
  ),
)

it.effect("keep_variants and not_duplication are both silence", () =>
  Effect.all(
    ["keep_variants", "not_duplication"].map((verdict) =>
      withWorkspace((workspace) =>
        Effect.gen(function* () {
          const findings = (yield* duplicateImplementation.run(workspace, everyFile)).diagnostics
          expect(findings.length).toBe(0)
        }).pipe(Effect.provide(judgeStub({ verdict: choice(verdict, 0.9) }))),
      ),
    ),
  ),
)

it.effect("a response without a verdict is unverified, not judged", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* duplicateImplementation.run(workspace, everyFile)).diagnostics
      expect(findings.length).toBe(1)
      for (const entry of findings) {
        expect(entry.judged).toBe(false)
        expect(entry.help).toContain("Not verified")
      }
    }).pipe(Effect.provide(judgeStub({}))),
  ),
)

it.effect("an unavailable judge still reports, unverified", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* duplicateImplementation.run(workspace, everyFile)).diagnostics
      expect(findings.length).toBe(1)
      for (const entry of findings) expect(entry.judged).toBe(false)
    }).pipe(Effect.provide(judgeFailing("TYPESAFE_API_KEY is not set"))),
  ),
)

it.effect("near-duplicates collapse when the cluster is judged one thing", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* duplicateMeaning.run(workspace, everyFile)).diagnostics
      expect(findings.length).toBeGreaterThan(0)
      for (const entry of findings) {
        expect(entry.judged).toBe(true)
        expect(entry.ruleId).toBe("joggle/duplicate-meaning")
      }
    }).pipe(Effect.provide(judgeStub(collapse("member_0", 0.8)))),
  ),
)

it.effect("near-duplicates stay quiet when the cluster is unrelated", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* duplicateMeaning.run(workspace, everyFile)).diagnostics
      expect(findings.length).toBe(0)
    }).pipe(Effect.provide(judgeStub({ verdict: choice("not_duplication", 0.9) }))),
  ),
)

it.effect("naming drift collapses to the spelling the model chose", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* namingDrift.run(workspace, everyFile)).diagnostics
      expect(findings.length).toBeGreaterThan(0)
      // The cluster message names every spelling it is collapsing.
      expect(findings.some((entry) => entry.message.includes("Profile"))).toBe(true)
      for (const entry of findings) expect(entry.judged).toBe(true)
    }).pipe(
      Effect.provide(
        judgeStub({ verdict: choice("same_use_left", 0.85), one_concept: noul(0.9) }),
      ),
    ),
  ),
)

it.effect("two distinct concepts are silence", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* namingDrift.run(workspace, everyFile)).diagnostics
      expect(findings.length).toBe(0)
    }).pipe(
      Effect.provide(
        judgeStub({ verdict: choice("distinct", 0.9), one_concept: noul(0.1) }),
      ),
    ),
  ),
)
