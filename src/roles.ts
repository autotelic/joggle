import { Effect, Option, Schema } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import { Decision, DecisionModel } from "effect/unstable/ai"
import { policy } from "./policy.ts"
import { budgetNote, type RunContext } from "./rule.ts"
import { moduleRoles } from "./vocabulary.ts"
import type { Drop } from "./schema.ts"
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
  // The DIRECTORY, never the file.
  //
  // Four segments was right about the depth -- it separates `services/rest/src/
  // routes` from `services/rest/src/domain` inside one package -- and wrong about
  // the last segment. Taking the whole path when it was short made a file its own
  // module, so two files in one directory became an upward dependency between two
  // modules: `src/shared/is-node.ts` importing `src/shared/structural.ts` was
  // reported as utilities importing library core.
  const directories = unit.file.split("/").slice(0, -1)
  return directories.length <= 4 ? directories.join("/") : directories.slice(0, 4).join("/")
}

/**
 * The package a specifier names: `react`, `@oxlint/plugins`, `effect/unstable/...`.
 *
 * Shared with the dependency check, which learned it first: `fastify-cli/start.js`
 * is a path INTO `fastify-cli`, and comparing raw specifiers reports subpath
 * imports as undeclared.
 */
export const packageNameOf = (specifier: string): string => {
  const parts = specifier.split("/")
  const [first, second] = parts
  if (first === undefined) return specifier
  return first.startsWith("@") && second !== undefined ? first + "/" + second : first
}

/**
 * What the repository actually depends on, from its manifests and its imports.
 *
 * The material that separates `../react` from `@react`. A directory called
 * `react` and the React framework have the same name and nothing else in common,
 * and a model reading a path cannot tell which it is looking at -- but the
 * repository can: the framework is a declared dependency, or an unresolved
 * specifier some file imports, and a directory is neither.
 */
export const externalNames = (workspace: Workspace): ReadonlySet<string> => {
  const names = new Set<string>()
  for (const manifest of workspace.manifests.values()) {
    for (const declared of manifest.declares) names.add(declared)
  }
  for (const edge of workspace.imports.edges) {
    if (edge.resolved) continue
    if (edge.specifier.startsWith(".") || edge.specifier.startsWith("/")) continue
    if (edge.specifier.startsWith("node:")) continue
    names.add(packageNameOf(edge.specifier))
  }
  return names
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

export const moduleDecisions = {
  role: Decision.classify({
    instructions: [
      "What is `module.path` for?",
      "Inspect `module` and `repository`.",
      "`repository` describes what this codebase is trying to be. Classify the module by what it IS, not by whether it is doing it well: a route directory full of business rules is still a transport edge.",
      "Choose `utilities` when it is a generic helper with no business meaning.",
    ].join("\n"),
    criteria: moduleRoles,
  }),
}

/** The evidence panel, as a Schema, because it is exactly what the model is asked about. */
const ModuleEvidence = Schema.Struct({
  repository: Schema.optionalKey(Schema.String),
  module: Schema.Struct({
    path: Schema.String,
    declarations: Schema.Number,
    examples: Schema.Array(Schema.String),
    imports: Schema.Array(Schema.String),
    shares_a_name_with_a_dependency: Schema.NullOr(Schema.String),
  }),
})

const ModuleClassification = Decision.make({
  input: ModuleEvidence,
  decisions: moduleDecisions,
})

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
): Effect.Effect<Classified, AiError.AiError, DecisionModel.DecisionModel> =>
  Effect.gen(function* () {
    const modules = modulesOf(workspace)
    const listed = [...modules.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .slice(0, policy.moduleRoles.maxModules)
    if (listed.length === 0) {
      return { roles: new Map(), notes: ["no module to classify"], drops: [] }
    }

    const names = externalNames(workspace)

    // Which file belongs to which module, so an import can be attributed to the
    // module that makes it.
    const ownerOf = new Map<string, string>()
    for (const [path, units] of listed) {
      for (const unit of units) ownerOf.set(unit.file, path)
    }

    // What each module imports from outside the repository. A module called
    // `react` whose files import only type packages is not a rendering edge, and
    // this is how the model can see that rather than infer it from the name.
    const externalByModule = new Map<string, Set<string>>()
    for (const edge of workspace.imports.edges) {
      if (edge.resolved) continue
      if (edge.specifier.startsWith(".") || edge.specifier.startsWith("/")) continue
      if (edge.specifier.startsWith("node:")) continue
      const module = ownerOf.get(edge.from)
      if (module === undefined) continue
      const found = externalByModule.get(module) ?? new Set<string>()
      found.add(packageNameOf(edge.specifier))
      externalByModule.set(module, found)
    }

    const answered = yield* Effect.forEach(
      listed,
      ([path, units]) => {
        // A module whose last path segment matches something the repository
        // depends on. `null` is the useful answer: nothing here is called that.
        const last = path.split("/").at(-1) ?? path
        const collision = names.has(last) ? last : null
        const repository = context.config.evidence?.repository
        const panel = {
          module: {
            path,
            declarations: units.length,
            examples: [...new Set(units.map((unit) => unit.file))].slice(
              0,
              policy.evidence.maxListedPaths,
            ),
            imports: [...(externalByModule.get(path) ?? [])]
              .sort()
              .slice(0, policy.evidence.maxListedPaths),
            shares_a_name_with_a_dependency: collision,
          },
        }
        const evidence = repository === undefined ? panel : { ...panel, repository }
        return DecisionModel.decide(ModuleClassification, { input: evidence }).pipe(
          Effect.map((result) => Option.some(result.answers.role.label)),
          // One candidate that cannot be read is a drop for that candidate, not a
          // failed run: the other modules still deserve an answer. A model that
          // was never reached is different -- the whole rule steps aside.
          Effect.catch((error) =>
            error.reason._tag === "AuthenticationError" || error.reason._tag === "UnknownError"
              ? Effect.fail(error)
              : Effect.succeed(Option.none<string>()),
          ),
        )
      },
      { concurrency: policy.judge.requestConcurrency },
    )

    const roles = new Map<string, string>()
    const drops: Array<Drop> = []
    listed.forEach(([path, units], index) => {
      const role = answered[index]
      if (role === undefined || Option.isNone(role)) {
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
      roles.set(path, role.value)
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
