import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { Service as Judge, type JudgeRequest, type JudgeResult } from "../judge.ts"
import { choiceOf, declined, finding, marginOf, noulOf, qualityOf } from "../rule.ts"
import { duplicateVocabulary } from "../vocabulary.ts"
import type { Answer, Diagnostic, Drop, DropStage, Question, Severity } from "../schema.ts"
import { namesOf, type Cluster } from "../cluster.ts"
import type { ImportGraph } from "../imports.ts"
import type { Unit } from "../workspace.ts"

/** What a rule decided about one cluster. */
export interface ClusterVerdict {
  /** Index into the described members to keep, or undefined to leave it alone. */
  readonly keep: number | undefined
  readonly confidence: number
  readonly score: number
  /** Winner minus runner-up in the verdict's own distribution. */
  readonly margin: number
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
        criteria: duplicateVocabulary.redundant,
      },
      verdict: {
        type: "choice",
        instructions: {
          question: "What should happen to these declarations?",
          fallback: "Choose \`no_issue\` when the similarity is coincidence rather than repetition.",
          compare: ["{candidate}declarations"],
          focus: cluster.identical
            ? `They are syntactically identical, including property names and types.${note}`
            : `They are up to ${Math.round(cluster.overlap * 100)}% structurally similar but not identical.${note}`,
        },
        criteria: duplicateVocabulary.verdict,
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
      const margin = marginOf(answers, "verdict") ?? 1
      // `keep_variants` is a decision about the declarations; a decline is a
      // decision about the question. Both suppress the finding, and only the
      // second says the rule should not have asked.
      if (verdict.choice === "keep_variants" || declined(verdict.choice)) {
        return { keep: undefined, confidence: verdict.confidence, score, margin }
      }
      const canonical = choiceOf(answers, "canonical")
      const index =
        canonical === undefined ? 0 : Number.parseInt(canonical.choice.replace("member_", ""), 10)
      return {
        keep: Number.isNaN(index) ? 0 : index,
        confidence: verdict.confidence,
        score,
        margin,
      }
    },
  }
}

const memberList = (units: ReadonlyArray<Unit>): string => {
  const shown = units.slice(0, policy.evidence.maxListedPaths)
  const rest = units.length - shown.length
  const listed = shown.map((unit) => `${unit.file}:${unit.location.line}`).join(", ")
  return rest > 0 ? `${listed} and ${rest} more` : listed
}

/**
 * A stable name for a finding, for comparing one run against the next.
 *
 * Membership and the kept symbol, never line numbers: code moves constantly and
 * a baseline that reports every edit as new is a baseline nobody reads.
 */
const identityOf = (ruleId: string, cluster: Cluster, keep: Unit): string =>
  [ruleId, keep.name, ...[...new Set(cluster.members.map((m) => m.file))].sort()].join("\u0000")

/** No judgement available: report the fact, say so, and never guess a canonical. */
export const unverifiedFinding = (
  rule: ClusterRule,
  cluster: Cluster,
  reason = "no judgement was available",
): Diagnostic | undefined => {
  const keep = cluster.members[0]
  const drops = cluster.members.slice(1)
  const first = drops[0]
  if (keep === undefined || first === undefined) return undefined
  return finding({
    ruleId: rule.ruleId,
    severity: rule.severity,
    message: `${rule.subject(cluster)}.`,
    help: `Keep \`${keep.name}\` (${keep.file}:${keep.location.line}) and import it elsewhere. Not verified: ${reason}. Duplicates: ${memberList(drops)}.`,
    location: first.location,
    identity: identityOf(rule.ruleId, cluster, keep),
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
/**
 * A candidate the rule looked at and did not report.
 *
 * Returned alongside the finding rather than counted separately, so the reason a
 * candidate was dropped is produced by the same code that decides to drop it. A
 * second pass that re-derives the reason is a second chance to disagree.
 */
export const dropOf = (
  rule: ClusterRule,
  cluster: Cluster,
  stage: DropStage,
  reason: string,
): Drop => ({ ruleId: rule.ruleId, subject: rule.subject(cluster), stage, reason })

/** Either a finding, or the reason there is none. Never both. */
export interface Result {
  readonly diagnostic?: Diagnostic
  readonly drop?: Drop
}

export const findingFor = (
  rule: ClusterRule,
  imports: ImportGraph,
  cluster: Cluster,
  verdict: ClusterVerdict | undefined,
): Result => {
  if (verdict === undefined) {
    const fallback = rule.onUnavailable === "report" ? unverifiedFinding(rule, cluster) : undefined
    return fallback === undefined
      ? { drop: dropOf(rule, cluster, "unreadable", "no judgement available") }
      : { diagnostic: fallback }
  }
  if (verdict.keep === undefined) {
    return { drop: dropOf(rule, cluster, "declined", "the model found nothing to change") }
  }

  // A verdict that fails its gates is not a worse verdict, it is not a verdict.
  // Handling it exactly like an absent answer means one gate serves every rule,
  // and each rule keeps the degrade behaviour it already declared: a provable
  // finding is still reported, marked unverified with the reason; a guessed one
  // stays silent. The gate never has to know which rule it is in.
  const quality = qualityOf(verdict)
  if (!quality.usable) {
    const fallback =
      rule.onUnavailable === "report" ? unverifiedFinding(rule, cluster, quality.reason) : undefined
    return fallback === undefined
      ? { drop: dropOf(rule, cluster, "gated", quality.reason) }
      : { diagnostic: fallback }
  }

  const keep = cluster.members[verdict.keep] ?? cluster.members[0]
  if (keep === undefined) {
    return { drop: dropOf(rule, cluster, "no_evidence", "the chosen member is not in the cluster") }
  }
  const drops = cluster.members.filter((member) => member !== keep)
  const first = drops[0]
  if (first === undefined) {
    return { drop: dropOf(rule, cluster, "no_evidence", "keeping every member leaves nothing to drop") }
  }

  const names = namesOf(cluster)
  const extra =
    names.length > 1 ? ` (also named ${names.filter((name) => name !== keep.name).join(", ")})` : ""
  return {
    diagnostic: finding({
      ruleId: rule.ruleId,
      severity: rule.severity,
      message: `${rule.subject(cluster)} — keep \`${keep.name}\` in ${keep.file}:${keep.location.line}${extra}.`,
      help: `Delete or import instead of redeclaring: ${memberList(drops)}. ${dependents(imports, keep)}.`,
      location: first.location,
      identity: identityOf(rule.ruleId, cluster, keep),
      confidence: verdict.confidence,
      score: verdict.score,
      judged: true,
    }),
  }
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
/** What a rule's assistant pass produced: the findings, and the funnel. */
export interface Assessment {
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly drops: ReadonlyArray<Drop>
}

export const assessClusters = (
  rule: ClusterRule,
  imports: ImportGraph,
  clusters: ReadonlyArray<Cluster>,
): Effect.Effect<Assessment, import("../schema.ts").JudgeError, Judge> =>
  Effect.gen(function* () {
    const unreadable: Array<Drop> = []
    const plans = clusters
      .map((cluster) => {
        const plan = planCluster(rule, cluster)
        if (plan === undefined) {
          unreadable.push(
            dropOf(rule, cluster, "no_evidence", "no member could be described to the model"),
          )
        }
        return plan
      })
      .filter((plan): plan is ClusterPlan => plan !== undefined)
    if (plans.length === 0) return { diagnostics: [], drops: unreadable }
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
    const drops: Array<Drop> = [...unreadable]
    if (Option.isNone(asked)) {
      for (const plan of plans) {
        const fallback = unverifiedFinding(rule, plan.cluster)
        if (fallback !== undefined) diagnostics.push(fallback)
        else drops.push(dropOf(rule, plan.cluster, "unreadable", "no judgement available"))
      }
      return { diagnostics, drops }
    }
    const results = asked.value
    plans.forEach((plan, index) => {
      const result = results[index]
      const verdict = result === undefined ? undefined : plan.read(result.answers)
      const outcome = findingFor(rule, imports, plan.cluster, verdict)
      if (outcome.diagnostic !== undefined) diagnostics.push(outcome.diagnostic)
      if (outcome.drop !== undefined) drops.push(outcome.drop)
    })
    return { diagnostics, drops }
  })
