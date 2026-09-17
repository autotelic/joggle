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

  /**
   * Bump this when rule LOGIC changes. Question versioning covers the wording of
   * a question; it cannot cover a candidate filter, a clustering rule or a
   * threshold, and those change the output while leaving every question byte
   * identical. The unchanged-run short-circuit keys on this, so failing to bump
   * it means a stale report is replayed after the rules have moved.
   */
  analysisVersion: "2026-09-05",

  judge: {
    baseUrl: "https://api.typesafe.ai",
    /** How long a successful judgement stays fresh, in days. */
    timeToLiveDays: 30,
    /**
     * Candidates per request. ONE, and the measurement is why.
     *
     * The parallel-questions cookbook reports batching 13 questions onto one
     * shared document as 12.2x cheaper and 10x faster with no change in answers,
     * and it says exactly when that applies: "the document dominates every
     * request, so N single-question calls pay for it N times... The bigger the
     * document, the closer the saving gets to a full Nx."
     *
     * Our candidates are not one shared document. They are different clusters
     * with different evidence, so there is nothing to amortise -- the saving is
     * the per-request boilerplate and nothing else. Measured on 80 identical
     * requests judged both ways:
     *
     *   unbatched   80 calls   101,903 input tokens
     *   batched      5 calls    82,091 input tokens   (19%, not 12x)
     *   identical verdicts: 37/80 = 46%
     *
     * And the disagreements were systematic rather than noisy: redundancy
     * scores fell by 0.05-0.10 across the board, and `member_0` started winning
     * the canonical choice far more often. That is context rot and position
     * bias, exactly what the primitives page warns about when it says to give
     * each question only the context it needs.
     *
     * So batching is OFF by default and the speed comes from concurrency, which
     * is the other pattern the docs prescribe -- the re-ranking cookbook fires
     * 1,200 independent calls through a thread pool and calls it cheap. The
     * batching machinery stays because it is the right lever for a state that IS
     * shared, such as a naming family judged one member per question.
     */
    batchCandidates: 1,
    /** Independent requests in flight at once. */
    requestConcurrency: 16,
    /** Token budget for one request when batching is used. Around 32,000 is the
     *  API limit, shared between state and questions. */
    batchTokens: 20000,
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
   * When a page's own state and markup look like they belong in a bundle.
   *
   * These are TRIGGERS, not verdicts. The first version of this rule treated
   * every file under `routes/` as a page that should conform, which produced
   * 1,216 candidates against Shakti's 280 real route and modal files, flagged
   * 392 of them, and gave the model almost nothing to be confident about: 237 of
   * the flagged pages scored under 0.3. A page that composes local components
   * and shares no state needs no bundle, so the rule now asks only about pages
   * under actual state pressure.
   */
  pageNeedsComposition: {
    /** useState calls before a page's state looks like a provider's business. */
    minLocalState: 3,
    /** Inline JSX elements before a page's markup looks like someone's block. */
    minInlineElements: 15,
    maxPages: 400,
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
    // Nested checkouts, as this repository keeps them: analysing them as part of
    // the parent repo reports the child's own demo pages as the parent's.
    "repos",
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
