import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { Service as Judge } from "../judge.ts"
import { defineRule, finding, pairsOf, type UnitPair } from "../rule.ts"
import type { Answer, Diagnostic, Question } from "../schema.ts"
import { similarity, type Unit, type Workspace } from "../workspace.ts"

const RULE_ID = "joggle/duplicate-meaning"

/**
 * Deterministic preselection. Expensive to get wrong only in the sense that we
 * miss a pair; it is never allowed to make the judgement itself.
 *
 * Token-length bucketing keeps this linear-ish instead of a full O(n^2) sweep:
 * two implementations with wildly different sizes cannot be near-duplicates.
 */
const find = (workspace: Workspace): ReadonlyArray<UnitPair> => {
  const { minSimilarity, maxSimilarity, maxPairs, minTokens } = policy.duplicateMeaning
  const buckets = new Map<number, Array<Unit>>()
  for (const unit of workspace.units) {
    const bucket = Math.floor(unit.tokens.length / 8)
    const existing = buckets.get(bucket)
    if (existing === undefined) buckets.set(bucket, [unit])
    else existing.push(unit)
  }

  const candidates: Array<UnitPair> = []
  for (const [index, bucket] of buckets) {
    const neighbours = [...bucket, ...(buckets.get(index + 1) ?? [])]
    for (const pair of pairsOf(neighbours)) {
      if (pair.left.file === pair.right.file) continue
      if (pair.left.kind !== pair.right.kind) continue
      if (pair.left.tokens.length < minTokens || pair.right.tokens.length < minTokens) continue
      const score = similarity(pair.left.tokens, pair.right.tokens)
      if (score < minSimilarity || score > maxSimilarity) continue
      candidates.push({ left: pair.left, right: pair.right, score })
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, maxPairs)
}

interface Evidence {
  readonly left: {
    readonly symbol: string
    readonly path: string
    readonly line: number
    readonly exported: boolean
    readonly source: string
  }
  readonly right: Evidence["left"]
  readonly structural_overlap: number
}

const evidenceOf = (candidate: UnitPair): Evidence => ({
  left: {
    symbol: candidate.left.name,
    path: candidate.left.file,
    line: candidate.left.location.line,
    exported: candidate.left.exported,
    source: candidate.left.text,
  },
  right: {
    symbol: candidate.right.name,
    path: candidate.right.file,
    line: candidate.right.location.line,
    exported: candidate.right.exported,
    source: candidate.right.text,
  },
  structural_overlap: Number(candidate.score.toFixed(3)),
})

/**
 * Four atomic yes/no questions and one taxonomy question, asked together in a
 * single request. Decomposing like this is what lets the weights in policy.ts
 * mean something: each number the policy reads is one judgement a person could
 * inspect and argue with on its own.
 */
const questions = {
  same_concept: {
    type: "noul",
    instructions:
      "Do `left` and `right` implement the same concept, such that keeping both is duplication rather than a real distinction?",
    criteria: {
      true: "They are the same idea; one is redundant.",
      false: "They are different ideas that happen to share a structure.",
    },
  },
  same_behavior: {
    type: "noul",
    instructions:
      "Given the same inputs, would `left` and `right` produce the same observable behaviour?",
    criteria: {
      true: "Behaviour is equivalent in every case a caller can observe.",
      false: "At least one input produces a different result, error or side effect.",
    },
  },
  intentional_specialization: {
    type: "noul",
    instructions:
      "Is one of `left` or `right` a deliberate specialization of the other, such as a policy-specific variant of a generic routine?",
    criteria: {
      true: "A deliberate specialization exists and is intentional.",
      false: "Neither is a deliberate specialization of the other.",
    },
  },
  canonical: {
    type: "choice",
    instructions:
      "Which of `left` or `right` is the better single implementation to keep, judging by the code itself?",
    criteria: {
      left: "Keep `left`.",
      right: "Keep `right`.",
      neither: "Neither fits; both should be replaced by a new shared implementation.",
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

const assess = Effect.fn("joggle/duplicate-meaning.assess")(function* (candidate: UnitPair) {
  const judge = yield* Judge
  const result = yield* judge.ask({ evidence: evidenceOf(candidate), questions })

  const sameConcept = noul(result.answers, "same_concept")
  const sameBehavior = noul(result.answers, "same_behavior")
  const specialization = noul(result.answers, "intentional_specialization")
  const canonical = choice(result.answers, "canonical")
  if (
    sameConcept === undefined ||
    sameBehavior === undefined ||
    specialization === undefined ||
    canonical === undefined
  ) {
    return Option.none<Diagnostic>()
  }

  const { weights, activationScore, maxSpecialization } = policy.duplicateMeaning
  const composite =
    weights.sameConcept * sameConcept +
    weights.sameBehavior * sameBehavior +
    weights.notSpecialization * (1 - specialization)

  if (composite < activationScore) return Option.none<Diagnostic>()
  if (specialization > maxSpecialization) return Option.none<Diagnostic>()

  const keep =
    canonical.choice === "right"
      ? candidate.right
      : canonical.choice === "left"
        ? candidate.left
        : candidate.left.file <= candidate.right.file
          ? candidate.left
          : candidate.right
  const drop = keep === candidate.left ? candidate.right : candidate.left

  return Option.some(
    finding({
      ruleId: RULE_ID,
      severity: "warn",
      message: `Near-duplicate of \`${keep.name}\` (${keep.file}:${keep.location.line}) — ${Math.round(candidate.score * 100)}% structural overlap.`,
      help:
        canonical.choice === "neither"
          ? `Both are close enough to be one implementation. Keep \`${keep.name}\` for now and extract the shared version.`
          : `Keep \`${keep.name}\` and point this declaration's callers at it.`,
      location: drop.location,
      confidence: composite,
      judged: true,
    }),
  )
})

export const duplicateMeaning = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "Cross-file near-duplicates that a judgement says are the same concept.",
  judged: true,
  run: Effect.fn("joggle/duplicate-meaning")(function* (workspace) {
    const candidates = find(workspace)
    if (candidates.length === 0) return []
    const outcomes = yield* Effect.forEach(candidates, assess, { concurrency: 4 })
    return outcomes.flatMap((outcome) => (Option.isSome(outcome) ? [outcome.value] : []))
  }),
})
