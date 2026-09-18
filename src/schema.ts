import { Schema } from "effect"

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

export const Severity = Schema.Literals(["error", "warn", "info"])

export type Severity = Schema.Schema.Type<typeof Severity>

/** A resolvable place in the source. `line` and `column` are 1-based. */
export const SourceLocation = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  endLine: Schema.optionalKey(Schema.Number),
  endColumn: Schema.optionalKey(Schema.Number),
})

export interface SourceLocation extends Schema.Schema.Type<typeof SourceLocation> {}

/**
 * The only thing joggle produces. Everything else -- scanning, candidate
 * generation, judgement -- exists to manufacture one of these, in the same
 * shape a linter or a typechecker emits so that hosts do not have to care
 * which kind of rule produced it.
 */
export const Diagnostic = Schema.Struct({
  ruleId: Schema.String,
  severity: Severity,
  message: Schema.String,
  help: Schema.optionalKey(Schema.String),
  location: SourceLocation,
  /**
   * Present only when a judgement produced this diagnostic. Absent means the
   * rule was deterministic, which is itself useful information for a reader.
   */
  confidence: Schema.optionalKey(Schema.Number),
  /**
   * How strongly the judgement says this is real, as a Noul probability. Unlike
   * `confidence` (which summarises how peaked the Choice distribution was, and
   * measured uninformative) this is comparable across every finding in a run,
   * so it is what the report sorts by.
   */
  score: Schema.optionalKey(Schema.Number),
  /**
   * A stable name for this finding, for comparing runs.
   *
   * Built from the rule and the cluster's membership, never from line numbers:
   * code moves constantly, and a baseline that reports every edit as a new
   * finding is a baseline nobody reads. A rename or a new member does change it,
   * which is correct -- the finding is a different finding then.
   */
  identity: Schema.optionalKey(Schema.String),
  judged: Schema.Boolean,
})

export interface Diagnostic extends Schema.Schema.Type<typeof Diagnostic> {}

/* -------------------------------------------------------------------------- */
/* System One wire contract                                                    */
/* -------------------------------------------------------------------------- */

/**
 * TypeSafe accepts JSON structure wherever prose gets blurry: instructions,
 * Choice option descriptions, Score levels and Noul criteria. Labelled fields
 * ("question", "compare", "focus") make a decision boundary easier to review
 * than one dense sentence, and the model is trained on the structure.
 */
export const Entry = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.Unknown),
  Schema.Array(Schema.Unknown),
])

export const NoulQuestion = Schema.Struct({
  type: Schema.tag("noul"),
  instructions: Entry,
  criteria: Schema.optionalKey(
    Schema.Struct({
      true: Entry,
      false: Entry,
    }),
  ),
})

export const ChoiceQuestion = Schema.Struct({
  type: Schema.tag("choice"),
  instructions: Entry,
  criteria: Schema.Record(Schema.String, Schema.NullOr(Entry)),
})

export const Question = Schema.Union([NoulQuestion, ChoiceQuestion])

export type Question = Schema.Schema.Type<typeof Question>

export const Answer = Schema.Union([
  Schema.Struct({
    type: Schema.tag("noul"),
    noul: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.tag("choice"),
    choice: Schema.String,
    probabilities: Schema.Record(Schema.String, Schema.Number),
    confidence: Schema.Number,
  }),
])

export type Answer = Schema.Schema.Type<typeof Answer>
export type NoulAnswer = Extract<Answer, { readonly type: "noul" }>
export type ChoiceAnswer = Extract<Answer, { readonly type: "choice" }>

export const SystemOneRequest = Schema.Struct({
  state: Schema.Unknown,
  model: Schema.String,
  questions: Schema.Record(Schema.String, Question),
})

export type SystemOneRequest = Schema.Schema.Type<typeof SystemOneRequest>

export const SystemOneResponse = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(Schema.String, Answer),
  usage: Schema.optionalKey(
    Schema.Struct({
      input_tokens: Schema.Number,
      output_tokens: Schema.Number,
    }),
  ),
})

export interface SystemOneResponse extends Schema.Schema.Type<typeof SystemOneResponse> {}

/**
 * The judgement cache key. It contains everything the answer depends on --
 * including the question version -- so a cache hit can be replayed in CI with
 * no API key and no network.
 */
export const JudgeCacheKey = Schema.Struct({
  questionVersion: Schema.String,
  model: Schema.String,
  evidence: Schema.Unknown,
  questions: Schema.Record(Schema.String, Question),
})

export interface JudgeCacheKey extends Schema.Schema.Type<typeof JudgeCacheKey> {}

/** A rule id and a reason: a skip, or a bound a rule hit. */
export const Note = Schema.Struct({
  ruleId: Schema.String,
  reason: Schema.String,
})

export interface Note extends Schema.Schema.Type<typeof Note> {}

/**
 * How a candidate ended up not being reported.
 *
 * Every bound and every gate in this program is a decision not to look at
 * something or not to say it, and a decision nobody can see is indistinguishable
 * from a bug: the eighteen definitions of one helper stayed invisible for three
 * runs because a cap discarded them silently.
 *
 * The stages are a closed set on purpose, so counts mean the same thing in every
 * rule. A candidate that failed a gate and one that was never looked at are
 * different facts, and mixing them into one number would hide exactly the
distinction worth seeing.
 */
export const DropStage = Schema.Literals([
  /** The model declined: it looked and found nothing. */
  "declined",
  /** The answer failed a gate. */
  "gated",
  /** No usable answer came back for this candidate. */
  "unreadable",
  /** The rule never asked: there was nothing to send. */
  "no_evidence",
  /** The run's budget ran out before this candidate. */
  "budget",
])

export type DropStage = Schema.Schema.Type<typeof DropStage>

export const Drop = Schema.Struct({
  ruleId: Schema.String,
  /** The candidate, named the way the rule names it. */
  subject: Schema.String,
  stage: DropStage,
  /** Why, in the rule's own words. */
  reason: Schema.String,
})

export interface Drop extends Schema.Schema.Type<typeof Drop> {}

export const JudgeTotals = Schema.Struct({
  requests: Schema.Number,
  replayed: Schema.Number,
  calls: Schema.Number,
  unavailable: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
})

export interface JudgeTotals extends Schema.Schema.Type<typeof JudgeTotals> {}

/**
 * The previous run, kept whole so an unchanged repository costs nothing.
 *
 * `manifest` is a hash of everything the output depends on: the analysis and
 * question versions, the model, the rule set, and the content of every analysed
 * file. If it matches, the run is over before a single file is parsed.
 */
export const StoredRun = Schema.Struct({
  version: Schema.String,
  manifest: Schema.String,
  diagnostics: Schema.Array(Diagnostic),
  /**
   * Content hash per analysed file, so the NEXT run can say which files moved.
   *
   * The manifest says whether anything changed; this says what did, which is
   * what lets a run scope itself to the change instead of re-deriving findings
   * about code nobody touched.
   */
  sources: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      hash: Schema.String,
      /**
       * Exported names, so the next run can tell a body edit from an interface
       * edit: only the latter can move what a dependent's type names resolve to.
       */
      exports: Schema.Array(Schema.String),
    }),
  ),
  files: Schema.Number,
  rules: Schema.Number,
  skipped: Schema.Array(Note),
  notes: Schema.Array(Note),
  /**
   * Candidates this run considered and did not report, with the reason.
   *
   * Optional so a run stored before this existed still replays: reading
   * defensively and writing strictly is what keeps a cache an optimisation
   * rather than a compatibility problem.
   */
  drops: Schema.optionalKey(Schema.Array(Drop)),
  judge: JudgeTotals,
  elapsedMs: Schema.Number,
})

export interface StoredRun extends Schema.Schema.Type<typeof StoredRun> {}

/**
 * The findings a repository has already accepted, so a later run can report
 * only what changed. Committed on purpose: the point is to compare against a
 * baseline that lives in the repository, not one that lives in a cache.
 */
export const Baseline = Schema.Struct({
  version: Schema.String,
  identities: Schema.Array(Schema.String),
})

export type Baseline = Schema.Schema.Type<typeof Baseline>

export const JudgeCacheFile = Schema.Struct({
  version: Schema.String,
  entries: Schema.Record(Schema.String, Schema.Record(Schema.String, Answer)),
})

export type JudgeCacheFile = Schema.Schema.Type<typeof JudgeCacheFile>

/* -------------------------------------------------------------------------- */
/* Typed errors                                                                */
/* -------------------------------------------------------------------------- */

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()(
  "joggle/WorkspaceError",
  {
    path: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class TsgoError extends Schema.TaggedError<TsgoError>()("joggle/TsgoError", {
  operation: Schema.String,
  detail: Schema.String,
}) {}

export class JudgeUnavailable extends Schema.TaggedError<JudgeUnavailable>()(
  "joggle/JudgeUnavailable",
  {
    reason: Schema.String,
  },
) {}

export class JudgeRejected extends Schema.TaggedError<JudgeRejected>()(
  "joggle/JudgeRejected",
  {
    status: Schema.Number,
    detail: Schema.String,
  },
) {}

export class JudgeMalformed extends Schema.TaggedError<JudgeMalformed>()(
  "joggle/JudgeMalformed",
  {
    detail: Schema.String,
  },
) {}

export class JudgeTransport extends Schema.TaggedError<JudgeTransport>()(
  "joggle/JudgeTransport",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {}

export type JudgeError =
  | JudgeUnavailable
  | JudgeRejected
  | JudgeMalformed
  | JudgeTransport
