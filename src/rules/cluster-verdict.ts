import { Effect, Option, Schema } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import { Decision, DecisionModel } from "effect/unstable/ai"
import { isUnreachable } from "../decision.ts"
import { policy } from "../policy.ts"
import { canImport, sharedLayerFor, type Layer } from "../architecture.ts"
import { declined, finding, marginOfAnswer, qualityOf, type DecisionAnswers } from "../rule.ts"
import { duplicateVocabulary } from "../vocabulary.ts"
import type { Diagnostic, Drop, DropStage, Severity } from "../schema.ts"
import { namesOf, type Cluster } from "../cluster.ts"
import type { ImportGraph } from "../imports.ts"
import type { Unit } from "../workspace.ts"

/** What a rule decided about one cluster. */
export interface ClusterVerdict {
  /** Index into the described members to keep, or undefined to leave it alone. */
  readonly keep: number | undefined
  readonly confidence: number
  /** What the report sorts by: how much sharing these would change. */
  readonly score: number
  /**
   * What to do about it, decided in code from `role` and `relationship`.
   *
   * Absent when the model did not answer both, in which case the caller falls
   * back to what the declared layers say -- and to neutral wording when there are
   * none. A repository with no architecture config still gets a prescription.
   */
  readonly prescription?: string | undefined
  /**
   * What the GATE reads: whether this is duplication at all.
   *
   * Kept separate from `score` because they answer different questions, and
   * conflating them would mean a real duplicate nobody cares about gets DROPPED
   * rather than sorted last. A finding that does not matter is still a finding.
   */
  readonly redundancy: number
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
 * Each cluster is its own `DecisionModel.decide`, so the input is that
 * cluster's own evidence and there is no marker to rewrite.
 */
export interface Questionnaire {
  /** Merged into the input alongside `declarations`. */
  readonly state: Record<string, Schema.Json>
  readonly decisions: Record<string, Decision.Any>
  /**
   * Read the answer, or return undefined when the response did not contain one
   * that can be used. That is not the same as "leave it alone": an unreadable
   * response cannot be claimed as a judgement, and for a fact-based rule it means
   * the finding is reported unverified rather than quietly dropped.
   */
  readonly read: (answers: DecisionAnswers) => ClusterVerdict | undefined
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
    state: {
      identical: cluster.identical,
      overlap: Number(cluster.overlap.toFixed(3)),
      // The material a panel would need before judging where a thing belongs.
      // No configuration: the paths are in the graph and the relationships are
      // in the paths.
      files: [...new Set(cluster.members.map((member) => member.file))],
      common_directory: commonDirectory(cluster.members.map((member) => member.file)),
    },
    decisions: {
      redundant: Decision.probability({
        instructions: `Are these ${cluster.members.length} declarations one thing written repeatedly? Answer yes only if a reader is worse off for there being more than one.`,
        criteria: duplicateVocabulary.redundant,
      }),
      role: Decision.classify({
        instructions: [
          "What IS this declaration, apart from the fact that it is duplicated?",
          "Inspect `declarations` and `files`.",
          "Answer about what the declaration IS, not about what should happen to it. Two copies of a wire contract are correct; two copies of a domain concept are the defect. This answer decides which of those this is.",
          "Choose `implementation_detail` when it is a helper with no meaning of its own.",
        ].join("\n"),
        criteria: duplicateVocabulary.role,
      }),
      relationship: Decision.classify({
        instructions: [
          "How do `common_directory` and the files inside it relate?",
          "Inspect `files`.",
          "Decide from the paths whether any of these files could import another. Same directory, same deployable, sibling packages, or separate services.",
          "Choose `different_deployables` when nothing suggests they can share code.",
        ].join("\n"),
        criteria: duplicateVocabulary.relationship,
      }),
      verdict: Decision.classify({
        instructions: [
          "What should happen to these declarations?",
          cluster.identical
            ? `They are syntactically identical, including property names and types.${note}`
            : `They are up to ${Math.round(cluster.overlap * 100)}% structurally similar but not identical.${note}`,
          "Choose `no_issue` when the similarity is coincidence rather than repetition.",
        ].join("\n"),
        criteria: duplicateVocabulary.verdict,
      }),
      consequence: Decision.probability({
        instructions:
          "Would a reader be better off if these declarations were one? Answer about the EFFECT of the duplication, not about whether it exists. Two identical helpers that nobody will ever change are still one thing.",
        criteria: duplicateVocabulary.consequence,
      }),
      canonical: Decision.classify({
        instructions:
          "If one of them should be kept, which one? Choose the declaration that best fits this codebase's conventions, its location, and its name.",
        criteria,
      }),
    },
    read: (answers) => {
      const verdict = answers["verdict"]
      if (verdict === undefined || !("label" in verdict)) return undefined
      const redundant = answers["redundant"]
      const redundancy =
        redundant !== undefined && "probability" in redundant
          ? redundant.probability
          : (verdict.confidence ?? 1)
      const role = answers["role"]
      const relationship = answers["relationship"]
      const prescription =
        role === undefined || !("label" in role) || relationship === undefined || !("label" in relationship)
          ? undefined
          : prescriptionFor(role.label, relationship.label)
      // Ranked by consequence, gated by redundancy. A finding that does not
      // matter is still a finding and still reported; it sorts last.
      const consequence = answers["consequence"]
      const score =
        consequence !== undefined && "probability" in consequence ? consequence.probability : redundancy
      const margin = marginOfAnswer(verdict)
      const confidence = verdict.confidence ?? 1
      // `keep_variants` is a decision about the declarations; a decline is a
      // decision about the question. Both suppress the finding, and only the
      // second says the rule should not have asked.
      if (verdict.label === "keep_variants" || declined(verdict.label)) {
        return { keep: undefined, confidence, score, redundancy, margin, prescription }
      }
      const canonical = answers["canonical"]
      const index =
        canonical === undefined || !("label" in canonical)
          ? 0
          : Number.parseInt(canonical.label.replace("member_", ""), 10)
      return {
        keep: Number.isNaN(index) ? 0 : index,
        confidence,
        score,
        redundancy,
        margin,
        prescription,
      }
    },
  }
}

/** The deepest directory every one of these files sits inside. */
const commonDirectory = (paths: ReadonlyArray<string>): string => {
  const split = paths.map((file) => file.split("/").slice(0, -1))
  const first = split[0]
  if (first === undefined) return "."
  let depth = 0
  for (let index = 0; index < first.length; index += 1) {
    if (split.every((parts) => parts[index] === first[index])) depth = index + 1
    else break
  }
  return depth === 0 ? "." : first.slice(0, depth).join("/")
}

/**
 * What to do about it, from what the declaration IS and how the files relate.
 *
 * This is the whole judgement, and it is decided in code. The model answers two
 * questions it can actually answer -- what is this, and how do these files
 * relate -- and the prescription follows from the pair. No repository has to
 * declare its boundaries for this to work, which is the point: a hand-maintained
 * map of a codebase's architecture goes stale the moment someone moves a
 * directory, and the paths say the same thing for free.
 *
 * The two rows that matter are the same duplication with opposite answers. A
 * wire contract repeated across a service boundary is CORRECT -- two services
 * share a shape, not a module. A domain concept repeated across one is the
 * defect the architecture exists to prevent.
 */
export const prescriptionFor = (role: string, relationship: string): string => {
  if (relationship === "same_module" || relationship === "same_package") {
    return "Delete the copies and import one: these files can reach each other."
  }
  if (role === "wire_contract") {
    return "Expected. A contract that crosses a deployable boundary is duplicated by design: give it a shared contracts package if the two must agree, and leave it alone if they must not."
  }
  if (role === "domain_concept") {
    return "The same concept in two deployables that cannot import each other, which is the case a shared package exists for. Move the concept into one both depend on."
  }
  if (role === "framework_glue") {
    return "Framework shapes are repeated per file by construction. If these are framework glue, leave them."
  }
  return "Different deployables and not a contract: hoist the shared part into a package both can depend on, or accept the duplication."
}

/**
 * What to do about it, given who may import whom.
 *
 * Used when there is no judgement to read a role from -- an unverified finding
 * still deserves advice -- and when a repository has declared its layers, which
 * is a fact worth using even though it is no longer required.
 *
 * "Delete the copies and import one" is only advice if the copies can reach the
 * one being kept, and across a package boundary they usually cannot. On one
 * repository 78 of 261 duplicate findings told a Remix app to import a type from
 * a Fastify service, and 67 of those were the frontend and the backend pointing
 * at each other. The duplication was real and the prescription was impossible,
 * which is the worst combination: a reader who tries it learns to ignore the
 * tool.
 *
 * The relationship is decidable from the declared layers, so it is decided here
 * rather than asked about. The model answers whether the declarations are one
 * thing; where the one thing should LIVE is a fact about the repository.
 */
const prescription = (
  layers: ReadonlyArray<Layer>,
  cluster: Cluster,
  keep: Unit,
  drops: ReadonlyArray<Unit>,
): string => {
  if (drops.every((unit) => canImport(layers, unit.file, keep.file))) {
    return `Delete or import instead of redeclaring: ${memberList(drops)}.`
  }
  const shared = sharedLayerFor(
    layers,
    cluster.members.map((member) => member.file),
  )
  if (shared !== undefined) {
    return `None of these may import the others, so hoist the declaration into ${shared.name} and import it from all of them: ${memberList(drops)}.`
  }
  return `These sit in layers that cannot see each other and share nothing below them. Extract a shared package, or accept the duplication as a contract: ${memberList(drops)}.`
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
    help: `Keep \`${keep.name}\` (${keep.file}:${keep.location.line}) and import it elsewhere. Not verified: ${reason}.${shapeOnlyNote(cluster)} Duplicates: ${memberList(drops)}.`,
    location: first.location,
    identity: identityOf(rule.ruleId, cluster, keep),
    judged: false,
  })
}

/**
 * The caveat a shape-only cluster earns.
 *
 * Empty when the cluster has types to stand on. Otherwise it says what the
 * finding actually rests on, because in a JavaScript codebase this is the COMMON
 * case rather than the exception: nothing in the declaration says what it
 * operates on, so two shapes matching is all the evidence there is. The finding
 * is still true; saying what it rests on is the difference between a weaker
 * finding and a misleading one.
 */
const shapeOnlyNote = (cluster: Cluster): string =>
  cluster.typed
    ? ""
    : " No member carries a type annotation, so only the shape could be compared."

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

/** One cluster's Decision definition, plus how to read its share of the answer. */
export interface ClusterPlan {
  readonly cluster: Cluster
  readonly input: Schema.Json
  readonly decisions: Record<string, Decision.Any>
  readonly read: (answers: DecisionAnswers) => ClusterVerdict | undefined
}

export const planCluster = (rule: ClusterRule, cluster: Cluster): ClusterPlan | undefined => {
  const described = describedMembers(cluster)
  if (described.length === 0) return undefined
  const questionnaire = rule.questionnaire(cluster, described)
  return {
    cluster,
    input: { ...baseEvidence(cluster, described), ...questionnaire.state },
    decisions: questionnaire.decisions,
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
  layers: ReadonlyArray<Layer>,
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
  const quality = qualityOf({ score: verdict.redundancy, margin: verdict.margin })
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
      // The model's answer when there is one, the declared layers when there are
      // not. A repository that configures nothing still gets advice.
      help: `${verdict.prescription ?? prescription(layers, cluster, keep, drops)}${shapeOnlyNote(cluster)} ${dependents(imports, keep)}.`,
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
  layers: ReadonlyArray<Layer> = [],
): Effect.Effect<Assessment, AiError.AiError, DecisionModel.DecisionModel> =>
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

    // One DecisionModel.decide per cluster. A fact-based rule still reports its
    // facts when the model was never reached; a guess-based rule steps aside and
    // the engine reports it as skipped.
    const answers = yield* Effect.forEach(
      plans,
      (plan) => {
        const definition = Decision.make({ input: Schema.Json, decisions: plan.decisions })
        return DecisionModel.decide(definition, { input: plan.input }).pipe(
          Effect.map((result) => Option.some(result.answers)),
          Effect.catch((error) =>
            rule.onUnavailable === "report" || !isUnreachable(error)
              ? Effect.succeed(Option.none<DecisionAnswers>())
              : Effect.fail(error),
          ),
        )
      },
      { concurrency: policy.judge.requestConcurrency },
    )

    const diagnostics: Array<Diagnostic> = []
    const drops: Array<Drop> = [...unreadable]
    plans.forEach((plan, index) => {
      const answer = answers[index]
      const verdict = answer === undefined || Option.isNone(answer) ? undefined : plan.read(answer.value)
      const outcome = findingFor(rule, imports, plan.cluster, verdict, layers)
      if (outcome.diagnostic !== undefined) diagnostics.push(outcome.diagnostic)
      if (outcome.drop !== undefined) drops.push(outcome.drop)
    })
    return { diagnostics, drops }
  })
