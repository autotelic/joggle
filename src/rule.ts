import type { Effect } from "effect"
import type { Service as JudgeService } from "./judge.ts"
import type { Answer, Diagnostic, JudgeError, Severity, SourceLocation } from "./schema.ts"
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
}

export const outcome = (
  diagnostics: ReadonlyArray<Diagnostic>,
  notes: ReadonlyArray<string> = [],
): RuleOutcome => ({ diagnostics, notes })

export interface Rule {
  readonly id: string
  readonly severity: Severity
  readonly description: string
  /** Whether this rule needs the judge. Deterministic rules must run without it. */
  readonly judged: boolean
  readonly run: (workspace: Workspace) => Effect.Effect<RuleOutcome, JudgeError, JudgeService>
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
}): Diagnostic => ({
  ruleId: input.ruleId,
  severity: input.severity,
  message: input.message,
  location: input.location,
  judged: input.judged,
  ...(input.help === undefined ? {} : { help: input.help }),
  ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
  ...(input.score === undefined ? {} : { score: input.score }),
})

/**
 * The one question every rule asks, and the only answer code reads.
 *
 * It lived in each rule file until joggle reported its own copy of it three
 * times. That is the tool working: the shape was identical, the names were
 * identical, and nothing about the three copies was intentional.
 */
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

/** Short, human-readable "file:line:col" for messages. */
export const at = (location: SourceLocation): string =>
  `${location.file}:${location.line}:${location.column}`
