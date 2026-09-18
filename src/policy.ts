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
  questionVersion: "2026-09-08",

  /**
   * The declared analysis version: a FALLBACK and an OVERRIDE, not the gate.
   *
   * This used to be the gate, and a hand-bumped gate is a promise to remember.
   * Forgetting it means the next run replays a report produced by rules that no
   * longer exist -- which happened twice in one session, and both times the output
   * looked entirely plausible, because a stale report is not malformed, it is just
   * wrong.
   *
   * The unchanged-run short-circuit now keys on a hash of the tool's own source
   * (see fingerprint.ts), so a change to a rule, a threshold or a question cannot
   * be missed. Question versioning still covers question WORDING, because the
   * judgement cache keys on it directly.
   *
   * This string survives for the case a hash cannot serve: when the sources cannot
   * be read, so a run in an unusual installation degrades to the old behaviour
   * rather than breaking.
   *
   * There is deliberately no way to opt out of the hash yet. A cosmetic edit
   * therefore invalidates the run cache, which is the conservative direction: the
   * cost is re-analysis, the cost of the other direction is a wrong report. An
   * override that skips the hash is the obvious next step and does not exist.
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
    /**
     * How good an answer has to be before a rule may act on it.
     *
     * A Noul is a yes/no question, so its probability is a VERDICT, not a
     * ranking: 0.2 is the model saying no. Nothing read that. `worth_fixing` and
     * `one_concept` and `redundant` were kept only as sort keys while the Choice
     * decided, so on Shakti 237 findings were reported where the model had
     * already answered "not worth a reviewer's time" and been overruled by a
     * different question.
     *
     * The margin is winner minus runner-up in the Choice's own distribution:
     * whether the model picked an option or shrugged across two. Raw `confidence`
     * measured uninformative here and is still only reported, but `probabilities`
     * arrived with every answer from the first day and nothing ever read it.
     */
    gates: {
      noulFloor: 0.5,
      minMargin: 0.25,
    },
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

  /**
   * Field-set composition analysis.
   *
   * Both numbers bound SEARCH, not judgement: this rule is deterministic and
   * compares sets, so the only question is how many types one run will look at.
   */
  composeTypes: {
    /** Fewer than this and a shared field set means nothing. */
    minFields: 3,
    /** Types compared per run. Beyond this the report says what it skipped. */
    maxTypes: 4000,
  },

  /**
   * Package-and-dependency pairs sent for judgement in one run.
   *
   * The candidate set is small by construction -- distinct pairs, not import
   * statements -- so this is a ceiling against a pathological repository rather
   * than a budget anybody should reach.
   */
  dependencyFit: {
    maxDependencies: 400,
  },

  /**
   * Declarations sent for judgement in one run.
   *
   * The candidate filter is structural and deliberately narrow -- an exported
   * function, not a component, not a framework export, with enough in it to hold
   * a rule -- so this is a ceiling rather than a budget.
   */
  hoistToDomain: {
    maxDeclarations: 600,
    /** Tokens below which a declaration cannot be holding a rule. */
    minTokens: 40,
  },

  duplicateImplementation: {
    maxClusters: 500,
    /**
     * Tokens below which a declaration is too small to be a duplicate of
     * anything.
     *
     * Shape equality is exact, so this rule had no floor at all and grouped
     * `type ErrorResponse = any` with `type ShippingTax = any` -- three
     * one-line placeholders in two different apps, reported as "they are one
     * thing". They are not; they are both `any`. The near-duplicate rule has
     * carried a floor for this reason from the start.
     */
    minTokens: 8,
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

  /**
   * What a test file looks like.
   *
   * Test files were 24 of 196 findings on one real repository, and the worst of
   * them are not wrong: a factory or a fixture helper is SUPPOSED to be repeated,
   * because that is what makes it a factory. A linter that reports it is
   * reporting the technique. jev carries this regex; joggle had no notion of a
   * test file at all, so a spec's helpers were held to the same standard as an
   * API's.
   */
  testFiles: /(?:^|\/)(?:tests?|__tests__|specs?)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/,

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
