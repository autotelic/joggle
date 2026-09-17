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
    /** Ceiling on the probability that one is a deliberate specialization. */
    maxSpecialization: 0.45,
    /**
     * `merge_changes_behavior` used to be asked and used as a hard veto. Across
     * 49 real judgements it never once fell below 0.4 (min 0.19, mean 0.64):
     * asked whether replacing one function with another could change behaviour
     * for some caller, with no call sites in the state, the model always says
     * "probably yes". A question whose answer is decided before it is asked is
     * not a judgement, it is a constant. Behaviour is now only asked about
     * where it is genuinely open (the near-duplicate band), and never as a veto.
     */
    weights: {
      sameConcept: 0.6,
      sameBehavior: 0.3,
      notSpecialization: 0.1,
    },
  },

  /**
   * Verification of exact-shape duplicates. Here equality is a fact, so the
   * only open question is intent -- redundant, or two domains that look alike.
   */
  duplicateImplementation: {
    /**
     * Below this, the two names are judged to mean different things, so the
     * shape match is a coincidence rather than duplication.
     */
    nameDivergenceFloor: 0.35,
    /** A confident "keep both" suppresses the finding. */
    keepBothConfidence: 0.8,
    /**
     * This block used to suppress when the two declarations sat in different
     * areas and neither was a general-purpose utility. Measured over 500 real
     * verdicts that gate removed 284 candidates -- including, at the top of the
     * list, a type named `GhostProjectSummary` declared once in the API and once
     * in the UI, where the model itself answered sameName 0.97 and "keep left".
     * Two declarations of one name in two areas is not evidence of intentional
     * separation; it is the exact thing docs/names.md argues against. The gate
     * inverted a correct judgement, so it is gone: the model may only override
     * the deterministic fact when it is confident, never on locality.
     */
    /** Bound on verification calls per run. Over-budget candidates are still
     *  reported, marked unverified, so a budget never silently deletes a finding. */
    maxJudgements: 500,
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
