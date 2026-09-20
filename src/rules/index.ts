import { duplicateImplementation } from "./duplicate-implementation.ts"
import { duplicateMeaning } from "./duplicate-meaning.ts"
import { importArchitectureRules } from "./import-architecture.ts"
import { dependencyFit } from "./dependency-fit.ts"
import { callPattern } from "./call-pattern.ts"
import { nameAsAddress } from "./name-as-address.ts"
import { moduleDirection } from "./module-direction.ts"
import { objectShape } from "./object-shape.ts"
import { composeTypes } from "./compose-types.ts"
import { nameThePrimitive } from "./name-the-primitive.ts"
import { hoistToDomain } from "./hoist-to-domain.ts"
import { namingDrift } from "./naming-drift.ts"
import type { Rule } from "../rule.ts"

/**
 * The registry. Add a rule by writing one file and one line here.
 *
 * The rules that run without being asked for. The composition pattern is not
 * here. It is a preset -- five rules that encode one starter repository's
 * architecture, plus the page rule that judges whether a page follows it. A tool
 * that runs somebody's opinions by default is a tool that gets switched off by
 * the first team whose architecture differs, which is most of them.
 *
 * What is here is either derived from the code under analysis (import direction,
 * cycles, field-set composition) or a question with no architecture in it
 * (duplication, naming drift, undeclared dependencies).
 */
export const allRules: ReadonlyArray<Rule> = [
  ...importArchitectureRules,
  composeTypes,
  callPattern,
  moduleDirection,
  nameAsAddress,
  objectShape,
  nameThePrimitive,
  dependencyFit,
  hoistToDomain,
  duplicateImplementation,
  duplicateMeaning,
  namingDrift,
]

export const ruleById = (id: string): Rule | undefined => allRules.find((rule) => rule.id === id)
