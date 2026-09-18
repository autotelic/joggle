import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { duplicateImplementation } from "../src/rules/duplicate-implementation.ts"
import { duplicateMeaning } from "../src/rules/duplicate-meaning.ts"
import { everyFile, marginOf, qualityOf } from "../src/rule.ts"
import type { Answer } from "../src/schema.ts"
import { judgeStub, noul, withWorkspace } from "./support.ts"

/** A Choice answer with a real distribution, which the shared stub does not carry. */
const spread = (probabilities: Record<string, number>): Answer => ({
  type: "choice",
  choice: Object.entries(probabilities).sort((left, right) => right[1] - left[1])[0]?.[0] ?? "",
  probabilities,
  confidence: 0.5,
})

it("the margin is the gap the model left between two options", () => {
  expect(marginOf({ verdict: spread({ collapse: 0.6, keep_variants: 0.3, no_issue: 0.1 }) }, "verdict")).toBeCloseTo(0.3)
  // One option has nothing to be uncertain between.
  expect(marginOf({ verdict: spread({ collapse: 1 }) }, "verdict")).toBe(1)
  // No distribution means no measurement, and a gate that cannot measure must not fire.
  expect(marginOf({ verdict: noul(0.9) }, "verdict")).toBeUndefined()
  expect(marginOf({}, "verdict")).toBeUndefined()
})

it("a yes/no answer is a verdict, not a ranking", () => {
  const no = qualityOf({ score: 0.2, margin: 0.5 })
  expect(no.usable).toBe(false)
  expect(no.reason).toContain("answered no")

  const yes = qualityOf({ score: 0.9, margin: 0.5 })
  expect(yes.usable).toBe(true)
})

it("a choice that barely won is not a decision", () => {
  const shrugged = qualityOf({ score: 0.9, margin: 0.05 })
  expect(shrugged.usable).toBe(false)
  expect(shrugged.reason).toContain("not decisive")
})

it("an unmeasurable margin does not block a good answer", () => {
  expect(qualityOf({ score: 0.9, margin: undefined }).usable).toBe(true)
})

it.effect("a provable finding degrades to unverified when the model says no", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      // Exact duplicates are a FACT, so this rule reports them either way -- but
      // the reason is now on the finding instead of being overruled by a Choice
      // that said `collapse`.
      const findings = (yield* duplicateImplementation.run(workspace, everyFile)).diagnostics
      expect(findings.length).toBe(1)
      expect(findings[0]?.judged).toBe(false)
      expect(findings[0]?.help).toContain("the yes/no question answered no")
    }).pipe(
      Effect.provide(
        judgeStub({ verdict: spread({ collapse: 1 }), canonical: spread({ member_0: 1 }), redundant: noul(0.2) }),
      ),
    ),
  ),
)

it.effect("a guessed finding disappears when the model says no", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* duplicateMeaning.run(workspace, everyFile)).diagnostics
      expect(findings).toEqual([])
    }).pipe(
      Effect.provide(
        judgeStub({ verdict: spread({ collapse: 1 }), canonical: spread({ member_0: 1 }), redundant: noul(0.1) }),
      ),
    ),
  ),
)

it.effect("a shrug across two options is not a judgement", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = (yield* duplicateMeaning.run(workspace, everyFile)).diagnostics
      expect(findings).toEqual([])
    }).pipe(
      Effect.provide(
        judgeStub({
          verdict: spread({ collapse: 0.45, keep_variants: 0.4 }),
          canonical: spread({ member_0: 1 }),
          redundant: noul(0.9),
        }),
      ),
    ),
  ),
)
