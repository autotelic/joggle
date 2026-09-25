import { policy } from "./policy.ts"

/**
 * Whether a question is worth its gate.
 *
 * abide's calibration, kept whole: a question answers near 0 or near 1 on real
 * states when it is decisive; a question whose answers sit in the middle is weak
 * (it is guessing); a question that fires on most states is noisy (its criteria
 * are too loose). Below a handful of states there is nothing to say.
 *
 * `fired` uses joggle's own act threshold, so "noisy" means the same thing here
 * as it does in a run.
 */
const MIN_STATES = 5
/** Below this a "no" is confident. */
const CONFIDENT_NO = 0.25
/** At or above this a "yes" is clear. */
const CLEAR_YES = 0.7
/** Firing on this share of states is a question that says yes to everything. */
const NOISY_RATE = 0.6

export type CalibrationVerdict = "decisive" | "weak" | "noisy" | "skipped"

export interface CalibrationSummary {
  readonly states: number
  readonly median: number
  readonly min: number
  readonly max: number
  readonly fired: number
  readonly verdict: CalibrationVerdict
}

const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  const low = sorted[middle - 1] ?? 0
  const high = sorted[middle] ?? 0
  return (low + high) / 2
}

/**
 * Summarize one question's answers over real states.
 *
 * @param probabilities - P(violated) for each state the rule produced a candidate
 *   on, reduced by `verdictOf` with the plan's declared violating labels.
 * @returns the counts and the verdict: decisive, weak, noisy, or skipped when
 *   there were too few states to say.
 */
export const summarizeCalibration = (probabilities: ReadonlyArray<number>): CalibrationSummary => {
  const states = probabilities.length
  const med = median(probabilities)
  const min = states === 0 ? 0 : Math.min(...probabilities)
  const max = states === 0 ? 0 : Math.max(...probabilities)
  const fired = probabilities.filter((value) => value >= policy.decision.gates.probabilityFloor).length
  let verdict: CalibrationVerdict
  if (states < MIN_STATES) verdict = "skipped"
  else if (fired / states >= NOISY_RATE) verdict = "noisy"
  else if (max < CLEAR_YES && med >= CONFIDENT_NO) verdict = "weak"
  else verdict = "decisive"
  return { states, median: med, min, max, fired, verdict }
}
