import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { components, makeCluster, type Cluster } from "../cluster.ts"
import { budgetNote, defineRule, outcome } from "../rule.ts"
import { allPairs, type ScoredPair } from "../similarity.ts"
import { assessCluster, collapseQuestionnaire, type ClusterRule } from "./cluster-verdict.ts"
import type { Unit, Workspace } from "../workspace.ts"
import { nameList } from "../cluster.ts"

const spec: ClusterRule = {
  ruleId: "joggle/duplicate-meaning",
  severity: "warn",
  // A near-duplicate is a guess until a judgement says otherwise, so an
  // unjudged cluster is silence and the rule reports itself as skipped.
  onUnavailable: "propagate",
  questionnaire: collapseQuestionnaire,
  subject: (cluster) =>
    `${cluster.members.length} declarations that may be one thing: ${nameList(cluster)}`,
}

/** Only declarations of the same kind, in different files, can be one thing. */
const sameShape = (units: ReadonlyArray<Unit>, pair: ScoredPair): boolean => {
  const one = units[pair.left]
  const two = units[pair.right]
  if (one === undefined || two === undefined) return false
  return one.file !== two.file && one.kind === two.kind
}

/**
 * Near-duplicates: structurally close but not identical, so someone renamed a
 * thing or the bodies drifted.
 *
 * Pair generation is COMPLETE. It used to be a global sort by similarity with a
 * slice, which is a selection rather than a bound: forty high-scoring pairs
 * elsewhere in the tree could spend the whole budget and leave the eighteen
 * definitions of one helper never compared. The sweep visits every pair that
 * could clear the threshold, and the only bound left is on how many clusters
 * are judged.
 */
const find = (workspace: Workspace): ReadonlyArray<Cluster> => {
  const { minSimilarity, maxSimilarity, minTokens } = policy.duplicateMeaning

  const units = workspace.units
  const eligible = units
    .map((unit, index) => ({ unit, index }))
    .filter((entry) => entry.unit.tokens.length >= minTokens)

  const candidates = allPairs(
    eligible.map((entry) => ({ index: entry.index, shingles: entry.unit.shingles })),
    minSimilarity,
  )

  const pairs: Array<ScoredPair> = candidates.filter(
    (pair) => pair.score <= maxSimilarity && sameShape(units, pair),
  )

  const groups = components(
    workspace.units.length,
    pairs.map((pair) => [pair.left, pair.right] as const),
  )
  const groupOf = new Map<number, number>()
  groups.forEach((group, id) => {
    for (const index of group) groupOf.set(index, id)
  })
  const overlapOf = new Map<number, number>()
  for (const pair of pairs) {
    const id = groupOf.get(pair.left)
    if (id === undefined) continue
    if ((overlapOf.get(id) ?? 0) < pair.score) overlapOf.set(id, pair.score)
  }

  const clusters: Array<Cluster> = []
  groups.forEach((group, id) => {
    if (group.length < 2) return
    const members = group
      .map((index) => workspace.units[index])
      .filter((unit): unit is Unit => unit !== undefined)
    if (members.length < 2) return
    clusters.push(makeCluster(members, false, overlapOf.get(id) ?? 0))
  })
  return clusters
}

export const duplicateMeaning = defineRule({
  id: spec.ruleId,
  severity: spec.severity,
  description: "Near-duplicates where a judgement says one declaration replaces the other.",
  judged: true,
  run: Effect.fn("joggle/duplicate-meaning")(function* (workspace) {
    const clusters = find(workspace)
    if (clusters.length === 0) return outcome([])
    const budget = policy.duplicateMeaning.maxClusters
    const outcomes = yield* Effect.forEach(clusters.slice(0, budget), assessCluster(spec, workspace.imports), {
      concurrency: 4,
    })
    const findings = outcomes.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []))
    const largest = clusters
      .slice(budget)
      .sort((a, b) => b.members.length - a.members.length)
      .slice(0, 3)
      .map((cluster) => `${cluster.members.length}× ${spec.subject(cluster)}`)
    return outcome(findings, budgetNote("clusters", budget, clusters.length, largest))
  }),
})
