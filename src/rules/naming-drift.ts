import { Effect } from "effect"
import { policy } from "../policy.ts"
import { makeCluster, nameList, type Cluster } from "../cluster.ts"
import {
  budgetNote,
  choiceOf,
  declined,
  defineRule,
  inScope,
  marginOf,
  noulOf,
  outcome,
  type Scope,
} from "../rule.ts"
import { assessClusters, type ClusterRule } from "./cluster-verdict.ts"
import { layersFrom } from "../architecture.ts"
import type { Answer } from "../schema.ts"
import { nameVocabulary } from "../vocabulary.ts"
import type { Unit, Workspace } from "../workspace.ts"

/**
 * The question naming-drift should always have been asking.
 *
 * It asks whether two NAMES denote one concept -- a question about words -- not
 * whether one declaration is a redundant copy of the other, which is a question
 * about bodies and is correctly answered "no" for two different things that
 * merely share a name root. The state carries the expanded words for both, so
 * the model compares meanings rather than strings, and `same_words` reports the
 * case where only the spelling differs.
 */
const nameQuestionnaire: ClusterRule["questionnaire"] = (cluster, described) => {
  const left = described[0]
  const right = described[1]
  const wordsOf = (unit: Unit | undefined) => (unit === undefined ? [] : expanded(unit.name))
  const leftWords = wordsOf(left)
  const rightWords = wordsOf(right)
  const sameWords = leftWords.join(" ") === rightWords.join(" ")

  return {
    state: {
      left: { symbol: left?.name ?? null, words: leftWords, kind: left?.kind ?? null, path: left?.file ?? null },
      right: { symbol: right?.name ?? null, words: rightWords, kind: right?.kind ?? null, path: right?.file ?? null },
      same_words: sameWords,
    },
    questions: {
      one_concept: {
        type: "noul",
        instructions: {
          question: "Do `left.symbol` and `right.symbol` denote the same concept?",
          compare: ["{candidate}left.words", "{candidate}right.words"],
          focus:
            "Compare what each name means word by word. Two names for one concept are a spelling problem; two names for two different things are not, however similar they read.",
        },
        criteria: nameVocabulary.oneConcept,
      },
      verdict: {
        type: "choice",
        instructions: {
          question: "What should happen to these two names?",
          fallback: "Choose \`no_issue\` when the names denote two different concepts.",
          compare: ["{candidate}left.symbol", "{candidate}right.symbol"],
          focus:
            "{candidate}left.words and {candidate}right.words are what each name means; {candidate}same_words is true when only the spelling differs.",
        },
        criteria: {
          same_use_left: nameVocabulary.standardize(left?.name ?? "left"),
          same_use_right: `One concept, two spellings. Standardize on \`${right?.name ?? "right"}\`.`,
          no_issue: "Two different concepts. Both names are correct. Change nothing.",
        },
      },
    },
    read: (answers: Readonly<Record<string, Answer>>) => {
      const verdict = choiceOf(answers, "verdict")
      const oneConcept = noulOf(answers, "one_concept")
      if (verdict === undefined) return undefined
      const score = oneConcept ?? verdict.confidence
      const margin = marginOf(answers, "verdict") ?? 1
      if (declined(verdict.choice)) {
        return { keep: undefined, confidence: verdict.confidence, score, redundancy: score, margin }
      }
      return {
        keep: verdict.choice === "same_use_right" ? 1 : 0,
        confidence: verdict.confidence,
        score,
        // Names have no consequence axis: whether two spellings matter is what
        // `one_concept` already asks.
        redundancy: score,
        margin,
      }
    },
  }
}

const spec: ClusterRule = {
  ruleId: "joggle/naming-drift",
  severity: "warn",
  onUnavailable: "propagate",
  questionnaire: nameQuestionnaire,
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

/**
 * Jaccard over expanded words, and nothing else.
 *
 * This used to add a quarter when the two names shared a head noun, to catch
 * `fetchUserProfile` against `getUserProfile`. The bonus also lifted every pair
 * of `*Modal`s over the line, which is how one category became a "concept".
 * Those two names already score 0.5 without it, which is the threshold.
 */
const nameScore = (left: string, right: string): number => {
  const a = new Set(expanded(left))
  const b = new Set(expanded(right))
  let intersection = 0
  for (const word of a) if (b.has(word)) intersection += 1
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Words that do not distinguish one concept from another when they differ.
 *
 * The note on the filter has always said this is the discriminator -- "case,
 * word order and an accessor verb like `get` or `calculate` do not distinguish
 * anything" -- and the CODE admitted any single extra word, which is how
 * `convertUtcDateToLocalizedDateTime` and `convertUtcDateToFormatted
 * LocalizedDateTime` got in. On one repository that bucket was the whole of the
 * rule's 87 candidates, and the model declined all 87 with `one_concept` between
 * 0.37 and 0.44: not "no", but "not quite". A filter that produces near-misses
 * at 0.42 is paying to be told it was close.
 *
 * The distinction is not the size of the difference but its kind. `get` in front
 * of a name adds nothing; `formatted` in the middle of one changes what the
 * function does, and two functions that do different things are two concepts no
 * matter how much of their names they share.
 */
const NON_DISTINGUISHING = new Set([
  "get", "fetch", "load", "read", "find", "lookup", "resolve", "query",
  "calculate", "compute", "derive", "make", "build", "create", "do",
  "the", "a", "an", "of", "for", "by", "with", "to", "from", "on",
])

/**
 * Whether a pair of names is worth asking the model about.
 *
 * Exported so the filter can be tested as a rule of its own. It is the whole
 * difference between a rule that costs money and one that spends it.
 */
export const worthJudging = (left: string, right: string): boolean => {
  if (left === right) return false
  const words = new Set(expanded(left))
  const other = new Set(expanded(right))
  let common = 0
  for (const word of words) if (other.has(word)) common += 1
  const differs = words.size - common + (other.size - common)
  // Identical expanded words: the spellings differ and nothing else does.
  if (differs === 0) return true
  // One side inside the other, by exactly one word, and that word carries no
  // meaning of its own.
  const nested = common === words.size || common === other.size
  if (!nested || differs !== 1) return false
  const extra = words.size > other.size
    ? [...words].filter((word) => !other.has(word))
    : [...other].filter((word) => !words.has(word))
  return extra.every((word) => NON_DISTINGUISHING.has(word))
}

const sharedWords = (left: string, right: string): number => {
  const a = new Set(expanded(left))
  let shared = 0
  for (const word of new Set(expanded(right))) if (a.has(word)) shared += 1
  return shared
}

/**
 * Every pair of names in a head-noun family that is worth asking about, judged
 * pair by pair.
 *
 * There is no clustering here and no cap before the judging. Pairs were once
 * sorted globally by score and sliced, so a whole family could go unexamined
 * while another spent the budget, silently. Now every qualifying pair is
 * enumerated, ordered so a budget keeps the strongest, and whatever the budget
 * does not reach is named in the report.
 */
const find = (workspace: Workspace, scope: Scope): ReadonlyArray<Cluster> => {
  const { minScore, minSharedWords } = policy.namingDrift
  const units = workspace.units
  const byHead = new Map<string, Array<number>>()
  units.forEach((unit, index) => {
    // Exported names only, and the number is why: on one 2,456-file application
    // removing this filter takes the candidate set from 23 to 77, three times the
    // cost, and the recall it buys is unmeasured. The argument FOR removing it is
    // real -- an agent greps a file-local name as readily as an exported one, and
    // the two duplications joggle found in a 110-file library were both
    // file-local -- but those were found by the near-duplicate rule, which has no
    // such filter, so nothing is lost by leaving this one in place.
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
        // Test fixtures are compared only against each other.
        if (one.test && two.test) continue
        if (sharedWords(one.name, two.name) < minSharedWords) continue
        // A new pair of spellings has to include the spelling that changed.
        if (!inScope(scope, one.file) && !inScope(scope, two.file)) continue
        const score = nameScore(one.name, two.name)
        if (score < minScore) continue

        // Shape of the pair, measured over 1,864 judged candidates:
        //
        //   identical words            7 judged    5 findings    71%
        //   subset, one word differs 451 judged   11 findings   2.4%
        //   neither of those        1,406 judged    1 finding   0.07%
        //
        // The dropped buckets cost 75% of the API spend for 6% of the findings.
        // What separates them is the KIND of word that differs: `custom`,
        // `review` and `multi` name different things, while case, word order and
        // an accessor verb like `get` or `calculate` do not distinguish anything.
        // That is a judgement the filter may make, because it is about shape
        // rather than about which of two names is right.
        if (!worthJudging(one.name, two.name)) continue

        pairs.push({ left, right, score })
      }
    }
  }

  return pairs
    .sort((a, b) => b.score - a.score || a.left - b.left || a.right - b.right)
    .flatMap((pair) => {
      const one = units[pair.left]
      const two = units[pair.right]
      if (one === undefined || two === undefined) return []
      return [makeCluster([one, two], false, pair.score)]
    })
}

export const namingDrift = defineRule({
  id: spec.ruleId,
  severity: spec.severity,
  description: "Two spellings of one concept across files.",
  judged: true,
  run: Effect.fn("joggle/naming-drift")(function* (workspace, scope, context) {
    const clusters = find(workspace, scope)
    if (clusters.length === 0) {
      return outcome([], [
        "no two exported names were near enough to be worth judging",
      ])
    }
    const budget = policy.namingDrift.maxClusters
    const { diagnostics: findings, drops } = yield* assessClusters(
      spec,
      workspace.imports,
      clusters.slice(0, budget),
      layersFrom(context.config),
    )
    const unjudged = clusters.slice(budget)
    return outcome(
      findings,
      budgetNote("pairs", budget, clusters.length, unjudged.slice(0, 3).map((cluster) => nameList(cluster))),
      drops,
    )
  }),
})
