import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { Service as Judge } from "../judge.ts"
import { choiceOf, defineRule, finding, type UnitPair } from "../rule.ts"
import type { Answer, Diagnostic, Question } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/naming-drift"

/**
 * One spelling per concept.
 *
 * Names are addresses: an agent finds code by grepping a name, so two names for
 * one concept cost retrieval on every future change. This table is the only
 * hand-written knowledge in the rule, and it exists so the judgement sees
 * `orgId` and `organizationId` as the same phrase rather than as two strings.
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

const score = (left: string, right: string): number => {
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

/** Only declarations sharing a head noun are compared. */
const find = (workspace: Workspace): ReadonlyArray<UnitPair> => {
  const { minScore, maxPairs } = policy.namingDrift
  const byHead = new Map<string, Array<Unit>>()
  for (const unit of workspace.units) {
    if (!unit.exported) continue
    const head = expanded(unit.name).at(-1)
    if (head === undefined) continue
    const existing = byHead.get(head)
    if (existing === undefined) byHead.set(head, [unit])
    else existing.push(unit)
  }

  const candidates: Array<UnitPair> = []
  for (const group of byHead.values()) {
    for (let a = 0; a < group.length; a += 1) {
      for (let b = a + 1; b < group.length; b += 1) {
        const left = group[a]
        const right = group[b]
        if (left === undefined || right === undefined) continue
        if (left.name === right.name) continue
        if (left.file === right.file) continue
        if (left.kind !== right.kind) continue
        if (left.shapeHash === right.shapeHash) continue
        const value = score(left.name, right.name)
        if (value < minScore) continue
        candidates.push({ left, right, score: value })
      }
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, maxPairs)
}

const questions = {
  verdict: {
    type: "choice",
    instructions: {
      question: "Are these two names two spellings of one concept, or two different concepts?",
      compare: ["`left.symbol`", "`right.symbol`"],
      focus:
        "Read past the abbreviation: `left.expanded` and `right.expanded` are what each name means word by word. Judge the concepts, not the strings.",
      location: "`left.path` and `right.path` say where each one lives.",
    },
    criteria: {
      same_use_left: "One concept, two spellings. Standardize on `left.symbol`.",
      same_use_right: "One concept, two spellings. Standardize on `right.symbol`.",
      distinct: "Two different concepts. Both names are correct. Change nothing.",
    },
  },
} satisfies Record<string, Question>

const assess = Effect.fn("joggle/naming-drift.assess")(function* (candidate: UnitPair) {
  const judge = yield* Judge
  const evidence = {
    left: {
      symbol: candidate.left.name,
      expanded: expanded(candidate.left.name).join(" "),
      path: candidate.left.file,
      source: candidate.left.text.slice(0, 400),
    },
    right: {
      symbol: candidate.right.name,
      expanded: expanded(candidate.right.name).join(" "),
      path: candidate.right.file,
      source: candidate.right.text.slice(0, 400),
    },
    name_overlap: Number(candidate.score.toFixed(3)),
  }

  const result = yield* judge.ask({ evidence, questions })
  const verdict = choiceOf(result.answers, "verdict")
  if (verdict === undefined) return Option.none<Diagnostic>()
  if (verdict.choice === "distinct") return Option.none<Diagnostic>()

  const keep = verdict.choice === "same_use_right" ? candidate.right : candidate.left
  const drop = keep === candidate.left ? candidate.right : candidate.left

  return Option.some(
    finding({
      ruleId: RULE_ID,
      severity: "warn",
      message: `\`${drop.name}\` and \`${keep.name}\` are two spellings of one concept.`,
      help: `Standardize on \`${keep.name}\`. Read together, both mean "${expanded(keep.name).join(" ")}".`,
      location: drop.location,
      confidence: verdict.confidence,
      judged: true,
    }),
  )
})

export const namingDrift = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "Two spellings of one concept across files.",
  judged: true,
  run: Effect.fn("joggle/naming-drift")(function* (workspace) {
    const candidates = find(workspace)
    if (candidates.length === 0) return []
    const outcomes = yield* Effect.forEach(candidates, assess, { concurrency: 4 })
    return outcomes.flatMap((outcome) => (Option.isSome(outcome) ? [outcome.value] : []))
  }),
})
