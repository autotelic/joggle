import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { components, makeCluster, type Cluster } from "../cluster.ts"
import { budgetNote, defineRule, inScope, outcome, type Scope } from "../rule.ts"
import { allPairs, type ScoredPair } from "../similarity.ts"
import { assessClusters, collapseQuestionnaire, type ClusterRule } from "./cluster-verdict.ts"
import { layersFrom } from "../architecture.ts"
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

/**
 * Only declarations of the same kind, in different files, can be one thing --
 * and when scoped, at least one side has to be the side that changed.
 */
const candidatePair = (
  units: ReadonlyArray<Unit>,
  scope: Scope,
  pair: ScoredPair,
): boolean => {
  const one = units[pair.left]
  const two = units[pair.right]
  if (one === undefined || two === undefined) return false
  if (one.file === two.file || one.kind !== two.kind) return false
  return inScope(scope, one.file) || inScope(scope, two.file)
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
/**
 * Candidates, and the clusters that are not questions.
 *
 * Split in two rather than filtered, because an oversized cluster is worth
 * SAYING something about -- it is real evidence that N declarations were
 * generated from one template -- while not being worth asking about.
 */
interface Candidates {
  readonly clusters: ReadonlyArray<Cluster>
  readonly oversized: ReadonlyArray<Cluster>
}

const find = (workspace: Workspace, scope: Scope): Candidates => {
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
    (pair) => pair.score <= maxSimilarity && candidatePair(units, scope, pair),
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
    // Test fixtures are compared only against each other.
    if (members.every((unit) => unit.test)) return
    clusters.push(makeCluster(members, false, overlapOf.get(id) ?? 0))
  })
  // A cluster bigger than the evidence panel cannot be a question. Only
  // `policy.evidence.maxMembers` of its members are ever shown, so the model is
  // asked about 105 declarations while looking at 12 of them -- and its answer
  // is the only one available: no. One repository produced "105 declarations
  // that may be one thing: down": every migration's `down` function, chained by
  // union-find, none of which can be deleted.
  //
  // The bound is not a new threshold. It is the size at which the evidence stops
  // being complete, which is the point at which the question stops being
  // answerable.
  const answerable = clusters.filter(
    (cluster) => cluster.members.length <= policy.evidence.maxMembers,
  )
  return {
    clusters: answerable,
    oversized: clusters.filter((cluster) => cluster.members.length > policy.evidence.maxMembers),
  }
}

export const duplicateMeaning = defineRule({
  id: spec.ruleId,
  severity: spec.severity,
  description: "Near-duplicates where a judgement says one declaration replaces the other.",
  judged: true,
  run: Effect.fn("joggle/duplicate-meaning")(function* (workspace, scope, context) {
    const { clusters, oversized } = find(workspace, scope)
    const budget = policy.duplicateMeaning.maxClusters
    const { diagnostics: findings, drops } = yield* assessClusters(
      spec,
      workspace.imports,
      clusters.slice(0, budget),
      layersFrom(context.config),
    )
    const largest = clusters
      .slice(budget)
      .sort((a, b) => b.members.length - a.members.length)
      .slice(0, 3)
      .map((cluster) => `${cluster.members.length}× ${spec.subject(cluster)}`)

    // Reported as drops rather than dropped silently: "476 declarations across 9
    // clusters were generated from one template" is a fact about the codebase,
    // and the only thing wrong with it was asking the model to confirm it.
    const tooManyToShow = oversized.map((cluster) => ({
      ruleId: spec.ruleId,
      subject: spec.subject(cluster),
      stage: "no_evidence" as const,
      reason:
        cluster.members.length +
        " declarations share a shape, which is more than the " +
        policy.evidence.maxMembers +
        " the evidence panel can show at once",
    }))

    return outcome(
      findings,
      [
        ...budgetNote("clusters", budget, clusters.length, largest),
        ...(oversized.length === 0
          ? []
          : [
              oversized.length +
                " cluster(s) were too large to be one decision (" +
                oversized.reduce((sum, cluster) => sum + cluster.members.length, 0) +
                " declarations): generated from one template rather than duplicated",
            ]),
      ],
      [...tooManyToShow, ...drops],
    )
  }),
})
