import type { Effect } from "effect"
import type { Service as JudgeService } from "./judge.ts"
import type { Diagnostic, JudgeError, Severity, SourceLocation } from "./schema.ts"
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
}): Diagnostic => ({
  ruleId: input.ruleId,
  severity: input.severity,
  message: input.message,
  location: input.location,
  judged: input.judged,
  ...(input.help === undefined ? {} : { help: input.help }),
  ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
})

/** Short, human-readable "file:line:col" for messages. */
export const at = (location: SourceLocation): string =>
  `${location.file}:${location.line}:${location.column}`
