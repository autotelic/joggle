import { duplicateImplementation } from "./duplicate-implementation.ts"
import { duplicateMeaning } from "./duplicate-meaning.ts"
import { namingDrift } from "./naming-drift.ts"
import type { Rule } from "../rule.ts"

/**
 * The registry. Add a rule by writing one file and one line here.
 *
 * Deterministic rules first, so that a run without an API key still produces
 * the findings it can prove.
 */
export const allRules: ReadonlyArray<Rule> = [duplicateImplementation, duplicateMeaning, namingDrift]

export const ruleById = (id: string): Rule | undefined => allRules.find((rule) => rule.id === id)
