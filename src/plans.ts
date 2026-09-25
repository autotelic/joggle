import { Context, Effect, Option, Schema } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import { Decision, DecisionModel } from "effect/unstable/ai"
import { Atoms } from "./atoms.ts"
import { canonical } from "./canonical.ts"
import { policy } from "./policy.ts"
import { shortHash } from "./state.ts"
import type { DecisionAnswers } from "./rule.ts"

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One candidate's questions, and how to read the answers.
 *
 * A plan carries atoms and decisions, not state and questions, and that is what
 * makes it mergeable. The decisions reference the atoms by id, as
 * `atoms[a1b2].source` -- the TypeSafe docs' "reference specific fields" rule with
 * a content-addressed path -- so any set of plans can be answered against the
 * union of their atoms without rewriting an instruction.
 *
 * The plan is the seam between deciding what to ask and asking it. A rule builds
 * plans from the shared atoms; the engine answers them, batched, and hands each
 * plan its own answers back.
 */
export interface Plan<A> {
  readonly ruleId: string
  /** How the rule names this candidate, for a drop. */
  readonly subject: string
  /**
   * The files this candidate is about.
   *
   * The engine judges a candidate only when one of its files is in the run's
   * scope. A rule that forgets to filter therefore cannot spend a token on a
   * candidate the run is not about, and cannot act on one either: an out-of-scope
   * plan is never sent and its answer is never read.
   */
  readonly concerns: ReadonlyArray<string>
  /** The atoms every decision in this plan references. */
  readonly atoms: ReadonlyArray<string>
  readonly decisions: Record<string, Decision.Any>
  /**
   * Per decision, the labels that mean "this rule is violated".
   *
   * The same declaration the read uses via `verdictOf`, made data so calibration
   * can reduce an answer without re-deriving the rule's intent. A Noul needs no
   * entry: its probability is already the violation.
   */
  readonly violations?: Readonly<Record<string, ReadonlyArray<string>>> | undefined
  readonly read: (answers: DecisionAnswers) => A | undefined
}

/* -------------------------------------------------------------------------- */
/* The answer cache                                                            */
/* -------------------------------------------------------------------------- */

/** The answer to one question, keyed by the question and the atoms it read. */
export interface PlanAnswerStore {
  readonly get: (key: string) => Effect.Effect<Option.Option<Decision.Answer<Decision.Any>>>
  readonly put: (key: string, answer: Decision.Answer<Decision.Any>) => Effect.Effect<void>
}

export class PlanAnswers extends Context.Service<PlanAnswers, PlanAnswerStore>()("@joggle/PlanAnswers") {}

/**
 * One cached answer, on disk.
 *
 * The `kind` field is added so the decoder can tell the three answer shapes
 * apart. Without it, a Rate answer would satisfy the Classify schema -- it has a
 * `label` and a `probabilities` -- and its `rating` would be dropped silently on
 * the way back in.
 */
export const StoredAnswer = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("Rate"),
    rating: Schema.Number,
    label: Schema.String,
    probabilities: Schema.Record(Schema.String, Schema.Number),
    confidence: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal("Classify"),
    label: Schema.String,
    probabilities: Schema.Record(Schema.String, Schema.Number),
    confidence: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({ kind: Schema.Literal("Probability"), probability: Schema.Number }),
])

export type StoredAnswer = Schema.Schema.Type<typeof StoredAnswer>

/** The stored form of an answer, for the cache file. */
export const storedOf = (answer: Decision.Answer<Decision.Any>): StoredAnswer => {
  if ("probability" in answer) return { kind: "Probability", probability: answer.probability }
  if ("rating" in answer) {
    const rate = {
      kind: "Rate" as const,
      rating: answer.rating,
      label: answer.label,
      probabilities: answer.probabilities,
    }
    return answer.confidence === undefined ? rate : { ...rate, confidence: answer.confidence }
  }
  const classify = {
    kind: "Classify" as const,
    label: answer.label,
    probabilities: answer.probabilities,
  }
  return answer.confidence === undefined ? classify : { ...classify, confidence: answer.confidence }
}

/** The answer back from its stored form. */
export const answerOf = (stored: StoredAnswer): Decision.Answer<Decision.Any> => {
  if (stored.kind === "Probability") return { probability: stored.probability }
  if (stored.kind === "Rate") {
    const rate = {
      rating: stored.rating,
      label: stored.label,
      probabilities: stored.probabilities,
    }
    return stored.confidence === undefined ? rate : { ...rate, confidence: stored.confidence }
  }
  const classify = { label: stored.label, probabilities: stored.probabilities }
  return stored.confidence === undefined ? classify : { ...classify, confidence: stored.confidence }
}

/**
 * The key of one question's answer: the question, the atoms it read, and the
 * model.
 *
 * Per question rather than per request, which is the whole reason a batched call
 * does not lose cache granularity: adding a question to a request leaves every
 * other question's key unchanged, and so does changing a declaration the other
 * questions do not name.
 */
export const answerKeyFor = (decision: Decision.Any, material: unknown): string =>
  shortHash(
    canonical({
      model: policy.model,
      decisionVersion: policy.decisionVersion,
      decision,
      material,
    }),
  )

/** The provider's shape for one answer, so a cached answer can be re-validated. */
const asProviderAnswer = (
  decision: Decision.Any,
  answer: Decision.Answer<Decision.Any>,
): Option.Option<DecisionModel.ProviderAnswer> => {
  if (decision._tag === "Probability") {
    return "probability" in answer
      ? Option.some({ _tag: "Probability", probability: answer.probability })
      : Option.none()
  }
  if (!("label" in answer) || !("probabilities" in answer)) return Option.none()
  if (decision._tag === "Classify") {
    const base = { _tag: "Classify" as const, label: answer.label, probabilities: answer.probabilities }
    return Option.some(answer.confidence === undefined ? base : { ...base, confidence: answer.confidence })
  }
  if (!("rating" in answer)) return Option.none()
  const base = { _tag: "Rate" as const, rating: answer.rating, probabilities: answer.probabilities }
  return Option.some(answer.confidence === undefined ? base : { ...base, confidence: answer.confidence })
}

/**
 * Validate a cached answer through the same model that validated it when it was
 * first received.
 *
 * The cache is a file on disk, so a cached answer is not automatically a valid
 * one. Re-building a `DecisionModel` whose provider is the cache and asking it to
 * answer the question again runs Effect's own checks -- labels inside the
 * criteria, distributions summing to one, ratings in range -- without a second
 * implementation of them here. An answer that fails is a miss, not a wrong one.
 */
const revalidate = (
  decision: Decision.Any,
  answer: Decision.Answer<Decision.Any>,
): Effect.Effect<Option.Option<Decision.Answer<Decision.Any>>> =>
  Effect.gen(function* () {
    const provider = asProviderAnswer(decision, answer)
    if (Option.isNone(provider)) return Option.none()
    const model = yield* DecisionModel.make({
      decide: () =>
        Effect.succeed({
          answers: { q: provider.value },
          usage: { inputTokens: undefined, outputTokens: undefined },
        }),
    })
    const definition = Decision.make({ input: Schema.Json, decisions: { q: decision } })
    const decided = yield* model.decide(definition, { input: null }).pipe(Effect.orElseSucceed(() => undefined))
    if (decided === undefined) return Option.none()
    const validated = decided.answers["q"]
    return validated === undefined ? Option.none() : Option.some(validated)
  })

/**
 * A DecisionModel that remembers every answer, one decision at a time.
 *
 * The wire cache remembers a whole REQUEST, and that cannot be the replay path:
 * its key changes when any question in the request changes, and the file it
 * writes is far too large to commit. This remembers one answer at a time, keyed
 * by the decision and the state it was answered against, so a reviewed verdict
 * replays with no key and no tokens, and a request whose questions are all
 * remembered never reaches the model at all.
 *
 * A cached answer is validated through the same checks the provider's answer
 * passed, so the cache is not a path around them. An answer that fails is a miss.
 */
export const memoize = (
  inner: DecisionModel.DecisionModel,
  cache: PlanAnswerStore,
): DecisionModel.DecisionModel =>
  DecisionModel.DecisionModel.of({
    [DecisionModel.TypeId]: DecisionModel.TypeId,
    decide: (definition, options) =>
      Effect.gen(function* () {
        const entries = Object.entries(definition.decisions)
        const answers: Record<string, Decision.Answer<Decision.Any>> = {}
        const missing: Record<string, Decision.Any> = {}
        const keys = new Map<string, string>()
        for (const [name, decision] of entries) {
          const key = answerKeyFor(decision, options.input)
          keys.set(name, key)
          const stored = yield* cache.get(key)
          if (Option.isSome(stored)) {
            const valid = yield* revalidate(decision, stored.value)
            if (Option.isSome(valid)) {
              answers[name] = valid.value
              continue
            }
          }
          missing[name] = decision
        }
        let usage = new DecisionModel.DecisionUsage({})
        if (Object.keys(missing).length > 0) {
          const response = yield* inner.decide(
            Decision.make({ input: definition.input, decisions: missing }),
            options,
          )
          usage = response.usage
          for (const name of Object.keys(missing)) {
            const answer = response.answers[name]
            if (answer === undefined) continue
            answers[name] = answer
            const key = keys.get(name)
            if (key !== undefined) yield* cache.put(key, answer)
          }
        }
        const ordered: Record<string, Decision.Answer<Decision.Any>> = {}
        for (const [name] of entries) {
          const answer = answers[name]
          if (answer !== undefined) ordered[name] = answer
        }
        // SAFETY: every name in the definition has an answer here -- the provider
        // validated the missing ones and the cache validated the rest -- and the
        // record was built in the definition's own order.
        const complete = ordered as Decision.Answers<typeof definition.decisions>
        return { answers: complete, usage }
      }),
  })

/**
 * A plan's answers, in the rule's own type.
 *
 * The engine erases the verdict type so plans from different rules can travel in
 * one request; this puts it back at the boundary, where the rule knows every
 * answer came from its own decisions and is in the order it asked them.
 */
export const verdictsOf = <A>(answers: ReadonlyArray<unknown>): ReadonlyArray<A | undefined> =>
  // SAFETY: the caller built these plans, so each answer is the type its own
  // decisions produced; the engine erased it only to batch rules together.
  answers as ReadonlyArray<A | undefined>

/**
 * Plans cut to fit one request, with the characters of state they carry.
 *
 * The characters are what the caller estimates tokens from: the provider charges
 * for the state, and the state dominates every request.
 */
export interface PlanChunk<A> {
  readonly plans: ReadonlyArray<Plan<A>>
  /** The characters of shared state this chunk carries. */
  readonly chars: number
}

/**
 * Cut plans into requests that fit the provider's ceiling.
 *
 * The engine's goal is one request, and the provider's token limit is the reason
 * it cannot always be one. A plan's cost is the state it needs -- the atoms it
 * named -- so the cut is by that, not by plan count: one cluster of twelve large
 * declarations costs more than forty small ones.
 */
export const chunkPlans = <A>(
  plans: ReadonlyArray<Plan<A>>,
  maxChars: number,
): Effect.Effect<ReadonlyArray<PlanChunk<A>>, never, Atoms> =>
  Effect.gen(function* () {
    const atoms = yield* Atoms
    const chunks: Array<PlanChunk<A>> = []
    let current: Array<Plan<A>> = []
    let size = 0
    for (const plan of plans) {
      const state = yield* atoms.values([...new Set(plan.atoms)])
      const cost = canonical(state).length
      if (current.length > 0 && size + cost > maxChars) {
        chunks.push({ plans: current, chars: size })
        current = []
        size = 0
      }
      current.push(plan)
      size += cost
    }
    if (current.length > 0) chunks.push({ plans: current, chars: size })
    return chunks
  })

/* -------------------------------------------------------------------------- */
/* The engine                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Answer many plans in one request, from the cache where it can.
 *
 * Three things happen here that a per-candidate call cannot do:
 *
 * - Two plans that ask the same decision against the same atoms ask it once.
 * - Every decision's atoms go into ONE state, so a declaration two rules both
 *   judge is sent once.
 * - A decision already answered from cache is not sent, so a request carries only
 *   what is genuinely new. That is what keeps a batched call from losing the
 *   per-candidate cache granularity a per-candidate call had.
 *
 * The state is `{ atoms: { id: value } }` and the decisions reference it by id.
 * A plan-local state (`declarations`, `files`) could not be merged into one
 * request without rewriting every instruction; atoms can.
 */
export const answerPlans = <A>(
  plans: ReadonlyArray<Plan<A>>,
): Effect.Effect<
  ReadonlyArray<A | undefined>,
  AiError.AiError,
  Atoms | PlanAnswers | DecisionModel.DecisionModel
> =>
  Effect.gen(function* () {
    if (plans.length === 0) return []
    const atoms = yield* Atoms
    const cache = yield* PlanAnswers

    // One entry per DISTINCT decision. The map is insertion-ordered, so the
    // request is deterministic for a given set of plans.
    //
    // The request name keeps the decision's own name and adds the plan's index,
    // because two plans nearly always ask a decision with the same name (`verdict`
    // in every cluster) and the request needs distinct keys. The name is for the
    // request only; the cache is keyed on the decision and its atoms.
    const distinct = new Map<
      string,
      { readonly decision: Decision.Any; readonly atoms: ReadonlyArray<string>; readonly requestName: string }
    >()
    plans.forEach((plan, planIndex) => {
      for (const [name, decision] of Object.entries(plan.decisions)) {
        const key = answerKeyFor(decision, plan.atoms)
        if (!distinct.has(key)) {
          distinct.set(key, { decision, atoms: plan.atoms, requestName: `${name}@${planIndex}` })
        }
      }
    })

    const answers = new Map<string, Decision.Answer<Decision.Any>>()
    const pending: Array<{ readonly key: string }> = []
    for (const [key, entry] of distinct) {
      const stored = yield* cache.get(key)
      if (Option.isSome(stored)) {
        const valid = yield* revalidate(entry.decision, stored.value)
        if (Option.isSome(valid)) {
          answers.set(key, valid.value)
          continue
        }
      }
      pending.push({ key })
    }

    if (pending.length > 0) {
      const ids = [...new Set(pending.flatMap((entry) => distinct.get(entry.key)?.atoms ?? []))]
      const state = yield* atoms.values(ids)
      const decisions: Record<string, Decision.Any> = {}
      const names = new Map<string, string>()
      for (const entry of pending) {
        const found = distinct.get(entry.key)
        if (found === undefined) continue
        decisions[found.requestName] = found.decision
        names.set(entry.key, found.requestName)
      }
      const definition = Decision.make({ input: Schema.Json, decisions })
      const decided = yield* DecisionModel.decide(definition, { input: { atoms: state } })
      for (const entry of pending) {
        const requestName = names.get(entry.key)
        const answer = requestName === undefined ? undefined : decided.answers[requestName]
        if (answer !== undefined) answers.set(entry.key, answer)
      }
      for (const entry of pending) {
        const answer = answers.get(entry.key)
        if (answer !== undefined) yield* cache.put(entry.key, answer)
      }
    }

    return plans.map((plan) => {
      const collected: Record<string, Decision.Answer<Decision.Any>> = {}
      for (const [name, decision] of Object.entries(plan.decisions)) {
        const answer = answers.get(answerKeyFor(decision, plan.atoms))
        if (answer !== undefined) collected[name] = answer
      }
      return plan.read(collected)
    })
  })
