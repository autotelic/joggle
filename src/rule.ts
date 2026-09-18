import type { Effect } from "effect"
import { policy } from "./policy.ts"
import type { JoggleConfig } from "./config.ts"
import type { Service as JudgeService } from "./judge.ts"
import type { Answer, Diagnostic, Drop, JudgeError, Severity, SourceLocation } from "./schema.ts"
import type { Unit, Workspace } from "./workspace.ts"

/**
 * A rule is a function from the deterministic workspace index to diagnostics.
 *
 * The interesting conventions are inside each rule, not in this interface:
 *
 *   find      deterministic, high recall, noise tolerated
 *   evidence  the panel a reviewer would need to decide
 *   questions atomic, typed, sent in one request
 *   policy    weights and thresholds, imported from policy.ts
 *   diagnose  span, message, help -- the product
 *
 * Deterministic rules simply never call the judge. That is the whole
 * difference; the output shape is identical, so a host cannot tell them apart.
 */
/**
 * What a rule produced, and what it declined to do.
 *
 * The notes are not decoration. Every bound in this program is a decision not to
 * look at something, and a bound nobody can see is indistinguishable from a bug:
 * the eighteen definitions of one helper stayed invisible for three runs because
 * a cap discarded them silently. A rule that hits a limit now says so, in its own
 * words, and the limit appears in the report beside the findings.
 */
export interface RuleOutcome {
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly notes: ReadonlyArray<string>
  /**
   * Candidates this rule considered and did not report, with the reason.
   *
   * The findings are the report; these are the funnel that produced it. A rule
   * that reports nothing is either a rule with nothing to look at or a rule
   * whose gate is too tight, and only this tells the two apart.
   */
  readonly drops: ReadonlyArray<Drop>
}

export const outcome = (
  diagnostics: ReadonlyArray<Diagnostic>,
  notes: ReadonlyArray<string> = [],
  drops: ReadonlyArray<Drop> = [],
): RuleOutcome => ({ diagnostics, notes, drops })

/**
 * How much of the workspace this run has to look at.
 *
 * Scoping is only sound for "what did this change introduce?". A new finding
 * always has at least one member whose content changed -- a change elsewhere
 * cannot create a duplicate between two declarations it did not touch -- so
 * restricting candidate generation to changed declarations loses nothing about
 * THIS change. It does lose the rest of the report, which is why a scoped run is
 * a different question and not a faster way to ask the same one.
 */
export interface Scope {
  /**
   * Files whose content changed since the stored run, plus the files that import
   * them (a change to a file's exports can move what a dependent's type names
   * resolve to). Undefined means every file.
   */
  readonly changed: ReadonlySet<string> | undefined
}

export const everyFile: Scope = { changed: undefined }

/** True when this declaration is in scope for the run. */
export const inScope = (scope: Scope, file: string): boolean =>
  scope.changed === undefined || scope.changed.has(file)

/**
 * What every rule is told about the run, beyond the code it is reading.
 *
 * The config belongs here rather than on the workspace because it describes the
 * repository's ARCHITECTURE, and a rule that enforces a layering is entitled to
 * know what the layering is. Rules that need nothing take two parameters and
 * ignore this one.
 */
export interface RunContext {
  readonly config: JoggleConfig
}

export interface Rule {
  readonly id: string
  readonly severity: Severity
  readonly description: string
  /** Whether this rule needs the judge. Deterministic rules must run without it. */
  readonly judged: boolean
  readonly run: (
    workspace: Workspace,
    scope: Scope,
    context: RunContext,
  ) => Effect.Effect<RuleOutcome, JudgeError, JudgeService>
}

export const defineRule = (rule: Rule): Rule => rule

/**
 * Standard wording for a bound a rule hit, so that no rule invents its own and
 * no reader has to guess whether silence meant "nothing there".
 */
export const budgetNote = (
  kind: string,
  judged: number,
  found: number,
  sample: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  found <= judged
    ? []
    : [
        `${found - judged} of ${found} ${kind} were not judged (budget ${judged}). Largest unjudged: ${sample.join("; ")}`,
      ]

/** One line for the producer rules: how many bundles were well formed. */
export const bundleNote = (bundles: number, broken: number): ReadonlyArray<string> =>
  bundles === 0 ? [] : [`${bundles - broken} of ${bundles} composition bundle(s) follow the pattern`]

/** A value together with its position in the workspace, for union-find below. */
export interface Sized<T> {
  readonly value: T
  readonly index: number
}

/**
 * Sweep a size-ordered list, visiting only the pairs that could clear a
 * similarity threshold.
 *
 * Kept as the reference implementation: it compares every pair inside the size
 * window, so it is complete by construction. `allPairs` in similarity.ts uses
 * prefix filtering to avoid the quadratic count, and a test asserts the two
 * report the same pairs. When they disagree, this one is right.
 *
 * Jaccard(A, B) >= t implies |A| / |B| >= t, because the intersection cannot be
 * larger than the smaller side. So once the list is sorted by size, each left
 * item has a known window of right items and the scan can stop at the first item
 * past it. That is a completeness-preserving filter: unlike sorting pairs by
 * score and slicing, it cannot drop a pair that would have qualified.
 */
export const sweep = <T>(
  ordered: ReadonlyArray<Sized<T>>,
  size: (value: T) => number,
  threshold: number,
  visit: (left: Sized<T>, right: Sized<T>) => void,
): number => {
  let compared = 0
  for (let i = 0; i < ordered.length; i += 1) {
    const left = ordered[i]
    if (left === undefined) continue
    const smaller = size(left.value)
    if (smaller === 0 || threshold <= 0) continue
    const limit = smaller / threshold
    for (let j = i + 1; j < ordered.length; j += 1) {
      const right = ordered[j]
      if (right === undefined) break
      if (size(right.value) > limit) break
      compared += 1
      visit(left, right)
    }
  }
  return compared
}

export const finding = (input: {
  readonly ruleId: string
  readonly severity: Severity
  readonly message: string
  readonly location: SourceLocation
  readonly judged: boolean
  readonly help?: string | undefined
  readonly confidence?: number | undefined
  readonly score?: number | undefined
  /** A stable name for this finding, for comparing one run against the next. */
  readonly identity?: string | undefined
}): Diagnostic => ({
  ruleId: input.ruleId,
  severity: input.severity,
  message: input.message,
  location: input.location,
  judged: input.judged,
  ...(input.help === undefined ? {} : { help: input.help }),
  ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
  ...(input.score === undefined ? {} : { score: input.score }),
  ...(input.identity === undefined ? {} : { identity: input.identity }),
})

/**
 * The one question every rule asks, and the only answer code reads.
 *
 * It lived in each rule file until joggle reported its own copy of it three
 * times. That is the tool working: the shape was identical, the names were
 * identical, and nothing about the three copies was intentional.
 */
/**
 * The names a judged question uses to decline, and the only two there are.
 *
 * The TypeSafe docs put `noIssue` in the mechanism map for EVERY dimension --
 * "The selected evidence does not support a concrete correctness issue". It sits
 * beside `condition` and `state` as a member of the vocabulary the model chooses
 * from, not as a low score or an absent answer. So a decline is an ANSWER, and
 * code can read it as one; that is the whole point. A question with no way to
 * decline still gets answered, just with a small number that means nothing.
 *
 * This rule set had four names for two ideas -- `not_duplication`, `distinct`,
 * `keep_local`, `none` -- which meant no shared reader, and no place to see that
 * a question could not say "this is fine". Two names now, used everywhere:
 *
 *   no_issue        there is no problem here
 *   not_applicable  the rule is looking at the wrong kind of thing
 *
 * A question that offers either documents it in `instructions.fallback`, so the
 * decline is stated rather than left to be inferred from the option list.
 */
export const decline = { noIssue: "no_issue", notApplicable: "not_applicable" } as const

/** Every name that means "no finding", for tests and for reading a vocabulary. */
export const declineNames: ReadonlyArray<string> = [decline.noIssue, decline.notApplicable]

/**
 * True when a Choice declined.
 *
 * An absent choice is NOT a decline: it is silence, and the two are treated
 * differently downstream -- a decline means the rule looked and found nothing,
 * silence means the rule never got an answer.
 */
export const declined = (choice: string | undefined): boolean =>
  choice === decline.noIssue || choice === decline.notApplicable

export const choiceOf = (
  answers: Readonly<Record<string, Answer>>,
  id: string,
): { readonly choice: string; readonly confidence: number } | undefined => {
  const answer = answers[id]
  return answer !== undefined && answer.type === "choice"
    ? { choice: answer.choice, confidence: answer.confidence }
    : undefined
}

/**
 * A Noul answer, used as a ranking score.
 *
 * The re-ranking cookbook is explicit that a Noul is the right primitive when
 * you need "a comparable score for every query-candidate pair... without
 * inventing a scoring scale". Every rule asks one, so the whole report sorts.
 */
export const noulOf = (
  answers: Readonly<Record<string, Answer>>,
  id: string,
): number | undefined => {
  const answer = answers[id]
  return answer !== undefined && answer.type === "noul" ? answer.noul : undefined
}

/**
 * Winner minus runner-up in a Choice's own distribution.
 *
 * A single option has nothing to be uncertain between, so its margin is 1; an
 * answer with no distribution at all has no margin, and a gate that cannot
 * measure should not fire.
 */
export const marginOf = (
  answers: Readonly<Record<string, Answer>>,
  id: string,
): number | undefined => {
  const answer = answers[id]
  if (answer === undefined || answer.type !== "choice") return undefined
  const ranked = Object.values(answer.probabilities).sort((left, right) => right - left)
  const [first, second] = ranked
  if (first === undefined) return undefined
  return second === undefined ? 1 : first - second
}

/** Why a judgement was not good enough to act on, or that it was. */
export interface JudgementQuality {
  readonly usable: boolean
  readonly reason: string
}

/**
 * Whether an answer may be acted on.
 *
 * A judgement that fails its gates is not a worse judgement, it is not a
 * judgement: callers treat it exactly as they treat an absent answer, which is
 * what keeps one gate from having to know how each rule degrades. A rule whose
 * finding is provable still reports it, marked unverified; a rule whose finding
 * is a guess stays silent.
 */
export const qualityOf = (input: {
  readonly score: number
  readonly margin: number | undefined
}): JudgementQuality => {
  const round = (value: number): string => value.toFixed(2)
  if (input.score < policy.judge.gates.noulFloor) {
    return { usable: false, reason: `the yes/no question answered no (${round(input.score)})` }
  }
  if (input.margin !== undefined && input.margin < policy.judge.gates.minMargin) {
    return { usable: false, reason: `the choice was not decisive (margin ${round(input.margin)})` }
  }
  return { usable: true, reason: "" }
}

/** Short, human-readable "file:line:col" for messages. */
export const at = (location: SourceLocation): string =>
  `${location.file}:${location.line}:${location.column}`
