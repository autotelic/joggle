import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { Service as Judge, type JudgeRequest, type JudgeResult } from "../judge.ts"
import { choiceOf, finding, noulOf } from "../rule.ts"
import type { Answer, Diagnostic, Question, Severity } from "../schema.ts"
import { namesOf, type Cluster } from "../cluster.ts"
import type { ImportGraph } from "../imports.ts"
import type { Unit } from "../workspace.ts"

/** What a rule decided about one cluster. */
export interface ClusterVerdict {
  /** Index into the described members to keep, or undefined to leave it alone. */
  readonly keep: number | undefined
  readonly confidence: number
  readonly score: number
}

/**
 * A rule's question about one cluster, the state it needs, and how to read the
 * answer.
 *
 * This seam exists because a shared question set is a real hazard, not a
 * simplification. When every rule asked the same "is one of these redundant?",
 * naming-drift was asking it about two declarations with different names and
 * different bodies, and the model -- correctly -- said no. Across 1,864 name
 * candidates that produced six findings. The rule was never starved of budget;
 * it was asked the wrong question, and the answer was right.
 *
 * Question text refers to the candidate as `{candidate}`. That marker is what
 * lets one request hold many candidates: the judge rewrites it to
 * `candidates[3].` and the questions stay unambiguous.
 */
export interface Questionnaire {
  /** Merged into the request state alongside `declarations`. */
  readonly state: Record<string, unknown>
  readonly questions: Record<string, Question>
  /**
   * Read the answer, or return undefined when the response did not contain one
   * that can be used. That is not the same as "leave it alone": an unreadable
   * response cannot be claimed as a judgement, and for a fact-based rule it means
   * the finding is reported unverified rather than quietly dropped.
   */
  readonly read: (answers: Readonly<Record<string, Answer>>) => ClusterVerdict | undefined
}

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
  readonly questionnaire: (cluster: Cluster, described: ReadonlyArray<Unit>) => Questionnaire
}

/** The members actually described to the model: a prefix, so ids stay aligned. */
export const describedMembers = (cluster: Cluster): ReadonlyArray<Unit> =>
  cluster.members.slice(0, policy.evidence.maxMembers)

/** The evidence every rule sends: the declarations themselves, bounded. */
export const baseEvidence = (cluster: Cluster, described: ReadonlyArray<Unit>) => ({
  declarations: described.map((member, index) => ({
    id: `member_${index}`,
    symbol: member.name,
    kind: member.kind,
    path: member.file,
    line: member.location.line,
    source: member.text.slice(0, policy.evidence.maxSourceChars),
    documented: member.doc !== undefined,
    doc: member.doc?.slice(0, policy.evidence.maxDocChars) ?? null,
    types: member.typeRefs,
  })),
  count: cluster.members.length,
  described: described.length,
})

const describedNote = (cluster: Cluster, described: ReadonlyArray<Unit>): string =>
  described.length < cluster.members.length
    ? ` The cluster has ${cluster.members.length} members in total; only ${described.length} are shown, and only those can be chosen.`
    : ""

/**
 * The shared question for exact and near duplicates: is one of these redundant?
 *
 * Both rules ask it because for them it is the same question -- the declarations
 * are the same shape or near enough that the only thing left is intent.
 */
export const collapseQuestionnaire: ClusterRule["questionnaire"] = (cluster, described) => {
  const criteria: Record<string, string> = {}
  described.forEach((member, index) => {
    criteria[`member_${index}`] =
      `Keep member_${index}: ${member.name}, ${member.kind}, in ${member.file}.`
  })
  const note = describedNote(cluster, described)
  return {
    state: { identical: cluster.identical, overlap: Number(cluster.overlap.toFixed(3)) },
    questions: {
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
          compare: ["{candidate}declarations"],
          focus: cluster.identical
            ? `They are syntactically identical, including property names and types.${note}`
            : `They are up to ${Math.round(cluster.overlap * 100)}% structurally similar but not identical.${note}`,
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
    },
    read: (answers) => {
      const verdict = choiceOf(answers, "verdict")
      const redundant = noulOf(answers, "redundant")
      if (verdict === undefined) return undefined
      const score = redundant ?? verdict.confidence
      if (verdict.choice === "keep_variants" || verdict.choice === "not_duplication") {
        return { keep: undefined, confidence: verdict.confidence, score }
      }
      const canonical = choiceOf(answers, "canonical")
      const index =
        canonical === undefined ? 0 : Number.parseInt(canonical.choice.replace("member_", ""), 10)
      return { keep: Number.isNaN(index) ? 0 : index, confidence: verdict.confidence, score }
    },
  }
}

const memberList = (units: ReadonlyArray<Unit>): string => {
  const shown = units.slice(0, policy.evidence.maxListedPaths)
  const rest = units.length - shown.length
  const listed = shown.map((unit) => `${unit.file}:${unit.location.line}`).join(", ")
  return rest > 0 ? `${listed} and ${rest} more` : listed
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

/**
 * Who depends on the declaration being kept.
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
  const shown = files.slice(0, policy.evidence.maxListedPaths).join(", ")
  const more =
    files.length > policy.evidence.maxListedPaths
      ? ` and ${files.length - policy.evidence.maxListedPaths} more`
      : ""
  return `${files.length} file${files.length === 1 ? "" : "s"} import \`${unit.name}\`: ${shown}${more}`
}

/** One cluster's request, plus how to read its share of the answer. */
export interface ClusterPlan {
  readonly cluster: Cluster
  readonly request: JudgeRequest
  readonly read: (answers: Readonly<Record<string, Answer>>) => ClusterVerdict | undefined
}

export const planCluster = (rule: ClusterRule, cluster: Cluster): ClusterPlan | undefined => {
  const described = describedMembers(cluster)
  if (described.length === 0) return undefined
  const questionnaire = rule.questionnaire(cluster, described)
  return {
    cluster,
    request: {
      evidence: { ...baseEvidence(cluster, described), ...questionnaire.state },
      questions: questionnaire.questions,
    },
    read: questionnaire.read,
  }
}

/** Turn a verdict into a finding, or into silence. Pure, so it is testable alone. */
export const findingFor = (
  rule: ClusterRule,
  imports: ImportGraph,
  cluster: Cluster,
  verdict: ClusterVerdict | undefined,
): Option.Option<Diagnostic> => {
  if (verdict === undefined) {
    const fallback = rule.onUnavailable === "report" ? unverifiedFinding(rule, cluster) : undefined
    return fallback === undefined ? Option.none<Diagnostic>() : Option.some(fallback)
  }
  if (verdict.keep === undefined) return Option.none<Diagnostic>()

  const keep = cluster.members[verdict.keep] ?? cluster.members[0]
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
      score: verdict.score,
      judged: true,
    }),
  )
}

/**
 * Ask about many clusters and turn the answers into findings.
 *
 * One wire call covers as many clusters as the token budget allows, which is the
 * pattern the parallel-questions cookbook measures at 12.2x cheaper and 10x
 * faster: the state dominates every request, so N single-candidate calls pay for
 * it N times while a batched call pays once. The cache stays per cluster, so
 * adding or removing a question still invalidates only what it must.
 */
export const assessClusters = (
  rule: ClusterRule,
  imports: ImportGraph,
  clusters: ReadonlyArray<Cluster>,
): Effect.Effect<ReadonlyArray<Diagnostic>, import("../schema.ts").JudgeError, Judge> =>
  Effect.gen(function* () {
    const plans = clusters
      .map((cluster) => planCluster(rule, cluster))
      .filter((plan): plan is ClusterPlan => plan !== undefined)
    if (plans.length === 0) return []
    const judge = yield* Judge
    const requests = plans.map((plan) => plan.request)

    // One call for the whole batch, so availability is decided once for the rule
    // rather than once per cluster. A fact-based rule degrades to unverified
    // findings; a guess-based rule stays silent and the engine reports it as
    // skipped.
    const asked =
      rule.onUnavailable === "report"
        ? yield* judge.askMany(requests).pipe(
            Effect.map((results) => Option.some<ReadonlyArray<JudgeResult>>(results)),
            Effect.catch(() => Effect.succeed(Option.none<ReadonlyArray<JudgeResult>>())),
          )
        : yield* judge
            .askMany(requests)
            .pipe(Effect.map((results) => Option.some<ReadonlyArray<JudgeResult>>(results)))

    const diagnostics: Array<Diagnostic> = []
    if (Option.isNone(asked)) {
      for (const plan of plans) {
        const fallback = unverifiedFinding(rule, plan.cluster)
        if (fallback !== undefined) diagnostics.push(fallback)
      }
      return diagnostics
    }
    const results = asked.value
    plans.forEach((plan, index) => {
      const result = results[index]
      const verdict = result === undefined ? undefined : plan.read(result.answers)
      const diagnostic = findingFor(rule, imports, plan.cluster, verdict)
      if (Option.isSome(diagnostic)) diagnostics.push(diagnostic.value)
    })
    return diagnostics
  })
