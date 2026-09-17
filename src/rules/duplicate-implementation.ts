import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { makeCluster, type Cluster } from "../cluster.ts"
import { defineRule } from "../rule.ts"
import { assessCluster, unverifiedFinding, type ClusterRule } from "./cluster-verdict.ts"
import type { Unit, Workspace } from "../workspace.ts"

const spec: ClusterRule = {
  ruleId: "joggle/duplicate-implementation",
  severity: "warn",
  // Shape equality is a fact, so an unjudged cluster is still worth reporting.
  onUnavailable: "report",
  subject: (cluster) => {
    const names = [...new Set(cluster.members.map((member) => member.name))]
    const what = names.length === 1 ? `\`${names[0] ?? "?"}\`` : `${cluster.members.length} declarations`
    return `${what} is declared ${cluster.members.length} times`
  },
}

/**
 * A shape group *is* a cluster: every member has the same shape hash. Broad on
 * purpose -- over-production is the judge's problem, a missed copy is not.
 */
const find = (workspace: Workspace): ReadonlyArray<Cluster> => {
  const groups = new Map<string, Array<Unit>>()
  for (const unit of workspace.units) {
    const key = `${unit.kind}:${unit.shapeHash}`
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

export const duplicateImplementation = defineRule({
  id: spec.ruleId,
  severity: spec.severity,
  description: "One declaration written more than once across files.",
  judged: true,
  run: Effect.fn("joggle/duplicate-implementation")(function* (workspace) {
    const clusters = find(workspace)
    if (clusters.length === 0) return []
    const budget = policy.duplicateImplementation.maxJudgements
    const outcomes = yield* Effect.forEach(clusters.slice(0, budget), assessCluster(spec), {
      concurrency: 8,
    })
    const reported = outcomes.flatMap((outcome) => (Option.isSome(outcome) ? [outcome.value] : []))
    // Over budget: still reported, never silently dropped.
    const overflow = clusters
      .slice(budget)
      .map((cluster) => unverifiedFinding(spec, cluster))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    return [...reported, ...overflow]
  }),
})
