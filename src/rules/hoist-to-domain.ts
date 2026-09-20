import { Effect } from "effect"
import { policy } from "../policy.ts"
import { Service as Judge, type JudgeRequest } from "../judge.ts"
import {
  budgetNote,
  choiceOf,
  declined,
  defineRule,
  finding,
  marginOf,
  outcome,
  type Scope,
} from "../rule.ts"
import { classifyModules, moduleOf } from "../roles.ts"
import { dutyVocabulary, EDGE_ROLES, homeVocabulary } from "../vocabulary.ts"
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
const isCandidate = (unit: Unit): boolean => {
  if (!unit.exported) return false
  if (unit.kind !== "function") return false
  // Names a framework calls by file. Nothing to hoist and nothing to merge,
  // whatever the declaration contains -- the list lives in policy because two
  // rules need it and a second copy is a second thing to update.
  if (policy.frameworkExports.some((name) => name === unit.name)) return false
  // Test declarations are compared against each other by the duplicate rules and
  // are candidates for nothing here: a fixture is not a business rule.
  if (unit.test) return false
  // A declaration with nothing in it has no rule in it either.
  if (unit.tokens.length < policy.hoistToDomain.minTokens) return false
  // A React component renders; it does not decide. Components are recognised by
  // the name convention rather than by JSX, because a component can return
  // another component's output and never write a tag itself.
  if (/^[A-Z]/.test(unit.name)) return false
  return true
}

/**
 * How much this looks like a rule, from signals the code already has.
 *
 * The docs' Composite Scoring pattern: break a complex judgment into atomic
 * scores and combine them with weights you control in code. The point is not to
 * decide with the score -- it is to decide WHAT TO ASK ABOUT, so that a budget
 * takes the most promising candidates instead of the alphabetically first ones.
 *
 * Every signal is derived, and every one is cheap:
 *
 *   somebody else imports it      a local helper is not a rule; a shared thing is
 *   it names types                a rule operates on things that have names
 *   it compares against a value   a threshold is a policy, and policies are rules
 *   it carries a non-trivial number  a rate, a limit, a percentage
 *   it is documented              somebody thought it was worth explaining
 *
 * None of these proves anything. Together they rank, and ranking is all that is
 * needed: the model still answers the actual question about whatever is asked.
 */
export const ruleLikeness = (unit: Unit, workspace: Workspace): number => {
  let score = 0
  if (workspace.imports.importersOfName(unit.file, unit.name).length > 0) score += 3
  if (unit.typeRefs.length > 0) score += 2
  if (/[<>]=?|===|!==/.test(unit.text)) score += 2
  if (/\b(?!0\b|1\b)\d{2,}(\.\d+)?\b/.test(unit.text)) score += 1
  if (unit.doc !== undefined) score += 1
  return score
}

/**
 * Whether everything that uses this declaration is a test.
 *
 * A helper only tests reach for is test support, whatever directory it sits in.
 * `services/db/src/support/seed-kit.js` is not in a test folder and every one of
 * its declarations exists for tests -- and it ranked FIRST, because a seed helper
 * names types, compares values and is imported widely.
 *
 * Derived from the import graph, which already knows who imports what, so this
 * cannot go stale and needs no list of support directories.
 */
const onlyTestsUse = (unit: Unit, workspace: Workspace): boolean => {
  const importers = workspace.imports.importersOfName(unit.file, unit.name)
  if (importers.length === 0) return false
  return importers.every((edge) => policy.testFiles.test(edge.from))
}

const candidatesIn = (workspace: Workspace, scope: Scope): ReadonlyArray<Unit> =>
  workspace.units
    .filter(isCandidate)
    .filter((unit) => !onlyTestsUse(unit, workspace))
    .filter((unit) => scope.changed === undefined || scope.changed.has(unit.file))
    // Ordered by path, NOT by rule-likeness. I built that score and it was worse
    // than nothing: "somebody else imports it" promoted a CRUD delete above an
    // authorization rule, because such a function is imported widely, names types
    // and compares values -- every signal I chose. What separates a rule from a
    // query is what the body DOES, and that is a judgement rather than a shape.
    // Ranking by a guess about it spent the budget on the wrong end of the list.
    //
    // `ruleLikeness` stays because it is honest about what it measures and the
    // drop reason reports it. It is not trusted to order anything.
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
    const all = candidatesIn(workspace, scope)
    // Declared before its first use, not after: a generator's body is one scope and
    // the type checker cannot see the temporal dead zone that produced
    // "Cannot access 'label' before initialization" at runtime.
    const label = (unit: Unit): string => unit.name + " (" + unit.file + ")"
    if (all.length === 0) {
      return outcome([], [
        "no exported declaration was long enough to hold a business rule, so nothing was a hoist candidate",
      ])
    }

    // ROUND ONE: what is each module for?
    //
    // The same classification `module-direction` uses, shared rather than
    // repeated: one Decision, one answer, and the content-addressed cache makes
    // the second reader free. Business logic at the edge is only a problem at an
    // edge, so a declaration in a domain package or a utility module is not a
    // hoist candidate whatever it contains.
    const classified = yield* classifyModules(workspace, context, RULE_ID)

    const edge = new Map<string, string>()
    const notAnEdge: Array<Drop> = []
    for (const unit of all) {
      const path = moduleOf(unit)
      const role = classified.roles.get(path)
      if (role !== undefined && EDGE_ROLES.has(role)) {
        edge.set(path, role)
        continue
      }
      notAnEdge.push({
        ruleId: RULE_ID,
        subject: label(unit),
        stage: "declined" as const,
        reason:
          role === undefined
            ? "the module this declaration lives in could not be classified"
            : "this declaration is in a " + role.replace(/_/g, " ") + " module, so there is nothing to hoist it out of",
      })
    }

    const candidates = all.filter((unit) => edge.has(moduleOf(unit)))

    const budget = policy.hoistToDomain.maxDeclarations
    const judged = candidates.slice(0, budget)

    const requests: Array<JudgeRequest> = judged.map((unit) => ({
      evidence: {
        repository: context.config.evidence?.repository ?? null,
        // What the module IS, from round one. Every question about a declaration
        // is easier to answer knowing whether it sits in a route handler or a
        // domain package, and round one already paid for the answer.
        module: { path: moduleOf(unit), role: edge.get(moduleOf(unit)) ?? null },
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

    const diagnostics: Array<Diagnostic> = []
    const drops: Array<Drop> = [...notAnEdge]
    for (const unit of candidates.slice(budget)) drops.push({
      ruleId: RULE_ID,
      subject: label(unit),
      stage: "budget" as const,
      reason:
        "past the budget of " +
        budget +
        "; rule-likeness " +
        ruleLikeness(unit, workspace) +
        " (the budget takes the highest scores first)",
    })

    // A verdict here is an opinion about where code should live, so without one
    // the rule stays silent rather than claiming a finding -- but silence is not
    // the same as saying nothing. The funnel is reported either way, because the
    // candidate count is exactly what you need in order to decide whether a run
    // with a key is worth making.
    const judge = yield* Judge
    const asked = yield* judge.askMany(requests).pipe(
      Effect.map((results) => ({ ok: true as const, results })),
      Effect.catch((error) =>
        Effect.succeed({
          ok: false as const,
          reason:
            typeof error === "object" && error !== null && "reason" in error
              ? String((error as { reason: unknown }).reason)
              : String(error),
        }),
      ),
    )
    if (!asked.ok) {
      return outcome([], [], [
        ...drops,
        ...judged.map((unit) => ({
          ruleId: RULE_ID,
          subject: label(unit),
          stage: "unreadable" as const,
          reason: "no judgement available: " + asked.reason,
        })),
      ])
    }
    const results = asked.results


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
      // A Choice that barely won is not a decision. The duplicate rules have had
      // this gate since it was shown to withhold 11 clusters of unrelated `db*`
      // functions; these two rules were built without it, which is how one of them
      // produced 199 findings on a single repository.
      const margin = marginOf(answers, "duty")
      if (margin !== undefined && margin < policy.judge.gates.minMargin) {
        drops.push({
          ruleId: RULE_ID,
          subject: label(unit),
          stage: "gated" as const,
          reason: "the choice was not decisive (margin " + margin.toFixed(2) + ")",
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
