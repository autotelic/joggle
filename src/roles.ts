import { Effect, Option } from "effect"
import { policy } from "./policy.ts"
import { Service as Judge } from "./judge.ts"
import { budgetNote, choiceOf, type RunContext } from "./rule.ts"
import { moduleRoles } from "./vocabulary.ts"
import type { Drop, Question } from "./schema.ts"
import type { Unit, Workspace } from "./workspace.ts"

/**
 * What each module is for, asked once and shared by everything that needs it.
 *
 * This was inside `hoist-to-domain`, which classifies a module before asking
 * about its declarations. A second rule now needs the same answers, and the
 * judgement cache is content-addressed, so the second reader pays a replay rather
 * than a call: same module, same evidence, same question, same key.
 *
 * It is also the INFERRED replacement for a declared layering. A layering
 * computed from the import graph can never be violated by the import graph -- a
 * topological order respects every edge by construction -- so direction needs an
 * order from somewhere else. Roles carry one: infrastructure and utilities are
 * below the domain, which is below the edges, and that is a fact about what the
 * words mean rather than a fact about this repository.
 */

/**
 * The module a declaration belongs to.
 *
 * Four path segments, not the package. `services/rest` contains both
 * `src/routes` and `src/domain`, and asking whether the package is a transport
 * edge has no answer; four segments separates the two inside one package, which
 * is the line being looked for.
 */
export const moduleOf = (unit: Unit): string => {
  const parts = unit.file.split("/")
  return parts.length <= 4 ? parts.join("/") : parts.slice(0, 4).join("/")
}

/** Every module in the workspace, with the declarations it holds. */
export const modulesOf = (
  workspace: Workspace,
): ReadonlyMap<string, ReadonlyArray<Unit>> => {
  const modules = new Map<string, Array<Unit>>()
  for (const unit of workspace.units) {
    const path = moduleOf(unit)
    const existing = modules.get(path)
    if (existing === undefined) modules.set(path, [unit])
    else existing.push(unit)
  }
  return modules
}

export const moduleQuestions = {
  role: {
    type: "choice",
    instructions: {
      question: "What is `module.path` for?",
      inspect: ["module", "repository"],
      fallback: "Choose `utilities` when it is a generic helper with no business meaning.",
      focus:
        "`repository` describes what this codebase is trying to be. Classify the module by what it IS, not by whether it is doing it well: a route directory full of business rules is still a transport edge.",
    },
    criteria: moduleRoles,
  },
} satisfies Record<string, Question>

/**
 * Roles ordered from most depended-upon to least.
 *
 * Lower may be imported by higher and never the reverse. `not_applicable` is
 * absent on purpose: a test may import anything, so a module that is not part of
 * the architecture is not subject to it.
 */
export const roleRank: Readonly<Record<string, number>> = {
  utilities: 0,
  infrastructure: 1,
  domain_core: 2,
  library_core: 2,
  transport_edge: 3,
  rendering_edge: 3,
}

export interface Classified {
  /** Module path to the role the model chose. Modules it could not judge are absent. */
  readonly roles: ReadonlyMap<string, string>
  readonly notes: ReadonlyArray<string>
  readonly drops: ReadonlyArray<Drop>
}

/**
 * One question per module, batched, cached, and reported.
 *
 * A module nobody could classify is a drop with a reason rather than a silence:
 * every module skipped here is a module the callers below cannot reason about.
 */
export const classifyModules = (
  workspace: Workspace,
  context: RunContext,
  ruleId: string,
): Effect.Effect<Classified, import("./schema.ts").JudgeError, Judge> =>
  Effect.gen(function* () {
    const modules = modulesOf(workspace)
    const listed = [...modules.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .slice(0, policy.moduleRoles.maxModules)
    if (listed.length === 0) {
      return { roles: new Map(), notes: ["no module to classify"], drops: [] }
    }

    const judge = yield* Judge
    const answered = yield* judge.askMany(
      listed.map(([path, units]) => ({
        evidence: {
          repository: context.config.evidence?.repository ?? null,
          module: {
            path,
            declarations: units.length,
            examples: [...new Set(units.map((unit) => unit.file))].slice(
              0,
              policy.evidence.maxListedPaths,
            ),
          },
        },
        questions: moduleQuestions,
      })),
    )

    const roles = new Map<string, string>()
    const drops: Array<Drop> = []
    listed.forEach(([path, units], index) => {
      const answer = answered[index]
      const role = answer === undefined ? undefined : choiceOf(answer.answers, "role")
      if (role === undefined) {
        for (const unit of units) {
          drops.push({
            ruleId,
            subject: path,
            stage: "unreadable",
            reason: "the module could not be classified",
          })
        }
        return
      }
      roles.set(path, role.choice)
    })

    const unclassified = listed.filter(([path]) => !roles.has(path)).length
    return {
      roles,
      notes: [
        listed.length +
          " module(s) classified" +
          (unclassified === 0 ? "" : ", " + unclassified + " unreadable"),
        ...budgetNote(
          "modules",
          policy.moduleRoles.maxModules,
          modules.size,
          [...modules.keys()].slice(policy.moduleRoles.maxModules),
        ),
      ],
      drops,
    }
  })

/** The role of the module a file belongs to, if it has one. */
export const roleOfFile = (
  roles: ReadonlyMap<string, string>,
  workspace: Workspace,
  file: string,
): string | undefined => {
  const unit = workspace.units.find((candidate) => candidate.file === file)
  return unit === undefined ? undefined : roles.get(moduleOf(unit))
}

export const optionOf = <A>(value: A | undefined): Option.Option<A> =>
  value === undefined ? Option.none() : Option.some(value)
