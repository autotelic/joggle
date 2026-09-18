import { expect, test } from "vitest"
import { cacheKeyFor } from "../src/judge.ts"
import type { JudgeRequest } from "../src/judge.ts"

const request = (evidence: unknown): JudgeRequest => ({
  evidence,
  questions: {
    verdict: { type: "choice", instructions: "Should this change?", criteria: { a: "It should." } },
  },
})

const evidence = { file: "src/a.ts" }

test("the same evidence under a different declared architecture is a different judgement", () => {
  // Editing joggle.config.json's evidence.repository used to replay every cached
  // verdict, because the context reached the model but not the cache key.
  const under = cacheKeyFor(request(evidence), "Pages compose bundles.")
  const other = cacheKeyFor(request(evidence), "There is no React here.")
  expect(other).not.toBe(under)
})

test("declaring no architecture is not the same as declaring an empty one", () => {
  expect(cacheKeyFor(request(evidence), undefined)).not.toBe(cacheKeyFor(request(evidence), ""))
})

test("the key is stable for the same request and the same architecture", () => {
  expect(cacheKeyFor(request(evidence), "x")).toBe(cacheKeyFor(request(evidence), "x"))
})

test("the key still follows the evidence and the questions", () => {
  const one = cacheKeyFor(request({ file: "src/a.ts" }), "x")
  const other = cacheKeyFor(request({ file: "src/b.ts" }), "x")
  expect(other).not.toBe(one)
})
