/**
 * Every tunable number and every judgement version lives in this file.
 *
 * The TypeSafe documentation is explicit about this: the questions and the
 * thresholds are the only parts a human has to review, so they belong in one
 * place you can read in a diff. Rules import from here; a rule never inlines a
 * magic number.
 */

export const policy = {
  /** Surfaced by `joggle --version`. */
  version: "0.1.0",

  /** The System One model every rule judges with. */
  model: "jev-latest",

  /**
   * Bump this whenever a question's wording or criteria change. It is part of
   * the judgement cache key, so bumping it invalidates every cached answer
   * instead of silently replaying verdicts produced by older questions.
   */
  questionVersion: "2026-09-01",

  judge: {
    baseUrl: "https://api.typesafe.ai",
    /** In-memory judgement cache capacity. */
    capacity: 4096,
    /** How long a successful judgement stays fresh, in days. */
    timeToLiveDays: 30,
  },

  /**
   * joggle/duplicate-meaning: are these two implementations the same thing?
   *
   * Weights apply to Noul probabilities and are combined in code. The catalogue
   * of scores is deliberately visible so that when verdicts stop matching what
   * the team would decide, you change a weight here and re-run rather than
   * rewriting a prompt.
   */
  duplicateMeaning: {
    /** Lower bound on structural overlap before a pair is worth judging. */
    minSimilarity: 0.7,
    /**
     * Very short bodies score high on bigram overlap by accident. Judging them
     * costs a call and teaches nothing, so they are not candidates.
     */
    minTokens: 12,
    /** Upper bound: at 1.0 the deterministic rule already owns the finding. */
    maxSimilarity: 0.995,
    /** Bound on how many pairs one run may send to the model. */
    maxPairs: 40,
    /** Composite score required before we report. */
    activationScore: 0.7,
    /** Ceiling on the probability that merging would change behaviour. */
    maxMergeRisk: 0.4,
    /** Ceiling on the probability that one is a deliberate specialization. */
    maxSpecialization: 0.45,
    weights: {
      sameConcept: 0.45,
      sameBehavior: 0.45,
      notSpecialization: 0.1,
    },
  },

  /** joggle/naming-drift: do these two names refer to the same concept? */
  namingDrift: {
    /** Lower bound on name-root overlap before a pair is worth judging. */
    minScore: 0.5,
    maxPairs: 30,
    /** Noul probability required before we treat two names as one concept. */
    sameConceptThreshold: 0.7,
    /** Choice confidence required to nominate a canonical spelling. */
    confidenceFloor: 0.5,
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
