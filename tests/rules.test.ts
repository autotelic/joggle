import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { duplicateImplementation } from "../src/rules/duplicate-implementation.ts"
import { duplicateMeaning } from "../src/rules/duplicate-meaning.ts"
import { namingDrift } from "../src/rules/naming-drift.ts"
import { choice, judgeFailing, judgeStub, noul, withWorkspace } from "./support.ts"

it.effect("deterministic rule reports the duplicate copies only", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* duplicateImplementation.run(workspace)
      expect(findings.length).toBe(2)
      for (const entry of findings) {
        expect(entry.judged).toBe(false)
        expect(entry.confidence).toBeUndefined()
        expect(entry.location.file).toBe("src/users.ts")
      }
      const messages = findings.map((entry) => entry.message).join(" | ")
      expect(messages).toContain("lookupUserById")
      expect(messages).toContain("`User`")
    }).pipe(Effect.provide(judgeStub({}))),
  ),
)

it.effect("judged rule reports a near-duplicate when the policy activates", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* duplicateMeaning.run(workspace)
      expect(findings.length).toBeGreaterThan(0)
      for (const entry of findings) {
        expect(entry.judged).toBe(true)
        expect(entry.ruleId).toBe("joggle/duplicate-meaning")
        expect(entry.confidence).toBeGreaterThanOrEqual(0.7)
      }
    }).pipe(
      Effect.provide(
        judgeStub({
          same_concept: noul(0.95),
          same_behavior: noul(0.9),
          intentional_specialization: noul(0.05),
          merge_changes_behavior: noul(0.1),
          canonical: choice("left", 0.8),
        }),
      ),
    ),
  ),
)

it.effect("judged rule stays quiet when the policy does not activate", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* duplicateMeaning.run(workspace)
      expect(findings.length).toBe(0)
    }).pipe(
      Effect.provide(
        judgeStub({
          same_concept: noul(0.6),
          same_behavior: noul(0.4),
          intentional_specialization: noul(0.1),
          merge_changes_behavior: noul(0.1),
          canonical: choice("left", 0.8),
        }),
      ),
    ),
  ),
)

it.effect("judged rule refuses to merge when behaviour would change", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* duplicateMeaning.run(workspace)
      expect(findings.length).toBe(0)
    }).pipe(
      Effect.provide(
        judgeStub({
          same_concept: noul(0.95),
          same_behavior: noul(0.95),
          intentional_specialization: noul(0.05),
          merge_changes_behavior: noul(0.9),
          canonical: choice("left", 0.8),
        }),
      ),
    ),
  ),
)

it.effect("an unavailable judge surfaces as a typed failure, not silence", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const error = yield* duplicateMeaning.run(workspace).pipe(Effect.flip)
      expect(error._tag).toBe("joggle/JudgeUnavailable")
    }).pipe(Effect.provide(judgeFailing("TYPESAFE_API_KEY is not set"))),
  ),
)

it.effect("naming drift nominates the canonical spelling", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* namingDrift.run(workspace)
      expect(findings.length).toBeGreaterThan(0)
      const profiles = findings.find((entry) => entry.message.includes("Profile"))
      expect(profiles).toBeDefined()
      expect(profiles?.help).toContain("user profile")
    }).pipe(
      Effect.provide(judgeStub({ same_concept: noul(0.9), canonical: choice("left", 0.85) })),
    ),
  ),
)

it.effect("naming drift ignores a concept the judge says is really two", () =>
  withWorkspace((workspace) =>
    Effect.gen(function* () {
      const findings = yield* namingDrift.run(workspace)
      expect(findings.length).toBe(0)
    }).pipe(
      Effect.provide(judgeStub({ same_concept: noul(0.2), canonical: choice("both", 0.9) })),
    ),
  ),
)
