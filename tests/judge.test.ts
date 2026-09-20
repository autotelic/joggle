import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option } from "effect"
import { NodeServices } from "@effect/platform-node"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import {
  cacheKeyFor,
  layer as judgeLayer,
  packRequests,
  Service as JudgeService,
} from "../src/judge.ts"
import { policy } from "../src/policy.ts"
import { JudgeRejected, JudgeUnavailable } from "../src/schema.ts"
import { isRecord } from "../src/workspace.ts"
import { nodeLayer } from "./support.ts"

/** An HttpClient whose one response is produced by `handler`. */
const mockClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.makeWith(
      Effect.fnUntraced(function* (requestEffect) {
        const request = yield* requestEffect
        return yield* handler(request)
      }),
      Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>,
    ),
  )

/** The JSON body of an encoded request, for asserting what was sent. */
const bodyOf = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<Record<string, unknown>> =>
  Effect.gen(function* () {
    const body = request.body
    if (body._tag !== "Uint8Array") return yield* Effect.die(new Error("expected an encoded body"))
    const decoded: unknown = JSON.parse(new TextDecoder().decode(body.body))
    if (!isRecord(decoded)) return yield* Effect.die(new Error("expected a JSON object"))
    return decoded
  })

const cacheDir = "/tmp/joggle-judge-test"

const request = {
  evidence: { left: { symbol: "a" }, right: { symbol: "b" } },
  questions: {
    same_concept: {
      type: "noul" as const,
      instructions: "Are these the same concept?",
    },
  },
}

it.effect("replays a judgement from the persisted cache with no API key", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const key = cacheKeyFor(request)
    yield* fs.makeDirectory(cacheDir, { recursive: true })
    yield* fs.writeFileString(
      `${cacheDir}/judgements.json`,
      JSON.stringify({
        version: policy.version,
        entries: { [key]: { same_concept: { type: "noul", noul: 0.91 } } },
      }),
    )

    const result = yield* Effect.gen(function* () {
      const judge = yield* JudgeService
      return yield* judge.ask(request)
    }).pipe(Effect.provide(judgeLayer({ cacheDir, offline: true, apiKey: Option.none() })))

    expect(result.replayed).toBe(true)
    expect(result.answers["same_concept"]).toEqual({ type: "noul", noul: 0.91 })
  }).pipe(Effect.provide(nodeLayer)),
)

it.effect("offline without a cached judgement fails with a typed error", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(cacheDir, { recursive: true, force: true })
    const error = yield* Effect.gen(function* () {
      const judge = yield* JudgeService
      return yield* judge.ask(request)
    }).pipe(
      Effect.provide(judgeLayer({ cacheDir, offline: true, apiKey: Option.none() })),
      Effect.flip,
    )
    expect(error).toBeInstanceOf(JudgeUnavailable)
  }).pipe(Effect.provide(nodeLayer)),
)

it("packs requests under the token budget and the candidate limit", () => {
  const miss = (size: number, index: number) => ({
    key: `k${index}`,
    request: { evidence: { blob: "x".repeat(size) }, questions: {} },
  })
  const misses = [miss(400, 0), miss(400, 1), miss(400, 2)]
  expect(packRequests(misses, 1).length).toBe(3)
  expect(packRequests(misses, 2).length).toBe(2)
  // The token budget caps it however many candidates are allowed.
  expect(packRequests(misses, 100).length).toBe(1)
  const huge = [miss(200000, 0), miss(200000, 1)]
  expect(packRequests(huge, 100).length).toBe(2)
})

it.effect("the cache key carries the question version and the model", () =>
  Effect.sync(() => {
    const key = cacheKeyFor(request)
    expect(key).toContain(policy.questionVersion)
    expect(key).toContain(policy.model)
  }),
)
it.effect("posts the batch to the provider and caches the decoded answers", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const cacheDir = "/tmp/joggle-judge-http"
    yield* fs.remove(cacheDir, { recursive: true, force: true })
    const seen: Array<HttpClientRequest.HttpClientRequest> = []

    const outcome = yield* Effect.gen(function* () {
      const judge = yield* JudgeService
      const result = yield* judge.ask(request)
      const stats = yield* judge.stats
      return { result, stats }
    }).pipe(
      Effect.provide(judgeLayer({ cacheDir, offline: false, apiKey: Option.some("test-key") })),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          mockClient((httpRequest) =>
            Effect.gen(function* () {
              seen.push(httpRequest)
              const body = yield* bodyOf(httpRequest)
              const questions = body["questions"]
              const answers: Record<string, unknown> = {}
              if (isRecord(questions)) {
                for (const id of Object.keys(questions)) {
                  answers[id] = { type: "noul", noul: 0.91 }
                }
              }
              return HttpClientResponse.fromWeb(
                httpRequest,
                new Response(
                  JSON.stringify({
                    model: "jev-latest",
                    answers,
                    usage: { input_tokens: 11, output_tokens: 2 },
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              )
            }),
          ),
        ),
      ),
    )

    expect(outcome.result.answers["same_concept"]).toEqual({ type: "noul", noul: 0.91 })
    expect(outcome.result.replayed).toBe(false)
    expect(outcome.stats.calls).toBe(1)
    expect(outcome.stats.inputTokens).toBe(11)
    expect(outcome.stats.outputTokens).toBe(2)

    const sent = seen[0]
    expect(sent?.url).toBe("https://api.typesafe.ai/v1/systemone")
    expect(sent?.headers["authorization"]).toBe("Bearer test-key")
    const sentBody = sent === undefined ? {} : yield* bodyOf(sent)
    expect(sentBody["model"]).toBe("jev-latest")
    const sentQuestions = sentBody["questions"]
    expect(isRecord(sentQuestions) && "c0__same_concept" in sentQuestions).toBe(true)
  }).pipe(Effect.provide(nodeLayer)),
)

it.effect("maps a provider refusal onto the typed judge error", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const cacheDir = "/tmp/joggle-judge-http-error"
    yield* fs.remove(cacheDir, { recursive: true, force: true })

    const error = yield* Effect.gen(function* () {
      const judge = yield* JudgeService
      return yield* judge.ask(request)
    }).pipe(
      Effect.provide(judgeLayer({ cacheDir, offline: false, apiKey: Option.some("test-key") })),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          mockClient((httpRequest) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                httpRequest,
                new Response(JSON.stringify({ message: "invalid key" }), {
                  status: 401,
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          ),
        ),
      ),
      Effect.flip,
    )

    expect(error).toBeInstanceOf(JudgeRejected)
    expect((error as JudgeRejected).status).toBe(401)
  }).pipe(Effect.provide(nodeLayer)),
)
it.effect("answers a classification through DecisionModel", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const cacheDir = "/tmp/joggle-judge-http-choice"
    yield* fs.remove(cacheDir, { recursive: true, force: true })
    const sent: Array<Record<string, unknown>> = []

    const request = {
      evidence: { left: { symbol: "a" }, right: { symbol: "b" } },
      questions: {
        same_concept: {
          type: "choice" as const,
          instructions: { question: "Are these the same concept?", focus: "compare the meaning" },
          criteria: { one: { label: "one thing" }, two: "two things" },
        },
      },
    }

    const answers = yield* Effect.gen(function* () {
      const judge = yield* JudgeService
      const result = yield* judge.ask(request)
      return result.answers
    }).pipe(
      Effect.provide(judgeLayer({ cacheDir, offline: false, apiKey: Option.some("test-key") })),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          mockClient((httpRequest) =>
            Effect.gen(function* () {
              const body = yield* bodyOf(httpRequest)
              sent.push(body)
              const questions = body["questions"]
              if (!isRecord(questions)) return yield* Effect.die(new Error("no questions"))
              const first = Object.values(questions)[0]
              if (!isRecord(first) || !isRecord(first["criteria"])) {
                return yield* Effect.die(new Error("no criteria"))
              }
              const labels = Object.keys(first["criteria"])
              const probabilities: Record<string, number> = {}
              labels.forEach((label, index) => {
                probabilities[label] = index === 0 ? 0.7 : 0.3 / (labels.length - 1)
              })
              const answersFor: Record<string, unknown> = {}
              for (const key of Object.keys(questions)) {
                answersFor[key] = { type: "choice", choice: labels[0], probabilities, confidence: 0.5 }
              }
              return HttpClientResponse.fromWeb(
                httpRequest,
                new Response(JSON.stringify({ model: "jev-latest", answers: answersFor }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              )
            }),
          ),
        ),
      ),
    )

    const answer = answers["same_concept"]
    expect(answer?.type).toBe("choice")
    expect(answer?.type === "choice" ? answer.choice : undefined).toBe("one")

    // The labelled joggle entry reached the provider as one instruction string,
    // and the criteria descriptions as strings, because `Decision` carries text.
    const questions = sent[0]?.["questions"]
    const first = isRecord(questions) ? Object.values(questions)[0] : undefined
    expect(isRecord(first) ? typeof first["instructions"] : undefined).toBe("string")
    const criteria = isRecord(first) ? first["criteria"] : undefined
    expect(isRecord(criteria) ? Object.values(criteria).every((value) => typeof value === "string") : false).toBe(true)
  }).pipe(Effect.provide(nodeLayer)),
)


