import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { Service as Judge, type JudgeResult } from "../judge.ts"
import { defineRule, finding } from "../rule.ts"
import type { Answer, Diagnostic, Question } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/duplicate-implementation"

interface Candidate {
  /** The declaration kept if this collapses: the first by path. */
  readonly canonical: Unit
  /** The identical declaration reported at its own span. */
  readonly duplicate: Unit
}

/**
 * Deterministic candidate generation. Exact shape equality is a fact about the
 * AST, so this half is allowed to be broad: everything it over-produces is the
 * judge's problem, and the judge is cheaper than a missed duplicate.
 */
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
 * Behaviour is not asked about. Two declarations with the same shape hash have
 * the same syntax by construction, so the only open question is *intent*: is
 * this redundancy, or is it two domains that happen to look alike? Those are
 * perceptual questions about names and areas, which is what the model is for.
 */
const questions = {
  names_describe_same_thing: {
    type: "noul",
    instructions:
      "Do the two names `left.symbol` and `right.symbol` describe the same thing, or do they name genuinely different things?",
    criteria: {
      true: "The two names mean the same thing.",
      false: "The two names mean different things.",
    },
  },
  different_domains: {
    type: "noul",
    instructions:
      "Do `left.path` and `right.path` belong to different functional areas of this codebase, judging by the directory names?",
    criteria: {
      true: "The two declarations live in unrelated areas.",
      false: "The two declarations live in the same area.",
    },
  },
  general_purpose: {
    type: "noul",
    instructions:
      "Is `left.source` a general-purpose helper that has nothing to do with one specific domain, rather than a domain concept?",
    criteria: {
      true: "General-purpose: could live in a shared utility module.",
      false: "Domain-specific: it names a concept of this business.",
    },
  },
  verdict: {
    type: "choice",
    instructions:
      "Given `left.source` and `right.source` are syntactically identical, what should happen?",
    criteria: {
      left: "Keep `left`; `right` is redundant.",
      right: "Keep `right`; `left` is redundant.",
      keep_both: "Keep both. The duplication is intentional, because the two belong to different concerns.",
    },
  },
} satisfies Record<string, Question>

const noul = (answers: Readonly<Record<string, Answer>>, id: string): number | undefined => {
  const answer = answers[id]
  return answer !== undefined && answer.type === "noul" ? answer.noul : undefined
}

const choice = (
  answers: Readonly<Record<string, Answer>>,
  id: string,
): { readonly choice: string; readonly confidence: number } | undefined => {
  const answer = answers[id]
  return answer !== undefined && answer.type === "choice"
    ? { choice: answer.choice, confidence: answer.confidence }
    : undefined
}

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

const kindOf = (unit: Unit): string => (unit.kind === "function" ? "Implementation" : "Declaration")

const assess = Effect.fn("joggle/duplicate-implementation.assess")(function* (
  candidate: Candidate,
) {
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

  const answers = outcome.value.answers
  const sameName = noul(answers, "names_describe_same_thing")
  const generalPurpose = noul(answers, "general_purpose")
  const verdict = choice(answers, "verdict")
  const p = policy.duplicateImplementation

  // A response without the verdict is not a judgement we can act on. Claiming
  // "judged" here would be worse than admitting the finding is unverified.
  if (verdict === undefined) return unverified(candidate)

  // The model may override the deterministic fact for exactly two reasons, and
  // both are about intent rather than geography:
  //   1. the two names genuinely mean different things, so the match is chance;
  //   2. it is confident that both declarations should stay.
  if (verdict.choice === "keep_both" && verdict.confidence >= p.keepBothConfidence) {
    return Option.none<Diagnostic>()
  }
  if (sameName !== undefined && sameName < p.nameDivergenceFloor) return Option.none<Diagnostic>()

  const keepRight = verdict.choice === "right"
  const keep = keepRight ? candidate.duplicate : candidate.canonical
  const drop = keepRight ? candidate.canonical : candidate.duplicate
  const confidence = Math.max(verdict.confidence, sameName ?? 0, generalPurpose ?? 0)

  return Option.some(
    finding({
      ruleId: RULE_ID,
      severity: "warn",
      message: `${kindOf(drop)} is structurally identical to \`${keep.name}\` in ${keep.file}:${keep.location.line}.`,
      help: `Keep \`${keep.name}\` and import it here. If the two are genuinely different concepts, change one so the shape differs.`,
      location: drop.location,
      confidence,
      judged: true,
    }),
  )
})

export const duplicateImplementation = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "Structurally identical declarations in more than one file.",
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
    const overflow = candidates.slice(budget).map(unverifiedFinding)
    return [...reported, ...overflow]
  }),
})
