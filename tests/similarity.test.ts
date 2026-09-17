import { expect, it } from "@effect/vitest"
import { allPairs, shinglesOf, similarityOf } from "../src/similarity.ts"
import { sweep } from "../src/rule.ts"

/** Deterministic PRNG, so a failure is reproducible rather than a coin toss. */
const lcg = (seed: number) => {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

const vocabulary = Array.from({ length: 400 }, (_, index) => `s${index}`)

const makeSet = (random: () => number, size: number): ReadonlySet<string> => {
  const set = new Set<string>()
  while (set.size < size) set.add(vocabulary[Math.floor(random() * vocabulary.length)] ?? "s0")
  return set
}

const corpus = (seed: number): ReadonlyArray<ReadonlySet<string>> => {
  const random = lcg(seed)
  const sets: Array<ReadonlySet<string>> = []
  for (let index = 0; index < 600; index += 1) {
    sets.push(makeSet(random, 5 + Math.floor(random() * 25)))
  }
  // Near-duplicates the join must find: a copy of an existing set plus a couple
  // of shingles nobody else has, which is exactly the case prefix filtering is
  // built to notice.
  for (let index = 0; index < 80; index += 1) {
    const base = sets[index]
    if (base === undefined) continue
    const copy = new Set(base)
    copy.add(`unique${index}a`)
    copy.add(`unique${index}b`)
    sets.push(copy)
  }
  return sets
}

const key = (a: number, b: number): string => `${Math.min(a, b)}-${Math.max(a, b)}`

/** Every pair inside the size window, scored. Complete by construction. */
const complete = (
  sets: ReadonlyArray<ReadonlySet<string>>,
  threshold: number,
): ReadonlyArray<string> => {
  const ordered = sets
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value.size - b.value.size || a.index - b.index)
  const found: Array<string> = []
  sweep(
    ordered,
    (value) => value.size,
    threshold,
    (a, b) => {
      if (similarityOf(a.value, b.value) >= threshold) found.push(key(a.index, b.index))
    },
  )
  return found.sort()
}

it("prefix filtering finds exactly the pairs the complete sweep finds", () => {
  for (const seed of [7, 99, 1234]) {
    const sets = corpus(seed)
    const fast = allPairs(
      sets.map((shingles, index) => ({ index, shingles })),
      0.7,
    )
      .map((pair) => key(pair.left, pair.right))
      .sort()
    expect(fast).toEqual(complete(sets, 0.7))
  }
})

it("prefix filtering stays complete at a looser threshold too", () => {
  const sets = corpus(11)
  const fast = allPairs(
    sets.map((shingles, index) => ({ index, shingles })),
    0.3,
  )
    .map((pair) => key(pair.left, pair.right))
    .sort()
  expect(fast).toEqual(complete(sets, 0.3))
})

it("it is much cheaper than comparing every pair in the window", () => {
  const sets = corpus(7)
  const index = sets.map((shingles, position) => ({ index: position, shingles }))
  let windowPairs = 0
  const ordered = index
    .map((entry) => ({ value: entry, index: entry.index }))
    .sort((a, b) => a.value.shingles.size - b.value.shingles.size || a.index - b.index)
  sweep(
    ordered,
    (value) => value.shingles.size,
    0.7,
    () => {
      windowPairs += 1
    },
  )
  expect(allPairs(index, 0.7).length).toBeLessThan(windowPairs / 4)
})

it("finds pairs a token-length window would drop", () => {
  // The old sweep windowed on token COUNT while similarity is computed over
  // shingle SETS. Repetition makes the two diverge -- two hundred tokens can
  // hold forty-five distinct bigrams -- and the window then drops genuine
  // matches. On one real codebase it dropped 382 of them. This is that shape.
  const base = new Set(Array.from({ length: 40 }, (_, index) => `s${index}`))
  const grown = new Set(base)
  for (let index = 0; index < 5; index += 1) grown.add(`extra${index}`)
  const narrow = base
  const wide = grown

  expect(similarityOf(narrow, wide)).toBeGreaterThan(0.7)

  const sets = [narrow, wide]
  const tokenLengths = [100, 200]
  const shingleSized = allPairs(
    sets.map((shingles, index) => ({ index, shingles })),
    0.7,
  )
  const tokenWindow = (() => {
    const ordered = sets
      .map((shingles, index) => ({ value: { shingles, tokens: tokenLengths[index] ?? 0 }, index }))
      .sort((a, b) => a.value.tokens - b.value.tokens || a.index - b.index)
    const found: Array<string> = []
    sweep(
      ordered,
      (value) => value.tokens,
      0.7,
      (a, b) => {
        if (similarityOf(a.value.shingles, b.value.shingles) >= 0.7) found.push(key(a.index, b.index))
      },
    )
    return found
  })()

  expect(shingleSized.map((pair) => key(pair.left, pair.right))).toEqual(["0-1"])
  expect(tokenWindow).toEqual([])
})

it("token shingles behave like the sets the join expects", () => {
  const a = shinglesOf(["return", "_", ".", "_"].map(String))
  const b = shinglesOf(["return", "_", ".", "_"].map(String))
  expect(similarityOf(a, b)).toBe(1)
  expect(similarityOf(a, shinglesOf(["return", "_"]))).toBeGreaterThan(0)
})
