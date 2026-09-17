import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { components, makeCluster, type Cluster } from "../cluster.ts"
import { defineRule } from "../rule.ts"
import { assessCluster, unverifiedFinding, type ClusterRule } from "./cluster-verdict.ts"
import type { Unit, Workspace } from "../workspace.ts"

const spec: ClusterRule = {
  ruleId: "joggle/naming-drift",
  severity: "warn",
  onUnavailable: "propagate",
  subject: (cluster) => {
    const names = [...new Set(cluster.members.map((member) => member.name))]
    return names.length === 1
      ? `\`${names[0] ?? "?"}\` is spelled ${cluster.members.length} ways`
      : `${names.join(", ")} may be one concept`
  },
}

/**
 * One spelling per concept.
 *
 * Names are addresses: an agent finds code by grepping a name, so two names for
 * one concept cost retrieval on every future change. This table is the only
 * hand-written knowledge in the rule, and it exists so the judgement sees
 * `orgId` and `organizationId` as the same phrase rather than two strings.
 */
const abbreviations: Readonly<Record<string, string>> = {
  arg: "argument", auth: "authentication", cfg: "configuration", config: "configuration",
  ctx: "context", db: "database", dir: "directory", doc: "document", env: "environment",
  err: "error", fn: "function", id: "identifier", idx: "index", impl: "implementation",
  info: "information", init: "initialize", msg: "message", num: "number",
  org: "organization", param: "parameter", prev: "previous", repo: "repository",
  req: "request", res: "response", spec: "specification", stat: "statistic",
  str: "string", util: "utility", utils: "utility",
}

export const words = (name: string): ReadonlyArray<string> =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)

export const expanded = (name: string): ReadonlyArray<string> =>
  words(name).map((word) => abbreviations[word] ?? word)

const nameScore = (left: string, right: string): number => {
  const a = new Set(expanded(left))
  const b = new Set(expanded(right))
  let intersection = 0
  for (const word of a) if (b.has(word)) intersection += 1
  const union = a.size + b.size - intersection
  const jaccard = union === 0 ? 0 : intersection / union
  const headA = expanded(left).at(-1)
  const headB = expanded(right).at(-1)
  return headA !== undefined && headA === headB ? Math.min(1, jaccard + 0.25) : jaccard
}

/** Only declarations sharing a head noun are compared; clusters then grow by union. */
const find = (workspace: Workspace): ReadonlyArray<Cluster> => {
  const { minScore, maxPairs } = policy.namingDrift
  const units = workspace.units
  const byHead = new Map<string, Array<number>>()
  units.forEach((unit, index) => {
    if (!unit.exported) return
    const head = expanded(unit.name).at(-1)
    if (head === undefined) return
    const existing = byHead.get(head)
    if (existing === undefined) byHead.set(head, [index])
    else existing.push(index)
  })

  const pairs: Array<{ left: number; right: number; score: number }> = []
  for (const group of byHead.values()) {
    for (let a = 0; a < group.length; a += 1) {
      for (let b = a + 1; b < group.length; b += 1) {
        const left = group[a]
        const right = group[b]
        if (left === undefined || right === undefined) continue
        const one = units[left]
        const two = units[right]
        if (one === undefined || two === undefined) continue
        if (one.name === two.name) continue
        if (one.file === two.file) continue
        if (one.kind !== two.kind) continue
        const score = nameScore(one.name, two.name)
        if (score < minScore) continue
        pairs.push({ left, right, score })
      }
    }
  }

  const best = pairs.sort((a, b) => b.score - a.score).slice(0, maxPairs)
  const clusters: Array<Cluster> = []
  for (const group of components(units.length, best.map((pair) => [pair.left, pair.right] as const))) {
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

export const namingDrift = defineRule({
  id: spec.ruleId,
  severity: spec.severity,
  description: "Two spellings of one concept across files.",
  judged: true,
  run: Effect.fn("joggle/naming-drift")(function* (workspace) {
    const clusters = find(workspace)
    if (clusters.length === 0) return []
    const outcomes = yield* Effect.forEach(clusters, assessCluster(spec, workspace.imports), { concurrency: 4 })
    return outcomes.flatMap((outcome) => (Option.isSome(outcome) ? [outcome.value] : []))
  }),
})
