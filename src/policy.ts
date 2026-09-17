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
    /**
     * Clusters sent for judgement in one run.
     *
     * This used to cap *pairs*, applied by sorting them by similarity and
     * slicing. That is a selection, not a bound: on one codebase forty
     * high-scoring pairs elsewhere in the tree spent the whole budget and the
     * eighteen definitions of `formatDate` were never compared at all. Pair
     * generation is now complete up to a provable length filter, and the only
     * remaining bound is on how many clusters get judged -- with the overflow
     * named in the report rather than dropped.
     */
    maxClusters: 400,
  },

  /** Clusters sent for judgement in one run. Overflow is reported unverified. */
  duplicateImplementation: {
    maxClusters: 500,
  },

  /**
   * Name-family search.
   *
   * A pair of names is judged on its own; the rule does not cluster, because
   * "is this name another spelling of that one" is a question about two things.
   * Union-find over a non-transitive relation chained every `*Modal` in one
   * codebase into a single eighty-seven member "concept", which is not a
   * judgement anyone can make or act on.
   */
  namingDrift: {
    /** Name-root overlap below which a pair is not worth a call. */
    minScore: 0.5,
    /**
     * Words two names must share beyond a category noun. `AddContactModal` and
     * `DeleteTaskModal` share one word and are two members of a category; two
     * spellings of one concept share at least two.
     */
    minSharedWords: 2,
    /**
     * High on purpose. Name pairs are cheap to enumerate and cheap to judge, and
     * a budget that truncates 1,564 of 1,864 real candidates is a bigger problem
     * than the time it saves: it hides the rule's actual yield. Raise the
     * evidence cost or tighten the candidate filter instead of capping this.
     */
    maxClusters: 4000,
  },

  /**
   * How much of a cluster is described to the model.
   *
   * A cluster of two hundred declarations is one decision but not one question:
   * sending every member's source blew the request budget and the API answered
   * 400. The first N members are described and the rest are counted, so the
   * decision still stands on the whole cluster even when the detail is bounded.
   */
  evidence: {
    maxMembers: 12,
    maxSourceChars: 1500,
    /** Characters of a doc comment kept as evidence. */
    maxDocChars: 400,
    /** Paths listed in a finding's help before it says "and N more". */
    maxListedPaths: 4,
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
