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
