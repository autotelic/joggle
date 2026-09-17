import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { Service as Judge, type JudgeResult } from "../judge.ts"
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
  readonly read: (
    answers: Readonly<Record<string, Answer>>,
  ) => ClusterVerdict | undefined
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
    criteria[`member_${index}`] = `Keep \`member_${index}\`: \`${member.name}\`, ${member.kind}, in ${member.file}.`
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
          compare: ["`declarations`"],
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
      return {
        keep: Number.isNaN(index) ? 0 : index,
        confidence: verdict.confidence,
        score,
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
  const more = files.length > policy.evidence.maxListedPaths ? ` and ${files.length - policy.evidence.maxListedPaths} more` : ""
  return `${files.length} file${files.length === 1 ? "" : "s"} import \`${unit.name}\`: ${shown}${more}`
}

export const assessCluster = (rule: ClusterRule, imports: ImportGraph) =>
  Effect.fn(`joggle/${rule.ruleId}.assess`)(function* (cluster: Cluster) {
    const described = describedMembers(cluster)
    const questionnaire = rule.questionnaire(cluster, described)
    const judge = yield* Judge
    const request = judge.ask({
      evidence: { ...baseEvidence(cluster, described), ...questionnaire.state },
      questions: questionnaire.questions,
    })

    const answer = rule.onUnavailable === "propagate"
      ? // Let the failure through so the engine records the rule as skipped.
        (yield* request).answers
      : yield* request.pipe(
          Effect.map((result) => result.answers),
          Effect.catch(() => Effect.succeed(undefined)),
        )

    if (answer === undefined) {
      const fallback = unverifiedFinding(rule, cluster)
      return fallback === undefined ? Option.none<Diagnostic>() : Option.some(fallback)
    }

    const verdict = questionnaire.read(answer)
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
  })
