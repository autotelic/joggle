import {
  Config,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Redacted,
  Ref,
  Result,
  Schedule,
  Schema,
  SchemaParser,
} from "effect"
import { Decision } from "effect/unstable/ai"
import * as AiError from "effect/unstable/ai/AiError"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe"
import { policy } from "./policy.ts"
import { isRecord } from "./workspace.ts"
import {
  JudgeCacheFile,
  JudgeMalformed,
  JudgeRejected,
  JudgeTransport,
  JudgeUnavailable,
  type Answer,
  type Entry,
  type JudgeError,
  type Question,
} from "./schema.ts"

/* -------------------------------------------------------------------------- */
/* Surface                                                                     */
/* -------------------------------------------------------------------------- */

export interface JudgeRequest {
  /**
   * The repository's declared architecture, if it has one.
   *
   * PART OF THE REQUEST, not a parameter beside it. It was a parameter, and
   * `cacheKeyFor` had to be passed it separately -- so when I added it to the
   * model's state and forgot the key, editing joggle.config.json replayed every
   * verdict made under the previous architecture. I then wrote a comment saying
   * it was in the key.
   *
   * The talk this comes from (docs/turbo.md) puts it plainly: "I don't really
   * trust developers to write correct cache keys or track inputs by hand." An
   * input that is part of the thing being keyed cannot be forgotten; one passed
   * alongside it can. The judge layer stamps this onto every request it receives,
   * so a rule does not have to know it exists.
   */
  readonly repository?: string | undefined
  /** The evidence panel, relative to ONE candidate. This is System One's `state`. */
  readonly evidence: unknown
  /**
   * Atomic, typed questions about that candidate.
   *
   * Questions are written once, against a single candidate, and refer to it as
   * `{candidate}`. When several candidates share a request, the batcher rewrites
   * that marker to `candidates[3].` and so on, which is what lets one state hold
   * many candidates without the questions becoming ambiguous.
   */
  readonly questions: Readonly<Record<string, Question>>
}

export interface JudgeResult {
  readonly answers: Readonly<Record<string, Answer>>
  /** True when the answer came from the persisted cache rather than the API. */
  readonly replayed: boolean
}

export interface JudgeStats {
  readonly requests: number
  readonly replayed: number
  /** Wire calls. Fewer than requests means batching worked. */
  readonly calls: number
  readonly unavailable: number
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface Interface {
  readonly ask: (request: JudgeRequest) => Effect.Effect<JudgeResult, JudgeError>
  readonly askMany: (
    requests: ReadonlyArray<JudgeRequest>,
  ) => Effect.Effect<ReadonlyArray<JudgeResult>, JudgeError>
  readonly stats: Effect.Effect<JudgeStats>
}

export class Service extends Context.Service<Service, Interface>()("@joggle/Judge") {}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** The provider's HTTP status, when the reason carries one. */
const statusOf = (reason: AiError.AiErrorReason, fallback: number): number => {
  const http = isRecord(reason) ? reason["http"] : undefined
  const response = isRecord(http) ? http["response"] : undefined
  const status = isRecord(response) ? response["status"] : undefined
  return typeof status === "number" ? status : fallback
}

/**
 * joggle's questions, as Effect `Decision`s.
 *
 * A `Decision` carries a single instruction string, so a labelled entry is
 * serialized to JSON: the labels survive in the text, and the provider sees the
 * same content the rules wrote. The question kind picks the decision kind -- a
 * Noul is a probability, a Choice is a classification.
 */
const instructionText = (entry: Entry): string =>
  Predicate.isString(entry) ? entry : JSON.stringify(entry)

const criteriaText = (entry: Entry | null): string => {
  if (entry === null) return ""
  return Predicate.isString(entry) ? entry : JSON.stringify(entry)
}

const toDecision = (question: Question): Decision.Any => {
  if (question.type === "noul") {
    const criteria = question.criteria
    return Decision.probability({
      instructions: instructionText(question.instructions),
      // Effect's `Decision.probability` always describes both outcomes. A joggle
      // question may omit them, so the neutral pair stands in and the wording of
      // the question itself carries the meaning.
      criteria: {
        false: criteria === undefined ? "No." : criteriaText(criteria.false),
        true: criteria === undefined ? "Yes." : criteriaText(criteria.true),
      },
    })
  }
  return Decision.classify({
    instructions: instructionText(question.instructions),
    criteria: Object.fromEntries(
      Object.entries(question.criteria).map(([key, value]) => [key, criteriaText(value)]),
    ),
  })
}

/** A `Decision` answer, back in the vocabulary the rules and the cache speak. */
const toAnswer = (
  question: Question,
  answer: Decision.Answer<Decision.Any> | undefined,
): Option.Option<Answer> => {
  if (answer === undefined) return Option.none()
  if (question.type === "noul") {
    return "probability" in answer
      ? Option.some({ type: "noul", noul: answer.probability })
      : Option.none()
  }
  return "label" in answer
    ? Option.some({
        type: "choice",
        choice: answer.label,
        probabilities: answer.probabilities,
        confidence: answer.confidence ?? 0,
      })
    : Option.none()
}

/**
 * Stable JSON. The cache key must not depend on property insertion order, or a
 * replay in CI would miss the judgement recorded locally.
 */
const canonical = (value: unknown): string => {
  const encode = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(encode)
    if (isRecord(input)) {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(input).sort()) out[key] = encode(input[key])
      return out
    }
    return input
  }
  return JSON.stringify(encode(value))
}

/**
 * The cache key, exported because the replay file is a contract: tooling (and
 * tests) need to compute the same key without going through the client.
 *
 * It is the key of ONE candidate's request, never of a batch. Batching is a
 * transport concern; if it changed the key, the same candidate judged in a
 * different batch would miss its own cached answer.
 */
export const cacheKeyFor = (request: JudgeRequest): string =>
  canonical({
    questionVersion: policy.questionVersion,
    model: policy.model,
    // The repository's declared architecture is part of the key, because it is
    // part of the request: the same candidate judged under "pages compose
    // bundles" and under "there is no React here" is not one judgement replayed,
    // it is two judgements. It was passed to the model and stored in the state
    // WITHOUT being in the key, so editing joggle.config.json replayed every
    // verdict made under the previous architecture. The values are compared as a
    // string against the empty one, so "declared nothing" and "declared the empty
    // architecture" are different requests too.
    repository: request.repository ?? null,
    evidence: request.evidence,
    questions: request.questions,
  })

const orEmpty = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: A): Effect.Effect<A, never, R> =>
  Effect.orElseSucceed(effect, () => fallback)

const storePath = (path: Path.Path, cacheDir: string): string => path.join(cacheDir, "judgements.json")

/* -------------------------------------------------------------------------- */
/* Scope, pack, call                                                           */
/* -------------------------------------------------------------------------- */

/** Rewrite `{candidate}` inside a question entry to a concrete state path. */
const scopeEntry = (entry: unknown, prefix: string): unknown => {
  if (typeof entry === "string") return entry.split("{candidate}").join(prefix)
  if (Array.isArray(entry)) return entry.map((item) => scopeEntry(item, prefix))
  if (isRecord(entry)) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(entry)) out[key] = scopeEntry(value, prefix)
    return out
  }
  return entry
}

/** Choice option keys are ids, not paths, so only their descriptions are scoped. */
const scopeQuestion = (question: Question, prefix: string): Question => {
  if (question.type === "choice") {
    return {
      type: "choice",
      instructions: scopeEntry(question.instructions, prefix) as never,
      criteria: Object.fromEntries(
        Object.entries(question.criteria).map(([key, value]) => [
          key,
          value === null ? null : (scopeEntry(value, prefix) as string),
        ]),
      ),
    }
  }
  return {
    type: "noul",
    instructions: scopeEntry(question.instructions, prefix) as never,
    ...(question.criteria === undefined
      ? {}
      : {
          criteria: {
            true: scopeEntry(question.criteria.true, prefix) as string,
            false: scopeEntry(question.criteria.false, prefix) as string,
          },
        }),
  }
}

interface Miss {
  readonly key: string
  readonly request: JudgeRequest
}

/** Rough token estimate. Four characters per token is the usual English ratio. */
const estimateTokens = (request: JudgeRequest): number =>
  Math.ceil(JSON.stringify(request).length / 4)

/**
 * Greedy packing under a token budget and a candidate count.
 *
 * The budget is shared between state and questions and is around 32,000 tokens,
 * so the policy leaves room for the questions and the answer.
 */
export const packRequests = (
  misses: ReadonlyArray<Miss>,
  limit: number = policy.judge.batchCandidates,
): ReadonlyArray<ReadonlyArray<Miss>> => {
  const batches: Array<Array<Miss>> = []
  let current: Array<Miss> = []
  let tokens = 0
  for (const miss of misses) {
    const cost = estimateTokens(miss.request) + 250
    const full = tokens + cost > policy.judge.batchTokens || current.length >= limit
    if (current.length > 0 && full) {
      batches.push(current)
      current = []
      tokens = 0
    }
    current.push(miss)
    tokens += cost
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/* -------------------------------------------------------------------------- */
/* Layer                                                                       */
/* -------------------------------------------------------------------------- */

export interface Options {
  /** Directory the replayed judgement cache lives in. */
  readonly cacheDir: string
  /**
   * The repository's architecture in its own words, from joggle.config.json.
   *
   * Sent with every judgement, because the question "does this fit here?" has no
   * answer without it. It is part of the cache key too: a judgement made under
   * one declared architecture is not the same judgement under another.
   */
  readonly evidenceContext?: string | undefined
  /**
   * Candidates per request. Overridable so a run can be compared batched
   * against unbatched: batching is a cost lever, and a cost lever that changes
   * the answers is not a lever.
   */
  readonly batchCandidates?: number | undefined
  /** Never call the API; answer only from the persisted cache. */
  readonly offline: boolean
  /** Absent means the deterministic rules still run and judged rules are skipped. */
  readonly apiKey: Option.Option<string>
}

export const layer = (
  options: Options,
): Layer.Layer<Service, never, FileSystem.FileSystem | Path.Path | HttpClient.HttpClient> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const file = storePath(path, options.cacheDir)
      const apiKey = Option.getOrUndefined(options.apiKey)
      // Overridable so a self-hosted or enterprise deployment can be used when
      // the evidence panels must not leave the organisation's boundary.
      const baseUrl = yield* Config.String("TYPESAFE_BASE_URL").pipe(
        Effect.orElseSucceed(() => policy.judge.baseUrl),
      )
      // The provider client owns authentication, the endpoint, JSON encoding and
      // the error taxonomy. joggle owns the cache, the batching and the questions.
      // Acquired once for the layer's lifetime, not per call: a client built
      // inside a lookup pays the acquisition on every miss.
      const client = yield* TypeSafeClient.make({
        apiKey: apiKey === undefined ? undefined : Redacted.make(apiKey),
        apiUrl: `${baseUrl}/v1`,
      })
      // The decision model is Effect's own abstraction over System One: it builds
      // the questions, calls the endpoint, validates the answers and returns them
      // typed. joggle keeps the cache, the batching and the scoping.
      const decisionModel = yield* TypeSafeDecisionModel.make({ model: policy.model }).pipe(
        Effect.provideService(TypeSafeClient.TypeSafeClient, client),
      )

      const load = Effect.gen(function* () {
        const empty: Record<string, Record<string, Answer>> = {}
        const exists = yield* orEmpty(fs.exists(file), false)
        if (!exists) return empty
        const text = yield* orEmpty(fs.readFileString(file), "")
        if (text.trim() === "") return empty
        const decoded = Result.getOrUndefined(SchemaParser.decodeUnknownResult(Schema.fromJsonString(JudgeCacheFile))(text))
        return decoded === undefined ? empty : decoded.entries
      })

      const entries = yield* Ref.make(yield* load)
      const stats = yield* Ref.make<JudgeStats>({
        requests: 0,
        replayed: 0,
        calls: 0,
        unavailable: 0,
        inputTokens: 0,
        outputTokens: 0,
      })

      const flush = Effect.gen(function* () {
        const current = yield* Ref.get(entries)
        const body = JSON.stringify({ version: policy.version, entries: current }, null, 2)
        yield* orEmpty(fs.makeDirectory(options.cacheDir, { recursive: true }), undefined)
        yield* orEmpty(fs.writeFileString(file, body), undefined)
      })

      /** One wire call: the whole batch as one state, one question per candidate. */
      const callBatch = Effect.fn("Judge.callBatch")(function* (
        batch: ReadonlyArray<Miss>,
      ) {
        // The context is read off the request it was stamped onto, so the state
        // the model sees and the key it is cached under come from ONE place.
        const repository = batch[0]?.request.repository
        const state = {
          candidates: batch.map((miss) => miss.request.evidence),
          ...(repository === undefined ? {} : { repository }),
        }
        const questions: Record<string, Question> = {}
        batch.forEach((miss, position) => {
          const prefix = `candidates[${position}].`
          for (const [id, question] of Object.entries(miss.request.questions)) {
            questions[`c${position}__${id}`] = scopeQuestion(question, prefix)
          }
        })

        const decisions: Record<string, Decision.Any> = {}
        for (const [key, question] of Object.entries(questions)) decisions[key] = toDecision(question)
        if (Object.keys(decisions).length === 0) return
        const definition = Decision.make({ input: Schema.Unknown, decisions })

        const decided = yield* decisionModel.decide(definition, { input: state }).pipe(
          // Backpressure is the provider's own classification now, so
          // `isRetryable` decides instead of a hand-written status list.
          Effect.retry({
            while: (error: AiError.AiError) => error.isRetryable,
            schedule: Schedule.exponential("400 millis").pipe(
              Schedule.jittered,
              Schedule.upTo({ times: 6 }),
            ),
          }),
          // The reason taxonomy is the provider's too, so the conversion to
          // joggle's outcomes is a reason match rather than a guess at a tag.
          Effect.catchReasons(
            "AiError",
            {
              RateLimitError: (reason, error) =>
                Effect.fail(
                  new JudgeRejected({
                    status: statusOf(reason, 429),
                    detail:
                      reason.retryAfter === undefined
                        ? error.message
                        : `${error.message} (retry after ${Duration.toSeconds(reason.retryAfter)}s)`,
                  }),
                ),
              AuthenticationError: (reason, error) =>
                Effect.fail(new JudgeRejected({ status: statusOf(reason, 401), detail: error.message })),
              InvalidRequestError: (reason, error) =>
                Effect.fail(new JudgeRejected({ status: statusOf(reason, 422), detail: error.message })),
              ContentPolicyError: (reason, error) =>
                Effect.fail(new JudgeRejected({ status: statusOf(reason, 422), detail: error.message })),
              InternalProviderError: (reason, error) =>
                Effect.fail(new JudgeRejected({ status: statusOf(reason, 500), detail: error.message })),
              QuotaExhaustedError: (reason, error) =>
                Effect.fail(new JudgeRejected({ status: statusOf(reason, 429), detail: error.message })),
              InvalidOutputError: (_reason, error) =>
                Effect.fail(new JudgeMalformed({ detail: error.message })),
              StructuredOutputError: (_reason, error) =>
                Effect.fail(new JudgeMalformed({ detail: error.message })),
              UnsupportedSchemaError: (_reason, error) =>
                Effect.fail(new JudgeMalformed({ detail: error.message })),
            },
            (_reason, error) =>
              Effect.fail(new JudgeTransport({ operation: "systemone", detail: error.message })),
          ),
        )

        yield* Ref.update(stats, (current) => ({
          ...current,
          inputTokens: current.inputTokens + (decided.usage.inputTokens ?? 0),
          outputTokens: current.outputTokens + (decided.usage.outputTokens ?? 0),
        }))

        yield* Ref.update(entries, (current) => {
          const next = { ...current }
          batch.forEach((miss, position) => {
            const scoped: Record<string, Answer> = {}
            for (const id of Object.keys(miss.request.questions)) {
              const key = `c${position}__${id}`
              const question = questions[key]
              const answer = question === undefined ? Option.none() : toAnswer(question, decided.answers[key])
              if (Option.isSome(answer)) scoped[id] = answer.value
            }
            // An unreadable response is not cached: caching it would make the
            // absence permanent and a later run could never learn the answer.
            if (Object.keys(scoped).length > 0) next[miss.key] = scoped
          })
          return next
        })
      })

      const askMany = Effect.fn("Judge.askMany")(function* (
        incoming: ReadonlyArray<JudgeRequest>,
      ) {
        // Stamped here, once, so no rule has to remember it and no key can miss
        // it. A rule hands over evidence and questions; the layer owns the rest.
        const requests: ReadonlyArray<JudgeRequest> =
          options.evidenceContext === undefined
            ? incoming
            : incoming.map((request) => ({ ...request, repository: options.evidenceContext }))
        if (requests.length === 0) return []
        yield* Ref.update(stats, (current) => ({
          ...current,
          requests: current.requests + requests.length,
        }))

        const before = yield* Ref.get(entries)
        const keys = requests.map((request) => cacheKeyFor(request))
        const wasCached = keys.map((key) => before[key] !== undefined)
        const cachedCount = wasCached.filter(Boolean).length
        if (cachedCount > 0) {
          yield* Ref.update(stats, (current) => ({
            ...current,
            replayed: current.replayed + cachedCount,
          }))
        }

        const seen = new Set<string>()
        const misses: Array<Miss> = []
        keys.forEach((key, position) => {
          if (wasCached[position] === true || seen.has(key)) return
          seen.add(key)
          const request = requests[position]
          if (request !== undefined) misses.push({ key, request })
        })

        if (misses.length > 0) {
          if (apiKey === undefined) {
            yield* Ref.update(stats, (current) => ({
              ...current,
              unavailable: current.unavailable + misses.length,
            }))
            return yield* Effect.fail(new JudgeUnavailable({ reason: "TYPESAFE_API_KEY is not set" }))
          }
          if (options.offline) {
            yield* Ref.update(stats, (current) => ({
              ...current,
              unavailable: current.unavailable + misses.length,
            }))
            return yield* Effect.fail(
              new JudgeUnavailable({
                reason: `offline mode and no cached judgement for ${misses.length} candidate(s)`,
              }),
            )
          }
          const batches = packRequests(misses, options.batchCandidates ?? policy.judge.batchCandidates)
          yield* Ref.update(stats, (current) => ({ ...current, calls: current.calls + batches.length }))
          yield* Effect.forEach(batches, (batch) => callBatch(batch), {
            concurrency: policy.judge.requestConcurrency,
          })
          yield* flush
        }

        const after = yield* Ref.get(entries)
        return requests.map((_, position) => {
          const key = keys[position]
          const stored = key === undefined ? undefined : after[key]
          return stored === undefined
            ? { answers: {}, replayed: false }
            : { answers: stored, replayed: wasCached[position] === true }
        })
      })

      const ask = Effect.fn("Judge.ask")(function* (request: JudgeRequest) {
        const results = yield* askMany([request])
        const first = results[0]
        return first ?? { answers: {}, replayed: false }
      })

      return Service.of({ ask, askMany, stats: Ref.get(stats) })
    }),
  )
