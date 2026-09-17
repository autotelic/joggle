import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { duplicateImplementation } from "../src/rules/duplicate-implementation.ts"
import { duplicateMeaning } from "../src/rules/duplicate-meaning.ts"
import { namingDrift } from "../src/rules/naming-drift.ts"
import { choice, judgeFailing, judgeStub, withWorkspace } from "./support.ts"

it.effect("one declaration, two files, is reported with a judgement", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* duplicateImplementation.run(workspace)
      expect(findings.length).toBe(2)
      for (const entry of findings) {
        expect(entry.judged).toBe(true)
        expect(entry.confidence).toBeCloseTo(0.85)
      }
      const messages = findings.map((entry) => entry.message).join(" | ")
      expect(messages).toContain("redundant copy")
      expect(messages).toContain("User")
    }).pipe(
      Effect.provide(
        judgeStub({ verdict: choice("keep_left", 0.85) }),
      ),
    ),
  ),
)

it.effect("the model may keep both, and that is the only veto", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* duplicateImplementation.run(workspace)
      expect(findings.length).toBe(0)
    }).pipe(Effect.provide(judgeStub({ verdict: choice("keep_both", 0.9) }))),
  ),
)

it.effect("keep_right flips which declaration is reported", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* duplicateImplementation.run(workspace)
      expect(findings.length).toBe(2)
      for (const entry of findings) expect(entry.location.file).toBe("src/orders.ts")
    }).pipe(Effect.provide(judgeStub({ verdict: choice("keep_right", 0.7) }))),
  ),
)

it.effect("no verdict means unverified, never judged", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* duplicateImplementation.run(workspace)
      expect(findings.length).toBe(2)
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
      const findings = yield* duplicateImplementation.run(workspace)
      expect(findings.length).toBe(2)
      for (const entry of findings) expect(entry.judged).toBe(false)
    }).pipe(Effect.provide(judgeFailing("TYPESAFE_API_KEY is not set"))),
  ),
)

it.effect("a near-duplicate reported as one concept is a finding", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* duplicateMeaning.run(workspace)
      expect(findings.length).toBeGreaterThan(0)
      for (const entry of findings) expect(entry.judged).toBe(true)
    }).pipe(Effect.provide(judgeStub({ verdict: choice("same_keep_left", 0.8) }))),
  ),
)

it.effect("a near-duplicate reported as unrelated is silence", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* duplicateMeaning.run(workspace)
      expect(findings.length).toBe(0)
    }).pipe(Effect.provide(judgeStub({ verdict: choice("unrelated", 0.8) }))),
  ),
)

it.effect("a deliberate refinement keeps both", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* duplicateMeaning.run(workspace)
      expect(findings.length).toBe(0)
    }).pipe(Effect.provide(judgeStub({ verdict: choice("related_keep_both", 0.8) }))),
  ),
)

it.effect("two spellings of one concept are reported", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* namingDrift.run(workspace)
      expect(findings.length).toBeGreaterThan(0)
      const profiles = findings.find((entry) => entry.message.includes("Profile"))
      expect(profiles).toBeDefined()
      expect(profiles?.help).toContain("user profile")
    }).pipe(Effect.provide(judgeStub({ verdict: choice("same_use_left", 0.85) }))),
  ),
)

it.effect("two different concepts are silence", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* namingDrift.run(workspace)
      expect(findings.length).toBe(0)
    }).pipe(Effect.provide(judgeStub({ verdict: choice("distinct", 0.9) }))),
  ),
)
