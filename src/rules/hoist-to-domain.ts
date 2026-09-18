import { Effect } from "effect"
import { policy } from "../policy.ts"
import { Service as Judge, type JudgeRequest } from "../judge.ts"
import {
  budgetNote,
  choiceOf,
  declined,
  defineRule,
  finding,
  outcome,
  type Scope,
} from "../rule.ts"
import { dutyVocabulary, homeVocabulary } from "../vocabulary.ts"
import type { Diagnostic, Drop, Question } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/hoist-to-domain"

/**
 * Business logic that lives at the edge and belongs in the middle.
 *
 * The other half of a domain migration. `dependency-fit` asks what a package
 * depends on; this asks where the RULES live -- a calculation, an invariant, a
 * decision about the business sitting in a route handler or a React component,
 * where it will be re-implemented the moment a second caller needs it.
 *
 * Nothing here is derived from a config. The candidate filter is structural (a
 * non-trivial exported declaration), and the two judgements are the ones a
 * reviewer actually makes: what IS this declaration, and is this file already
 * where logic like this belongs. The second question is what a declared `domain`
 * layer would have answered, and the model answers it from the path and the
 * prose instead.
 */

/**
 * Route and framework exports that exist because a framework requires them.
 *
 * A `loader` is not a hoist candidate whatever it contains; the framework asked
 * for it by name. Everything a loader CALLS is fair game, which is why the filter
 * is by name and not by file.
 */
const FRAMEWORK_EXPORTS = new Set([
  // Migrations and seeds: the runner calls these by name, one per file, and
  // there is no version of `up` that is not a migration's `up`.
  "up",
  "down",
  "seed",
  // Test runners. A hook is scaffolding for an assertion, not a rule.
  "beforeAll",
  "afterAll",
  "beforeEach",
  "afterEach",
  "loader",
  "action",
  "clientLoader",
  "clientAction",
  "meta",
  "links",
  "headers",
  "ErrorBoundary",
  "HydrateFallback",
  "shouldRevalidate",
  "middleware",
])

const isCandidate = (unit: Unit): boolean => {
  if (!unit.exported) return false
  if (unit.kind !== "function") return false
  // Test declarations are compared against each other by the duplicate rules and
  // are candidates for nothing here: a fixture is not a business rule.
  if (unit.test) return false
  if (FRAMEWORK_EXPORTS.has(unit.name)) return false
  // A declaration with nothing in it has no rule in it either.
  if (unit.tokens.length < policy.hoistToDomain.minTokens) return false
  // A React component renders; it does not decide. Components are recognised by
  // the name convention rather than by JSX, because a component can return
  // another component's output and never write a tag itself.
  if (/^[A-Z]/.test(unit.name)) return false
  return true
}

const candidatesIn = (workspace: Workspace, scope: Scope): ReadonlyArray<Unit> =>
  workspace.units
    .filter(isCandidate)
    .filter((unit) => scope.changed === undefined || scope.changed.has(unit.file))
    .sort((left, right) => left.file.localeCompare(right.file) || left.start - right.start)

const questions = {
  duty: {
    type: "choice",
    instructions: {
      question: "What is `declaration.name` doing?",
      inspect: ["declaration", "repository"],
      fallback: "Choose `orchestration` when it mostly calls other things and decides little itself.",
      focus:
        "`repository` describes what this codebase is trying to be. Judge what this declaration IS, not where it sits: the same calculation is a domain rule in any file. A rule, an invariant or a decision about the business is `domain_logic` wherever it is written.",
    },
    criteria: dutyVocabulary,
  },
  home: {
    type: "choice",
    instructions: {
      question: "Is `declaration.path` already where logic like this belongs?",
      inspect: ["declaration.path", "repository"],
      focus:
        "Decide from the path and what `repository` says the architecture is. A route, a component directory or a transport handler is not where business rules live; a domain or model package is.",
    },
    criteria: homeVocabulary,
  },
} satisfies Record<string, Question>

export const hoistToDomain = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "Business logic at the edge that belongs in a domain package.",
  judged: true,
  run: Effect.fn("joggle/hoist-to-domain")(function* (
    workspace: Workspace,
    scope: Scope,
    context,
  ) {
    const candidates = candidatesIn(workspace, scope)
    if (candidates.length === 0) return outcome([])

    const budget = policy.hoistToDomain.maxDeclarations
    const judged = candidates.slice(0, budget)
    const label = (unit: Unit): string => unit.name + " (" + unit.file + ")"

    const requests: Array<JudgeRequest> = judged.map((unit) => ({
      evidence: {
        repository: context.config.evidence?.repository ?? null,
        declaration: {
          name: unit.name,
          path: unit.file,
          line: unit.location.line,
          source: unit.text.slice(0, policy.evidence.maxSourceChars),
          documented: unit.doc !== undefined,
          doc: unit.doc?.slice(0, policy.evidence.maxDocChars) ?? null,
          types: unit.typeRefs,
        },
      },
      questions,
    }))

    const judge = yield* Judge
    // A verdict here is an opinion about where code should live, so without one
    // the rule stays silent rather than claiming a finding.
    const results = yield* judge.askMany(requests)

    const diagnostics: Array<Diagnostic> = []
    const drops: Array<Drop> = candidates.slice(budget).map((unit) => ({
      ruleId: RULE_ID,
      subject: label(unit),
      stage: "budget" as const,
      reason: "this run judged " + budget + " declarations and this one was past the budget",
    }))

    judged.forEach((unit, index) => {
      const answers = results[index]?.answers ?? {}
      const duty = choiceOf(answers, "duty")
      const home = choiceOf(answers, "home")
      if (duty === undefined || home === undefined) {
        drops.push({
          ruleId: RULE_ID,
          subject: label(unit),
          stage: "unreadable",
          reason: "the response did not classify this declaration",
        })
        return
      }
      if (duty.choice !== "domain_logic" || declined(home.choice) || home.choice === "already_there") {
        drops.push({
          ruleId: RULE_ID,
          subject: label(unit),
          stage: "declined" as const,
          reason:
            duty.choice === "domain_logic"
              ? "the model says this is already where it belongs"
              : "the model says this is " + duty.choice,
        })
        return
      }
      diagnostics.push(
        finding({
          ruleId: RULE_ID,
          severity: "warn",
          message:
            unit.name +
            " in " +
            unit.file +
            " is a rule about the business, living in " +
            home.choice.replace(/_/g, " ") +
            ".",
          help:
            "Move it into the domain package and import it from here. Business rules at the edge get re-implemented by the next caller, and the two copies then disagree. If this is deliberately local, pin the decision in the config so the question is not asked again.",
          location: unit.location,
          identity: [RULE_ID, unit.file, unit.name].join("\u0000"),
          confidence: duty.confidence,
          judged: true,
        }),
      )
    })

    return outcome(
      diagnostics,
      budgetNote(
        "declarations",
        budget,
        candidates.length,
        candidates.slice(budget).map(label),
      ),
      drops,
    )
  }),
})
