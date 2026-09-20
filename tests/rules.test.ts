import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { duplicateImplementation } from "../src/rules/duplicate-implementation.ts"
import { duplicateMeaning } from "../src/rules/duplicate-meaning.ts"
import { namingDrift, worthJudging } from "../src/rules/naming-drift.ts"
import { everyFile } from "../src/rule.ts"
import { choice, judgeFailing, judgeStub, noul, withWorkspace, noConfig } from "./support.ts"

const collapse = (canonical: string, confidence = 0.85) => ({
  verdict: choice("collapse", confidence),
  canonical: choice(canonical, 0.8),
  redundant: noul(0.9),
})

it.effect("the report sorts by consequence, not by redundancy", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* duplicateImplementation.run(workspace, everyFile, noConfig)).diagnostics
      expect(findings.length).toBe(1)
      // Redundancy 0.9 gates it in; consequence 0.1 ranks it last. Both facts
      // survive, and they are different facts: this IS duplication, and it does
      // NOT matter. Before this, the report sorted by the first one, which is
      // how a spec re-implementing the function it tests ended up last.
      expect(findings[0]?.score).toBeCloseTo(0.1)
      expect(findings[0]?.judged).toBe(true)
    }).pipe(
      Effect.provide(
        judgeStub({
          verdict: choice("collapse", 0.9),
          canonical: choice("member_0", 0.8),
          redundant: noul(0.9),
          consequence: noul(0.1),
        }),
      ),
    ),
  ),
)

it.effect("a cluster of identical declarations is one finding", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* duplicateImplementation.run(workspace, everyFile, noConfig)).diagnostics
      // One cluster, not two. The fixture's two files each declare their own
      // `User`, so the two functions that take one are NOT the same function:
      // resolved type identity says users.ts#User and orders.ts#User are
      // different types. The old rule called them identical.
      expect(findings.length).toBe(1)
      for (const entry of findings) {
        expect(entry.judged).toBe(true)
        expect(entry.score).toBeCloseTo(0.9)
        expect(entry.message).toContain("is declared 2 times")
        // The model answers role and relationship, so the prescription is the
        // model's. The declared-layers fallback is only for a repository whose
        // judgement did not include them.
        expect(entry.help).toContain("Delete the copies and import one")
      }
    }).pipe(Effect.provide(judgeStub(collapse("member_0")))),
  ),
)

it.effect("the model picks which member survives", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* duplicateImplementation.run(workspace, everyFile, noConfig)).diagnostics
      expect(findings.length).toBe(1)
      // member_1 is src/users.ts, so the drop is src/orders.ts.
      for (const entry of findings) expect(entry.location.file).toBe("src/orders.ts")
    }).pipe(Effect.provide(judgeStub(collapse("member_1")))),
  ),
)

it.effect("keep_variants and no_issue are both silence", () =>
  Effect.all(
    ["keep_variants", "no_issue"].map((verdict) =>
      withWorkspace((workspace) =>
        Effect.gen(function* () {
          const findings = (yield* duplicateImplementation.run(workspace, everyFile, noConfig)).diagnostics
          expect(findings.length).toBe(0)
        }).pipe(Effect.provide(judgeStub({ verdict: choice(verdict, 0.9) }))),
      ),
    ),
  ),
)

it.effect("a response without a verdict is unverified, not judged", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* duplicateImplementation.run(workspace, everyFile, noConfig)).diagnostics
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
      const findings = (yield* duplicateImplementation.run(workspace, everyFile, noConfig)).diagnostics
      expect(findings.length).toBe(1)
      for (const entry of findings) expect(entry.judged).toBe(false)
    }).pipe(Effect.provide(judgeFailing("TYPESAFE_API_KEY is not set"))),
  ),
)

it.effect("near-duplicates collapse when the cluster is judged one thing", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* duplicateMeaning.run(workspace, everyFile, noConfig)).diagnostics
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
      const findings = (yield* duplicateMeaning.run(workspace, everyFile, noConfig)).diagnostics
      expect(findings.length).toBe(0)
    }).pipe(Effect.provide(judgeStub({ verdict: choice("no_issue", 0.9) }))),
  ),
)

it.effect("naming drift collapses to the spelling the model chose", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* namingDrift.run(workspace, everyFile, noConfig)).diagnostics
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

it("a filter that admits near-misses pays to be told it was close", () => {
  // The pair that made up a whole repository's 87 candidates, all declined with
  // `one_concept` between 0.37 and 0.44: the extra word changes what the function
  // DOES, so these are two operations that share a tail.
  expect(
    worthJudging("convertUtcDateToFormattedLocalizedDateTime", "convertUtcDateToLocalizedDateTime"),
  ).toBe(false)
  // And a word that adds nothing is not a difference at all.
  expect(worthJudging("getUserProfile", "userProfile")).toBe(true)
  expect(worthJudging("calculateOrderTotal", "orderTotal")).toBe(true)
  // Identical words, different spelling: the rule's best bucket.
  expect(worthJudging("userId", "userIdentifier")).toBe(true)
  // A name against itself is not a pair.
  expect(worthJudging("parsePrice", "parsePrice")).toBe(false)
})

it.effect("two distinct concepts are silence", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* namingDrift.run(workspace, everyFile, noConfig)).diagnostics
      expect(findings.length).toBe(0)
    }).pipe(
      Effect.provide(
        judgeStub({ verdict: choice("no_issue", 0.9), one_concept: noul(0.1) }),
      ),
    ),
  ),
)
