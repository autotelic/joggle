import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { components, makeCluster, type Cluster } from "../cluster.ts"
import { defineRule } from "../rule.ts"
import { assessCluster, unverifiedFinding, type ClusterRule } from "./cluster-verdict.ts"
import { similarity, type Unit, type Workspace } from "../workspace.ts"

const spec: ClusterRule = {
  ruleId: "joggle/duplicate-meaning",
  severity: "warn",
  // A near-duplicate is a guess until a judgement says otherwise, so an
  // unjudged cluster is silence and the rule reports itself as skipped.
  onUnavailable: "propagate",
  subject: (cluster) => {
    const names = [...new Set(cluster.members.map((member) => member.name))]
    return `${cluster.members.length} declarations that may be one thing: ${names.join(", ")}`
  },
}

interface Pair {
  readonly left: number
  readonly right: number
  readonly score: number
}

/**
 * Near-duplicates: structurally close but not identical, so someone renamed a
 * thing or the bodies drifted. Pairs are unioned into clusters before judging,
 * because "these eighteen `formatDate`s are one function" is a single decision,
 * not a hundred and fifty-three.
 */
const find = (workspace: Workspace): ReadonlyArray<Cluster> => {
  const { minSimilarity, maxSimilarity, maxPairs, minTokens } = policy.duplicateMeaning
  const units = workspace.units

  // Length buckets keep the pair scan roughly linear. Two implementations of
  // wildly different sizes cannot be near-duplicates.
  const buckets = new Map<number, Array<number>>()
  units.forEach((unit, index) => {
    const bucket = Math.floor(unit.tokens.length / 8)
    const existing = buckets.get(bucket)
    if (existing === undefined) buckets.set(bucket, [index])
    else existing.push(index)
  })

  const pairs: Array<Pair> = []
  for (const [bucket, members] of buckets) {
    const neighbours = [...members, ...(buckets.get(bucket + 1) ?? [])]
    for (let a = 0; a < neighbours.length; a += 1) {
      for (let b = a + 1; b < neighbours.length; b += 1) {
        const left = neighbours[a]
        const right = neighbours[b]
        if (left === undefined || right === undefined) continue
        const one = units[left]
        const two = units[right]
        if (one === undefined || two === undefined) continue
        if (one.file === two.file) continue
        if (one.kind !== two.kind) continue
        if (one.tokens.length < minTokens || two.tokens.length < minTokens) continue
        const score = similarity(one.tokens, two.tokens)
        if (score < minSimilarity || score > maxSimilarity) continue
        pairs.push({ left, right, score })
      }
    }
  }

  const best = pairs.sort((a, b) => b.score - a.score).slice(0, maxPairs)
  const edges = best.map((pair) => [pair.left, pair.right] as const)
  const clusters: Array<Cluster> = []
  for (const group of components(units.length, edges)) {
    if (group.length < 2) continue
    const members = group
      .map((index) => units[index])
      .filter((unit): unit is Unit => unit !== undefined)
    if (members.length < 2) continue
    const overlap = Math.max(
      ...best
        .filter((pair) => group.includes(pair.left) && group.includes(pair.right))
        .map((pair) => pair.score),
      0,
    )
    clusters.push(makeCluster(members, false, overlap))
  }
  return clusters
}

export const duplicateMeaning = defineRule({
  id: spec.ruleId,
  severity: spec.severity,
  description: "Near-duplicates where a judgement says one declaration replaces the other.",
  judged: true,
  run: Effect.fn("joggle/duplicate-meaning")(function* (workspace) {
    const clusters = find(workspace)
    if (clusters.length === 0) return []
    const outcomes = yield* Effect.forEach(clusters, assessCluster(spec), { concurrency: 4 })
    return outcomes.flatMap((outcome) => (Option.isSome(outcome) ? [outcome.value] : []))
  }),
})
