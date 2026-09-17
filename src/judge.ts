import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  Schema,
} from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { policy } from "./policy.ts"
import { safeJson } from "./state.ts"
import { isRecord } from "./workspace.ts"
import {
  JudgeCacheFile,
  JudgeCacheKey,
  JudgeMalformed,
  JudgeRejected,
  JudgeTransport,
  JudgeUnavailable,
  SystemOneRequest,
  SystemOneResponse,
  type Answer,
  type JudgeError,
  type Question,
} from "./schema.ts"

/* -------------------------------------------------------------------------- */
/* Surface                                                                     */
/* -------------------------------------------------------------------------- */

export interface JudgeRequest {
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

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const tagOf = (cause: unknown): string =>
  isRecord(cause) && typeof cause["_tag"] === "string" ? cause["_tag"] : ""

const statusDetail = (status: number): string => {
  if (status === 401) return "unauthorized — check TYPESAFE_API_KEY"
  if (status === 422) return "the request failed validation"
  if (status === 429) return "rate limited"
  if (status === 529) return "TypeSafe is overloaded; retry later"
  return "unexpected response status"
}

const mapJudgeError = (cause: unknown): JudgeError => {
  const tag = tagOf(cause)
  if (tag === "StatusCodeError") {
    const response = isRecord(cause) ? cause["response"] : undefined
    const status = isRecord(response) && typeof response["status"] === "number" ? response["status"] : 0
    return new JudgeRejected({ status, detail: describe(cause) })
  }
  if (tag === "SchemaError" || tag === "ParseError") {
    return new JudgeMalformed({ detail: describe(cause) })
  }
  return new JudgeTransport({ operation: "systemone", detail: describe(cause) })
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
      // Acquired once for the layer's lifetime, not per call: a client built
      // inside a lookup pays the acquisition on every miss.
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.retryTransient({ times: 3 }))
      const apiKey = Option.getOrUndefined(options.apiKey)
      // Overridable so a self-hosted or enterprise deployment can be used when
      // the evidence panels must not leave the organisation's boundary.
      const baseUrl = yield* Config.String("TYPESAFE_BASE_URL").pipe(
        Effect.orElseSucceed(() => policy.judge.baseUrl),
      )

      const load = Effect.gen(function* () {
        const empty: Record<string, Record<string, Answer>> = {}
        const exists = yield* orEmpty(fs.exists(file), false)
        if (!exists) return empty
        const text = yield* orEmpty(fs.readFileString(file), "")
        if (text.trim() === "") return empty
        const decoded = Schema.decodeUnknownOption(JudgeCacheFile)(safeJson(text))
        return Option.isSome(decoded) ? decoded.value.entries : empty
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
        apiKey: string,
        batch: ReadonlyArray<Miss>,
      ) {
        const state = { candidates: batch.map((miss) => miss.request.evidence) }
        const questions: Record<string, Question> = {}
        batch.forEach((miss, position) => {
          const prefix = `candidates[${position}].`
          for (const [id, question] of Object.entries(miss.request.questions)) {
            questions[`c${position}__${id}`] = scopeQuestion(question, prefix)
          }
        })

        const body: SystemOneRequest = { state, model: policy.model, questions }
        const httpRequest = yield* HttpClientRequest.post(`${baseUrl}/v1/systemone`).pipe(
          HttpClientRequest.bearerToken(apiKey),
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJson(body),
          Effect.mapError(mapJudgeError),
        )
        const attempt = Effect.gen(function* () {
          const response = yield* client.execute(httpRequest).pipe(Effect.mapError(mapJudgeError))
          if (response.status < 200 || response.status >= 300) {
            return yield* Effect.fail(
              new JudgeRejected({ status: response.status, detail: statusDetail(response.status) }),
            )
          }
          return yield* HttpClientResponse.schemaBodyJson(SystemOneResponse)(response).pipe(
            Effect.mapError(mapJudgeError),
          )
        })

        // 429 and 529 are backpressure, not verdicts. Classifying the status by
        // hand means retryTransient never sees them, so they are retried here.
        const response = yield* attempt.pipe(
          Effect.retry({
            while: (error: JudgeError) =>
              error._tag === "joggle/JudgeRejected" &&
              (error.status === 429 || error.status === 529),
            schedule: Schedule.exponential("400 millis").pipe(
              Schedule.jittered,
              Schedule.upTo({ times: 6 }),
            ),
          }),
        )

        yield* Ref.update(stats, (current) => ({
          ...current,
          inputTokens: current.inputTokens + (response.usage?.input_tokens ?? 0),
          outputTokens: current.outputTokens + (response.usage?.output_tokens ?? 0),
        }))

        yield* Ref.update(entries, (current) => {
          const next = { ...current }
          batch.forEach((miss, position) => {
            const scoped: Record<string, Answer> = {}
            for (const id of Object.keys(miss.request.questions)) {
              const answer = response.answers[`c${position}__${id}`]
              if (answer !== undefined) scoped[id] = answer
            }
            // An unreadable response is not cached: caching it would make the
            // absence permanent and a later run could never learn the answer.
            if (Object.keys(scoped).length > 0) next[miss.key] = scoped
          })
          return next
        })
      })

      const askMany = Effect.fn("Judge.askMany")(function* (
        requests: ReadonlyArray<JudgeRequest>,
      ) {
        if (requests.length === 0) return []
        yield* Ref.update(stats, (current) => ({
          ...current,
          requests: current.requests + requests.length,
        }))

        const before = yield* Ref.get(entries)
        const keys = requests.map(cacheKeyFor)
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
          yield* Effect.forEach(batches, (batch) => callBatch(apiKey, batch), {
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
