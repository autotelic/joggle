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
export interface Rule {
  readonly id: string
  readonly severity: Severity
  readonly description: string
  /** Whether this rule needs the judge. Deterministic rules must run without it. */
  readonly judged: boolean
  readonly run: (
    workspace: Workspace,
  ) => Effect.Effect<ReadonlyArray<Diagnostic>, JudgeError, JudgeService>
}

export const defineRule = (rule: Rule): Rule => rule

export interface Pair<A> {
  readonly left: A
  readonly right: A
}

/**
 * Two declarations considered together, with the deterministic score that
 * nominated them. Rules share it so that "what a candidate is" has one answer.
 */
export interface UnitPair {
  readonly left: Unit
  readonly right: Unit
  readonly score: number
}

/** Every unordered pair, in a deterministic order. */
export const pairsOf = <A>(items: ReadonlyArray<A>): ReadonlyArray<Pair<A>> => {
  const out: Array<Pair<A>> = []
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const a = items[left]
      const b = items[right]
      if (a !== undefined && b !== undefined) out.push({ left: a, right: b })
    }
  }
  return out
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
