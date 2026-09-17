import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { makeCluster, type Cluster } from "../cluster.ts"
import { budgetNote, defineRule, outcome } from "../rule.ts"
import { assessCluster, collapseQuestionnaire, unverifiedFinding, type ClusterRule } from "./cluster-verdict.ts"
import type { Unit, Workspace } from "../workspace.ts"

const spec: ClusterRule = {
  ruleId: "joggle/duplicate-implementation",
  severity: "warn",
  // Shape equality is a fact, so an unjudged cluster is still worth reporting.
  onUnavailable: "report",
  questionnaire: collapseQuestionnaire,
  subject: (cluster) => {
    const names = [...new Set(cluster.members.map((member) => member.name))]
    return names.length === 1
      ? `\`${names[0] ?? "?"}\` is declared ${cluster.members.length} times`
      : `${cluster.members.length} declarations share one shape`
  },
}

/**
 * A shape group *is* a cluster: every member has the same shape hash and the
 * same resolved type identity. Broad on purpose -- over-production is the
 * judge's problem, a missed copy is not.
 */
const find = (workspace: Workspace): ReadonlyArray<Cluster> => {
  const groups = new Map<string, Array<Unit>>()
  for (const unit of workspace.units) {
    // Resolved types are part of the key: two helpers that read identically but
    // reference different declared types are not the same helper.
    const key = `${unit.kind}:${unit.shapeHash}:${unit.typeSignature}`
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, [unit])
    else existing.push(unit)
  }

  const clusters: Array<Cluster> = []
  for (const group of groups.values()) {
    if (new Set(group.map((unit) => unit.file)).size < 2) continue
    clusters.push(makeCluster(group, true, 1))
  }
  return clusters
}

/** Largest clusters first when a budget bites, so the note names what matters. */
const largestOf = (clusters: ReadonlyArray<Cluster>): ReadonlyArray<string> =>
  [...clusters]
    .sort((a, b) => b.members.length - a.members.length)
    .slice(0, 3)
    .map((cluster) => `${cluster.members.length}× ${spec.subject(cluster)}`)

export const duplicateImplementation = defineRule({
  id: spec.ruleId,
  severity: spec.severity,
  description: "One declaration written more than once across files.",
  judged: true,
  run: Effect.fn("joggle/duplicate-implementation")(function* (workspace) {
    const clusters = find(workspace)
    if (clusters.length === 0) return outcome([])
    const budget = policy.duplicateImplementation.maxClusters
    const outcomes = yield* Effect.forEach(clusters.slice(0, budget), assessCluster(spec, workspace.imports), {
      concurrency: 8,
    })
    const reported = outcomes.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []))
    // Over budget: the fact is still reported, unjudged and labelled as such.
    const overflow = clusters
      .slice(budget)
      .map((cluster) => unverifiedFinding(spec, cluster))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    return outcome(
      [...reported, ...overflow],
      budgetNote("clusters", budget, clusters.length, largestOf(clusters.slice(budget))),
    )
  }),
})
