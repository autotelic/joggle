/**
 * Configuration for the search, and nothing else.
 *
 * The first version of this file held sixteen numbers that *decided* things:
 * probability floors, weights for a hand-rolled composite score, confidence
 * gates. That is the entropy machine's disease with an API bill -- a person's
 * guess wearing a number, unreviewable and impossible to argue with, and the
 * reason the earlier rules could only be improved by fiddling.
 *
 * Every decision now belongs to exactly one Choice question, and code reads
 * `choice`. Numbers survive only where they bound *search*: how similar a pair
 * must be before it is worth a call, and how many calls a run may make. Those
 * are recall and cost knobs. Judging a candidate is the model's job; finding
 * candidates is the code's.
 */

export const policy = {
  /** Surfaced by `joggle --version`. */
  version: "0.1.0",

  /** The System One model every rule judges with. */
  model: "jev-latest",

  /**
   * Part of the judgement cache key. Bump it when a question's wording, options
   * or evidence change, so verdicts produced by older questions are not replayed
   * against newer ones.
   */
  questionVersion: "2026-09-02",

  judge: {
    baseUrl: "https://api.typesafe.ai",
    /** In-memory judgement cache capacity. */
    capacity: 4096,
    /** How long a successful judgement stays fresh, in days. */
    timeToLiveDays: 30,
  },

  /**
   * Near-duplicate search. These bound how many pairs are offered to the model,
   * never whether a pair is duplication.
   */
  duplicateMeaning: {
    /** Structural overlap below which a pair is not worth a call. */
    minSimilarity: 0.7,
    /** Very short bodies match by accident; skip them. */
    minTokens: 12,
    /** At 1.0 the exact-duplicate rule already owns the pair. */
    maxSimilarity: 0.995,
    /** Cost bound for one run. */
    maxPairs: 40,
  },

  /** Cost bound for one run. Over-budget candidates are reported unverified. */
  duplicateImplementation: {
    maxJudgements: 500,
  },

  /** Name-family search: which pairs of names are worth asking about. */
  namingDrift: {
    /** Name-root overlap below which a pair is not worth a call. */
    minScore: 0.5,
    maxPairs: 30,
  },

  /** Files and directories the workspace scan never enters. */
  ignoredDirectories: [
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".turbo",
    ".vercel",
    ".cache",
  ],
} as const

export type Policy = typeof policy
