import { expect, test } from "vitest"
import { cacheKeyFor } from "../src/judge.ts"
import type { JudgeRequest } from "../src/judge.ts"

const request = (evidence: unknown, repository?: string): JudgeRequest => ({
  ...(repository === undefined ? {} : { repository }),
  evidence,
  questions: {
    verdict: { type: "choice", instructions: "Should this change?", criteria: { a: "It should." } },
  },
})

const evidence = { file: "src/a.ts" }

test("the declared architecture is part of the key, by construction", () => {
  // It used to be a second argument to this function, and forgetting to pass it
  // replayed every verdict made under the previous architecture. It is now a
  // field of the thing being keyed, so there is nothing to forget.
  const under = cacheKeyFor(request(evidence, "Pages compose bundles."))
  const other = cacheKeyFor(request(evidence, "There is no React here."))
  expect(other).not.toBe(under)
})

test("declaring no architecture is not the same as declaring an empty one", () => {
  expect(cacheKeyFor(request(evidence))).not.toBe(cacheKeyFor(request(evidence, "")))
})

test("the key is stable for the same request", () => {
  expect(cacheKeyFor(request(evidence, "x"))).toBe(cacheKeyFor(request(evidence, "x")))
})

test("the key follows the evidence and the questions", () => {
  expect(cacheKeyFor(request({ file: "src/a.ts" }, "x"))).not.toBe(
    cacheKeyFor(request({ file: "src/b.ts" }, "x")),
  )
  const question = (text: string): JudgeRequest => ({
    evidence,
    questions: { verdict: { type: "noul", instructions: text } },
  })
  expect(cacheKeyFor(question("one?"))).not.toBe(cacheKeyFor(question("two?")))
})

test("property order in the evidence does not change the key", () => {
  // A judgement must not miss its own cache because a state object was built in a
  // different order, which is what canonicalisation is for.
  expect(cacheKeyFor(request({ a: 1, b: 2 }))).toBe(cacheKeyFor(request({ b: 2, a: 1 })))
})
