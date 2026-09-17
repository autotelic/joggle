import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { Service as Judge } from "../judge.ts"
import { defineRule, finding, pairsOf, type UnitPair } from "../rule.ts"
import type { Answer, Diagnostic, Question } from "../schema.ts"
import { similarity, type Unit, type Workspace } from "../workspace.ts"

const RULE_ID = "joggle/duplicate-meaning"

/**
 * Near-duplicates: structurally close but not identical, so someone renamed a
 * thing or the bodies drifted. Whether that is one concept or two is exactly the
 * judgement code cannot make, so this rule exists only to ask it.
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

const questions = {
  verdict: {
    type: "choice",
    instructions: {
      question: "Are these two declarations the same thing?",
      compare: ["`left.source`", "`right.source`"],
      focus:
        "They are `structural_overlap` similar but not identical. Decide whether the difference is naming drift, a genuine refinement of one idea, or two unrelated things.",
      location: "`left.path` and `right.path` say where each one lives.",
    },
    criteria: {
      same_keep_left: "One concept. Keep `left` and replace `right` with it.",
      same_keep_right: "One concept. Keep `right` and replace `left` with it.",
      related_keep_both:
        "Related but deliberately separate, such as a special case of a general routine. Keep both.",
      unrelated: "Coincidentally similar. They are different things. Change nothing.",
    },
  },
} satisfies Record<string, Question>

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
  const evidence = {
    left: {
      symbol: candidate.left.name,
      kind: candidate.left.kind,
      path: candidate.left.file,
      source: candidate.left.text,
    },
    right: {
      symbol: candidate.right.name,
      kind: candidate.right.kind,
      path: candidate.right.file,
      source: candidate.right.text,
    },
    structural_overlap: Number(candidate.score.toFixed(3)),
  }

  const result = yield* judge.ask({ evidence, questions })
  const verdict = choice(result.answers, "verdict")
  if (verdict === undefined) return Option.none<Diagnostic>()
  if (verdict.choice === "related_keep_both" || verdict.choice === "unrelated") {
    return Option.none<Diagnostic>()
  }

  const keepRight = verdict.choice === "same_keep_right"
  const keep = keepRight ? candidate.right : candidate.left
  const drop = keepRight ? candidate.left : candidate.right

  return Option.some(
    finding({
      ruleId: RULE_ID,
      severity: "warn",
      message: `Near-duplicate of \`${keep.name}\` (${keep.file}:${keep.location.line}) — ${Math.round(candidate.score * 100)}% structural overlap.`,
      help: `Keep \`${keep.name}\` and point this declaration's callers at it.`,
      location: drop.location,
      confidence: verdict.confidence,
      judged: true,
    }),
  )
})

export const duplicateMeaning = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "Near-duplicates where a judgement says one declaration replaces the other.",
  judged: true,
  run: Effect.fn("joggle/duplicate-meaning")(function* (workspace) {
    const candidates = find(workspace)
    if (candidates.length === 0) return []
    const outcomes = yield* Effect.forEach(candidates, assess, { concurrency: 4 })
    return outcomes.flatMap((outcome) => (Option.isSome(outcome) ? [outcome.value] : []))
  }),
})
