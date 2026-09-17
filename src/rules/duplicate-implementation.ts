import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { Service as Judge, type JudgeResult } from "../judge.ts"
import { choiceOf, defineRule, finding } from "../rule.ts"
import type { Answer, Diagnostic, Question } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/duplicate-implementation"

interface Candidate {
  /** The declaration kept if this collapses: the first by path. */
  readonly canonical: Unit
  /** The identical declaration reported at its own span. */
  readonly duplicate: Unit
}

/** Broad on purpose. Over-production is the judge's problem; a missed pair is not. */
const find = (workspace: Workspace): ReadonlyArray<Candidate> => {
  const groups = new Map<string, Array<Unit>>()
  for (const unit of workspace.units) {
    const key = `${unit.kind}:${unit.shapeHash}`
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, [unit])
    else existing.push(unit)
  }

  const candidates: Array<Candidate> = []
  for (const group of groups.values()) {
    if (new Set(group.map((unit) => unit.file)).size < 2) continue
    const ordered = [...group].sort((a, b) =>
      a.file === b.file ? a.start - b.start : a.file < b.file ? -1 : 1,
    )
    const canonical = ordered[0]
    if (canonical === undefined) continue
    for (const unit of ordered.slice(1)) {
      if (unit.file === canonical.file) continue
      candidates.push({ canonical, duplicate: unit })
    }
  }
  return candidates
}

/**
 * One question, three options, and no threshold on the answer.
 *
 * TypeSafe's guidance is that when the only thing you want is the best option,
 * you read `choice` rather than comparing a number to a floor. Confidence is
 * carried onto the finding so a reader or a CI gate can route on it; it is
 * never used here to overrule the model.
 */
const questions = {
  verdict: {
    type: "choice",
    instructions: {
      question: "Should one of these two declarations go away?",
      compare: ["`left.source`", "`right.source`"],
      focus:
        "`left.source` and `right.source` are syntactically identical, including property names and types. Decide whether that is redundancy or two things that only look alike.",
      location: "`left.path` and `right.path` say where each one lives.",
    },
    criteria: {
      keep_left:
        "`right` is a redundant copy of `left`. Keep `left`, import it where `right` was used, and delete `right`.",
      keep_right:
        "`left` is a redundant copy of `right`. Keep `right`, import it where `left` was used, and delete `left`.",
      keep_both:
        "The repetition is intentional. The two belong to different concerns and are expected to diverge.",
    },
  },
} satisfies Record<string, Question>

const kindOf = (unit: Unit): string => (unit.kind === "function" ? "Implementation" : "Declaration")

const unverifiedFinding = (candidate: Candidate): Diagnostic =>
  finding({
    ruleId: RULE_ID,
    severity: "warn",
    message: `${kindOf(candidate.duplicate)} is structurally identical to \`${candidate.canonical.name}\` in ${candidate.canonical.file}:${candidate.canonical.location.line}.`,
    help: `Keep \`${candidate.canonical.name}\` and import it here, or make the two genuinely different. Not verified: no judgement was available.`,
    location: candidate.duplicate.location,
    judged: false,
  })

const unverified = (candidate: Candidate): Option.Option<Diagnostic> =>
  Option.some(unverifiedFinding(candidate))

const assess = Effect.fn("joggle/duplicate-implementation.assess")(function* (candidate: Candidate) {
  const judge = yield* Judge
  const evidence = {
    left: {
      symbol: candidate.canonical.name,
      kind: candidate.canonical.kind,
      path: candidate.canonical.file,
      source: candidate.canonical.text,
    },
    right: {
      symbol: candidate.duplicate.name,
      kind: candidate.duplicate.kind,
      path: candidate.duplicate.file,
      source: candidate.duplicate.text,
    },
    identical: true,
  }

  // A judgement is an optimisation on top of a fact, never a precondition for
  // reporting it: an unavailable judge degrades to an unverified finding.
  const outcome = yield* judge.ask({ evidence, questions }).pipe(
    Effect.map((result) => Option.some<JudgeResult>(result)),
    Effect.catch(() => Effect.succeed(Option.none<JudgeResult>())),
  )
  if (Option.isNone(outcome)) return unverified(candidate)

  const verdict = choiceOf(outcome.value.answers, "verdict")
  if (verdict === undefined) return unverified(candidate)
  if (verdict.choice === "keep_both") return Option.none<Diagnostic>()

  const keepRight = verdict.choice === "keep_right"
  const keep = keepRight ? candidate.duplicate : candidate.canonical
  const drop = keepRight ? candidate.canonical : candidate.duplicate

  return Option.some(
    finding({
      ruleId: RULE_ID,
      severity: "warn",
      message: `${kindOf(drop)} is a redundant copy of \`${keep.name}\` in ${keep.file}:${keep.location.line}.`,
      help: `Keep \`${keep.name}\` and import it here. If the two are genuinely different concepts, change one so the shape differs.`,
      location: drop.location,
      confidence: verdict.confidence,
      judged: true,
    }),
  )
})

export const duplicateImplementation = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "One declaration written more than once across files.",
  judged: true,
  run: Effect.fn("joggle/duplicate-implementation")(function* (workspace) {
    const candidates = find(workspace)
    if (candidates.length === 0) return []
    const budget = policy.duplicateImplementation.maxJudgements
    const outcomes = yield* Effect.forEach(candidates.slice(0, budget), assess, {
      concurrency: 8,
    })
    const reported = outcomes.flatMap((outcome) => (Option.isSome(outcome) ? [outcome.value] : []))
    // Over budget: still reported, never silently dropped.
    return [...reported, ...candidates.slice(budget).map(unverifiedFinding)]
  }),
})
