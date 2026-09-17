import {
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
} from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { policy } from "./policy.ts"
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
  /** The evidence panel. This is the System One `state`. */
  readonly evidence: unknown
  /** Atomic, typed questions about that evidence. */
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
  readonly calls: number
}

export interface Interface {
  readonly ask: (request: JudgeRequest) => Effect.Effect<JudgeResult, JudgeError>
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
 */
export const cacheKeyFor = (request: JudgeRequest): string =>
  canonical({
    questionVersion: policy.questionVersion,
    model: policy.model,
    evidence: request.evidence,
    questions: request.questions,
  })

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const orEmpty = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: A): Effect.Effect<A, never, R> =>
  Effect.orElseSucceed(effect, () => fallback)

const storePath = (path: Path.Path, cacheDir: string): string => path.join(cacheDir, "judgements.json")

/* -------------------------------------------------------------------------- */
/* Layer                                                                       */
/* -------------------------------------------------------------------------- */

export interface Options {
  /** Directory the replayed judgement cache lives in. */
  readonly cacheDir: string
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
      const stats = yield* Ref.make<JudgeStats>({ requests: 0, replayed: 0, calls: 0 })

      const flush = Effect.gen(function* () {
        const current = yield* Ref.get(entries)
        const body = JSON.stringify({ version: policy.version, entries: current }, null, 2)
        yield* orEmpty(fs.makeDirectory(options.cacheDir, { recursive: true }), undefined)
        yield* orEmpty(fs.writeFileString(file, body), undefined)
      })

      const callApi = Effect.fn("Judge.callApi")(function* (apiKey: string, request: JudgeCacheKey) {
        const body: SystemOneRequest = {
          state: request.evidence,
          model: request.model,
          questions: request.questions,
        }
        const httpRequest = yield* HttpClientRequest.post(`${policy.judge.baseUrl}/v1/systemone`).pipe(
          HttpClientRequest.bearerToken(apiKey),
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJson(body),
          Effect.mapError(mapJudgeError),
        )
        // Retry transport failures only: an HTTP status is a verdict, not a hiccup.
        const client = (yield* HttpClient.HttpClient).pipe(HttpClient.retryTransient({ times: 3 }))
        const response = yield* client.execute(httpRequest).pipe(Effect.mapError(mapJudgeError))
        // Classify the status before decoding: a 401 is not a malformed body.
        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(
            new JudgeRejected({ status: response.status, detail: statusDetail(response.status) }),
          )
        }
        return yield* HttpClientResponse.schemaBodyJson(SystemOneResponse)(response).pipe(
          Effect.mapError(mapJudgeError),
        )
      })

      const lookup = Effect.fn("Judge.lookup")(function* (key: string) {
        const replayed = (yield* Ref.get(entries))[key]
        if (replayed !== undefined) {
          yield* Ref.update(stats, (current) => ({ ...current, replayed: current.replayed + 1 }))
          return { answers: replayed, replayed: true } satisfies JudgeResult
        }
        if (Option.isNone(options.apiKey)) {
          return yield* Effect.fail(new JudgeUnavailable({ reason: "TYPESAFE_API_KEY is not set" }))
        }
        if (options.offline) {
          return yield* Effect.fail(
            new JudgeUnavailable({ reason: "offline mode and no cached judgement for this candidate" }),
          )
        }
        const request = yield* Schema.decodeUnknownEffect(JudgeCacheKey)(safeJson(key)).pipe(
          Effect.mapError((cause) => new JudgeMalformed({ detail: describe(cause) })),
        )
        yield* Ref.update(stats, (current) => ({ ...current, calls: current.calls + 1 }))
        const response = yield* callApi(options.apiKey.value, request)
        yield* Ref.update(entries, (current) => ({ ...current, [key]: response.answers }))
        yield* flush
        return { answers: response.answers, replayed: false } satisfies JudgeResult
      })

      const cache = yield* Cache.makeWith((key: string) => lookup(key), {
        capacity: policy.judge.capacity,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) ? Duration.days(policy.judge.timeToLiveDays) : Duration.zero,
      })

      const ask = Effect.fn("Judge.ask")(function* (request: JudgeRequest) {
        yield* Ref.update(stats, (current) => ({ ...current, requests: current.requests + 1 }))
        return yield* Cache.get(cache, cacheKeyFor(request))
      })

      return Service.of({ ask, stats: Ref.get(stats) })
    }),
  )
