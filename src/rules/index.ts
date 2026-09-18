import { bundleRules } from "./bundle-conformance.ts"
import { duplicateImplementation } from "./duplicate-implementation.ts"
import { duplicateMeaning } from "./duplicate-meaning.ts"
import { importArchitectureRules } from "./import-architecture.ts"
import { dependencyFit } from "./dependency-fit.ts"
import { composeTypes } from "./compose-types.ts"
import { nameThePrimitive } from "./name-the-primitive.ts"
import { hoistToDomain } from "./hoist-to-domain.ts"
import { namingDrift } from "./naming-drift.ts"
import { pageNeedsComposition } from "./page-needs-composition.ts"
import type { Rule } from "../rule.ts"

/**
 * The registry. Add a rule by writing one file and one line here.
 *
 * Deterministic rules first, so that a run without an API key still produces the
 * findings it can prove. The four bundle-conformance rules are structural and
 * need no model at all; the page rule is a judgement and needs a key.
 */
export const allRules: ReadonlyArray<Rule> = [
  ...bundleRules,
  ...importArchitectureRules,
  composeTypes,
  nameThePrimitive,
  dependencyFit,
  hoistToDomain,
  duplicateImplementation,
  duplicateMeaning,
  namingDrift,
  pageNeedsComposition,
]

export const ruleById = (id: string): Rule | undefined => allRules.find((rule) => rule.id === id)
