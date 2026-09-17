import { Effect, Option } from "effect"
import { Service as Judge, type JudgeResult } from "../judge.ts"
import { choiceOf, finding, noulOf } from "../rule.ts"
import type { Diagnostic, Question, Severity } from "../schema.ts"
import { namesOf, type Cluster } from "../cluster.ts"
import type { ImportGraph } from "../imports.ts"
import type { Unit } from "../workspace.ts"

/** What a rule has to supply for its clusters to be judged the same way. */
export interface ClusterRule {
  readonly ruleId: string
  readonly severity: Severity
  /**
   * What to do when no judgement is available.
   *
   * `report` is for rules whose finding is a fact -- exact shape equality is
   * provable, so an unjudged cluster is still worth a reader's attention.
   * `propagate` is for rules whose finding is a guess; without a judgement there
   * is nothing to stand on, so the rule stays silent and the engine reports it
   * as skipped rather than inventing a candidate.
   */
  readonly onUnavailable: "report" | "propagate"
  /** How to say what the cluster is, for the finding's first line. */
  readonly subject: (cluster: Cluster) => string
}

const evidenceOf = (cluster: Cluster) => ({
  declarations: cluster.members.map((member, index) => ({
    id: `member_${index}`,
    symbol: member.name,
    kind: member.kind,
    path: member.file,
    line: member.location.line,
    source: member.text,
  })),
  count: cluster.members.length,
  identical: cluster.identical,
  overlap: Number(cluster.overlap.toFixed(3)),
})

/**
 * Three questions about one cluster, in one request.
 *
 * A Noul for the ranking score, a Choice for the action, and a Choice for which
 * member survives. Asking them together is what makes clusters cheaper than the
 * pairs they replace: a five-copy family is one request instead of four.
 */
const questionsFor = (cluster: Cluster): Record<string, Question> => {
  const criteria: Record<string, string> = {}
  cluster.members.forEach((member, index) => {
    criteria[`member_${index}`] = `Keep \`member_${index}\`: \`${member.name}\`, ${member.kind}, in ${member.file}.`
  })
  return {
    redundant: {
      type: "noul",
      instructions: {
        question: `Are these ${cluster.members.length} declarations one thing written repeatedly?`,
        focus: "Answer yes only if a reader is worse off for there being more than one.",
      },
      criteria: {
        true: "One declaration would serve better than several.",
        false: "The repetition is justified.",
      },
    },
    verdict: {
      type: "choice",
      instructions: {
        question: "What should happen to these declarations?",
        compare: ["`declarations`"],
        focus: cluster.identical
          ? "They are syntactically identical, including property names and types."
          : `They are up to ${Math.round(cluster.overlap * 100)}% structurally similar but not identical.`,
      },
      criteria: {
        collapse: "They are one thing. Keep one of them and delete the rest.",
        keep_variants:
          "Related but deliberately separate, such as a special case of a general routine. Keep them all.",
        not_duplication: "Coincidentally similar. They are different things. Change nothing.",
      },
    },
    canonical: {
      type: "choice",
      instructions: {
        question: "If one of them should be kept, which one?",
        focus: "Choose the declaration that best fits this codebase's conventions, its location, and its name.",
      },
      criteria,
    },
  }
}

const memberList = (units: ReadonlyArray<Unit>): string =>
  units.map((unit) => `${unit.file}:${unit.location.line}`).join(", ")

/**
 * Who depends on the declaration being deleted.
 *
 * This is the sentence that used to be a wish. "Keep X and import it here" is
 * only true advice if we know what imports the copy going away, and until the
 * graph existed we had never checked.
 */
const dependents = (imports: ImportGraph, unit: Unit): string => {
  const named = imports.importersOfName(unit.file, unit.name)
  const files = [...new Set(named.map((edge) => edge.from))]
  if (files.length === 0) {
    return imports.importersOf.get(unit.file) === undefined
      ? "nothing in the analysed set imports this file"
      : `no file imports \`${unit.name}\` by name`
  }
  const shown = files.slice(0, 4).join(", ")
  const more = files.length > 4 ? ` and ${files.length - 4} more` : ""
  return `${files.length} file${files.length === 1 ? "" : "s"} import \`${unit.name}\`: ${shown}${more}`
}

/** No judgement available: report the fact, say so, and never guess a canonical. */
export const unverifiedFinding = (rule: ClusterRule, cluster: Cluster): Diagnostic | undefined => {
  const keep = cluster.members[0]
  const drops = cluster.members.slice(1)
  const first = drops[0]
  if (keep === undefined || first === undefined) return undefined
  return finding({
    ruleId: rule.ruleId,
    severity: rule.severity,
    message: `${rule.subject(cluster)}.`,
    help: `Keep \`${keep.name}\` (${keep.file}:${keep.location.line}) and import it elsewhere. Not verified: no judgement was available. Duplicates: ${memberList(drops)}.`,
    location: first.location,
    judged: false,
  })
}

/** Turn answers into a finding, or into silence. Pure, so it is testable alone. */
const decideWith = (
  rule: ClusterRule,
  cluster: Cluster,
  imports: ImportGraph,
  answers: Readonly<Record<string, import("../schema.ts").Answer>>,
): Option.Option<Diagnostic> => {
  const verdict = choiceOf(answers, "verdict")
  if (verdict === undefined) {
    const fallback = rule.onUnavailable === "report" ? unverifiedFinding(rule, cluster) : undefined
    return fallback === undefined ? Option.none<Diagnostic>() : Option.some(fallback)
  }
  if (verdict.choice === "keep_variants" || verdict.choice === "not_duplication") {
    return Option.none<Diagnostic>()
  }

  const canonical = choiceOf(answers, "canonical")
  const index = canonical === undefined ? 0 : Number.parseInt(canonical.choice.replace("member_", ""), 10)
  const keep = (Number.isNaN(index) ? undefined : cluster.members[index]) ?? cluster.members[0]
  if (keep === undefined) return Option.none<Diagnostic>()

  const drops = cluster.members.filter((member) => member !== keep)
  const first = drops[0]
  if (first === undefined) return Option.none<Diagnostic>()

  const names = namesOf(cluster)
  const extra =
    names.length > 1 ? ` (also named ${names.filter((name) => name !== keep.name).join(", ")})` : ""
  return Option.some(
    finding({
      ruleId: rule.ruleId,
      severity: rule.severity,
      message: `${rule.subject(cluster)} — keep \`${keep.name}\` in ${keep.file}:${keep.location.line}${extra}.`,
      help: `Delete or import instead of redeclaring: ${memberList(drops)}. ${dependents(imports, keep)}.`,
      location: first.location,
      confidence: verdict.confidence,
      score: noulOf(answers, "redundant") ?? verdict.confidence,
      judged: true,
    }),
  )
}

export const assessCluster = (rule: ClusterRule, imports: ImportGraph) =>
  Effect.fn(`joggle/${rule.ruleId}.assess`)(function* (cluster: Cluster) {
    const judge = yield* Judge
    const request = judge.ask({ evidence: evidenceOf(cluster), questions: questionsFor(cluster) })

    if (rule.onUnavailable === "propagate") {
      // Let the failure through so the engine records the rule as skipped.
      const result = yield* request
      return decideWith(rule, cluster, imports, result.answers)
    }

    const outcome = yield* request.pipe(
      Effect.map((result) => Option.some<JudgeResult>(result)),
      Effect.catch(() => Effect.succeed(Option.none<JudgeResult>())),
    )
    if (Option.isNone(outcome)) {
      const fallback = unverifiedFinding(rule, cluster)
      return fallback === undefined ? Option.none<Diagnostic>() : Option.some(fallback)
    }
    return decideWith(rule, cluster, imports, outcome.value.answers)
  })
