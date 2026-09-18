import { Effect } from "effect"
import { builtinModules } from "node:module"
import { policy } from "../policy.ts"
import { Service as Judge, type JudgeRequest } from "../judge.ts"
import {
  budgetNote,
  choiceOf,
  defineRule,
  finding,
  marginOf,
  outcome,
  type Scope,
} from "../rule.ts"
import { dependencyVocabulary } from "../vocabulary.ts"
import type { Diagnostic, Drop, Question } from "../schema.ts"
import type { Workspace } from "../workspace.ts"

const RULE_ID = "joggle/dependency-fit"

/**
 * Does each package depend on what a package like it should?
 *
 * The inferred replacement for `layer-purity`'s declared `forbid` list, and the
 * same lesson for the third time: a hand-maintained list of facts goes stale.
 * `ignoredDirectories` became .gitignore, the hand-bumped analysisVersion became
 * a source hash, and a regex per layer saying what it may not import should never
 * have been written two hours after removing the first of those.
 *
 * The material was already here: a package, the thing it imports, and the
 * sentence of prose a repository writes about itself. The TypeSafe docs call that
 * "the material you would present to a panel of experts before asking them to
 * make a judgment", and the judgement belongs in a question. "Should a domain
 * package import react" is not a fact. "Does this package import react" is, and
 * the import graph already answers it.
 *
 * The candidate set is DISTINCT (package, dependency) pairs, not import
 * statements. A repository with four services reaches for perhaps sixty external
 * things in total, so this is sixty questions about sixty decisions rather than
 * sixty thousand questions about sixty thousand lines.
 */
interface Dependency {
  /** The module that reached for it: its package, or its path without one. */
  readonly path: string
  /** The directory of the file that reached for it, for the manifest lookup. */
  readonly directory: string
  /** What that package declares it depends on, so the state can say so. */
  readonly declares: ReadonlyArray<string>
  readonly specifier: string
  readonly count: number
  readonly examples: ReadonlyArray<string>
}

/**
 * The module a file belongs to, from its path alone.
 *
 * Two segments: `services/ui/app/routes/x.ts` is `services/ui`. This is a
 * heuristic, and the only one in this rule -- but it is DERIVED from the paths
 * rather than declared, so it cannot go stale, and a repository that groups its
 * code some other way still gets questions about the groups it actually has.
 */
const moduleOf = (file: string): string => file.split("/").slice(0, 2).join("/")

/**
 * The package a specifier names, which is not the specifier.
 *
 * `fastify-cli/start.js` is a path INTO `fastify-cli`, and `@fastify/cookie` is
 * one package rather than two. Comparing raw specifiers against a manifest's
 * dependency list therefore reports subpath imports as undeclared -- which is how
 * a package that declares a dependency gets flagged for using it.
 */
export const packageNameOf = (specifier: string): string => {
  const parts = specifier.split("/")
  const [first, second] = parts
  if (first === undefined) return specifier
  return first.startsWith("@") && second !== undefined ? first + "/" + second : first
}

/**
 * Node's own modules, which no manifest declares and no repository should.
 *
 * From the runtime rather than a written list: `import { builtinModules } from
 * "node:module"` is the same set the interpreter enforces, so it cannot go stale
 * as Node adds modules.
 */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => "node:" + name)])

interface Candidates {
  readonly dependencies: ReadonlyArray<Dependency>
  /** Imports the package declares for itself: answered, not asked. */
  readonly declared: ReadonlyArray<{ dependency: Dependency; specifier: string }>
}

/**
 * Whether a specifier names something inside this repository.
 *
 * An unresolved import is not automatically a dependency. `src/authorization/
 * index.js` in 37 files and `@shared/types/safety-forms` are paths and path
 * aliases that the resolver could not follow -- tsconfig `paths` are not read --
 * and reporting them as undeclared dependencies is noise that buries the seven
 * real ones.
 *
 * Derived from the file set rather than from a list of aliases: the directories
 * the repository actually contains. A specifier that mentions one of them names
 * something here, whatever prefix it wears.
 */
const internalNames = (workspace: Workspace): ReadonlySet<string> => {
  const names = new Set<string>()
  for (const file of workspace.files) {
    const parts = file.path.split("/")
    for (const part of parts.slice(0, -1)) names.add(part)
  }
  return names
}

const isInternalPath = (specifier: string, internal: ReadonlySet<string>): boolean => {
  // A specifier with a source extension names a file.
  if (/\.(?:[cm]?[jt]sx?)$/.test(specifier)) return true
  return specifier.split("/").some((segment) => internal.has(segment))
}

const dependenciesIn = (workspace: Workspace): Candidates => {
  const internal = internalNames(workspace)
  const grouped = new Map<
    string,
    {
      path: string
      directory: string
      declares: ReadonlyArray<string>
      specifier: string
      count: number
      examples: Array<string>
    }
  >()
  for (const edge of workspace.imports.edges) {
    // Internal imports are `layer-direction`'s business, and a relative specifier
    // cannot be a dependency on a framework.
    if (edge.resolved) continue
    if (edge.specifier.startsWith(".") || edge.specifier.startsWith("/")) continue
    if (BUILTINS.has(edge.specifier)) continue
    // A path into an installed tree is not an import of a package, and a package
    // importing itself is internal structuring rather than a dependency.
    if (edge.specifier.includes("/node_modules/")) continue
    if (isInternalPath(edge.specifier, internal)) continue
    const cut = edge.from.lastIndexOf("/")
    const directory = cut === -1 ? "." : edge.from.slice(0, cut)
    const manifest = workspace.manifests.get(directory)
    // The package's own name is a better grouping than two path segments: it is
    // what the package IS rather than where it happens to sit, and it collapses
    // `packages/fasdentify/src/a.ts` and `packages/fasdentify/test/b.ts` into one
    // thing without guessing at a directory depth.
    const path = manifest?.name ?? moduleOf(edge.from)
    if (path.length === 0) continue
    const key = path + "\u0000" + edge.specifier
    const existing = grouped.get(key)
    if (existing === undefined) {
      grouped.set(key, {
        path,
        directory,
        declares: manifest?.declares ?? [],
        specifier: edge.specifier,
        count: 1,
        examples: [edge.from],
      })
      continue
    }
    existing.count += 1
    if (existing.examples.length < policy.evidence.maxListedPaths) existing.examples.push(edge.from)
  }
  const sorted = [...grouped.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.specifier.localeCompare(right.specifier),
  )
  // A dependency the package declares for itself is answered before it is asked.
  // This is the case that made the rule look foolish: `packages/fasdentify
  // depends on fastify in 29 files` is not a violation, it is what fasdentify is
  // FOR, and its own manifest said so all along. No call, no judgement, no
  // configuration -- a fact, derived from the file the package already keeps.
  const dependencies: Array<Dependency> = []
  const declared: Array<{ dependency: Dependency; specifier: string }> = []
  for (const entry of sorted) {
    const named = packageNameOf(entry.specifier)
    const manifest = workspace.manifests.get(entry.directory)
    if (manifest !== undefined && manifest.name === named) continue
    if (entry.declares.includes(named)) {
      declared.push({ dependency: entry, specifier: entry.specifier })
      continue
    }
    dependencies.push(entry)
  }
  return { dependencies, declared }
}

const questions = {
  fit: {
    type: "choice",
    instructions: {
      question: "Does `dependency.specifier` belong in `package.path`?",
      inspect: ["package", "dependency"],
      fallback: "Choose `belongs` unless something is clearly wrong. This rule is meant to be quiet.",
      focus:
        "`package.describes_itself_as` is what this package says it is, and `repository` describes what the codebase is trying to be. Judge the dependency against BOTH: a Fastify plugin importing fastify is a package doing its job, and the same import in a domain package is the thing the architecture exists to prevent. Do not apply a constraint that belongs to one package to every package.",
    },
    criteria: dependencyVocabulary,
  },
} satisfies Record<string, Question>

export const dependencyFit = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "A package depends on something its architecture says it should not.",
  judged: true,
  run: Effect.fn("joggle/dependency-fit")(function* (
    workspace: Workspace,
    _scope: Scope,
    context,
  ) {
    const { dependencies, declared } = dependenciesIn(workspace)
    if (dependencies.length === 0 && declared.length === 0) return outcome([])
    const budget = policy.dependencyFit.maxDependencies
    const judged = dependencies.slice(0, budget)
    const label = (dependency: Dependency): string =>
      dependency.path + " -> " + dependency.specifier
    const answeredItself = declared.map((entry) => ({
      ruleId: RULE_ID,
      subject: label(entry.dependency),
      stage: "declined" as const,
      reason:
        "the package declares " +
        entry.specifier +
        " in its own manifest, so importing it is what the package is for",
    }))

    const requests: Array<JudgeRequest> = judged.map((dependency) => {
      const manifest = workspace.manifests.get(dependency.directory)
      return {
      evidence: {
        repository: context.config.evidence?.repository ?? null,
        package: {
          path: dependency.path,
          // What the package says it IS. Without this the panel is asked whether a
          // package should import a framework while being told nothing about the
          // package -- and answers correctly for the wrong package.
          name: manifest?.name ?? null,
          describes_itself_as: manifest?.description ?? null,
          imports_this_in: dependency.count,
          examples: dependency.examples,
        },
        dependency: { specifier: dependency.specifier },
      },
      questions,
      }
    })

    const diagnostics: Array<Diagnostic> = []
    // Declared dependencies are drops, not answers: the funnel has to account for
    // every candidate, and 129 of 241 never reached the model. This was computed
    // and then thrown away until plumb's no-unused-vars reported it, which is a
    // per-file rule finding a bug in the cross-file tool's own reporting.
    const drops: Array<Drop> = [...answeredItself]
    for (const dependency of dependencies.slice(budget)) drops.push({
      ruleId: RULE_ID,
      subject: label(dependency),
      stage: "budget" as const,
      reason: "this run judged " + budget + " dependencies and this one was past the budget",
    })

    const judge = yield* Judge
    // A verdict here is a guess about someone else's design, so without one the
    // rule stays silent rather than inventing a finding. It still reports what it
    // looked at: the candidate count is how you decide whether to make the run
    // that needs a key.
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
        ...judged.map((dependency) => ({
          ruleId: RULE_ID,
          subject: label(dependency),
          stage: "unreadable" as const,
          reason: "no judgement available: " + asked.reason,
        })),
      ])
    }
    const results = asked.results


    judged.forEach((dependency, index) => {
      const answers = results[index]?.answers ?? {}
      const verdict = choiceOf(answers, "fit")
      if (verdict === undefined) {
        drops.push({
          ruleId: RULE_ID,
          subject: label(dependency),
          stage: "unreadable",
          reason: "the response contained nothing for this dependency",
        })
        return
      }
      // The model only decides WHICH of two problems this is. That the package
      // imports something it does not declare is a fact, and it is the more
      // common one: `@autotelic/fasdentify` imports `fastify` in 29 files and its
      // manifest has no `fastify` entry. That works on a developer's machine and
      // fails on a clean install, because it is only there by hoisting.
      // A Choice that barely won is not a decision, and a package that imports
      // something it does not declare is a fact regardless of what the model
      // thinks of it -- so the gate decides the QUALIFIER, not the finding.
      const margin = marginOf(answers, "fit")
      const decisive = margin === undefined || margin >= policy.judge.gates.minMargin
      // The FACT leads and the judgement qualifies it. That the package imports
      // something it does not declare is derived, not decided -- and it is the
      // finding that matters most here, because it works on a developer's machine
      // and fails on a clean install.
      const misplaced = verdict.choice === "violates"
      diagnostics.push(
        finding({
          ruleId: RULE_ID,
          severity: "warn",
          message:
            dependency.path +
            " imports " +
            dependency.specifier +
            " in " +
            dependency.count +
            " file(s) but does not declare it.",
          help:
            "Add " +
            packageNameOf(dependency.specifier) +
            " to the package's manifest: an undeclared import resolves only because something else hoisted it into the tree. " +
            (misplaced && decisive
              ? "It also does not appear to fit what this package is for, so consider removing it instead."
              : "The dependency itself fits what this package does."),
          location: { file: dependency.examples[0] ?? dependency.path, line: 1, column: 1 },
          identity: [
            RULE_ID,
            misplaced ? "misplaced" : "undeclared",
            dependency.path,
            dependency.specifier,
          ].join("\u0000"),
          confidence: verdict.confidence,
          judged: false,
        }),
      )
    })

    return outcome(
      diagnostics,
      budgetNote(
        "dependencies",
        budget,
        dependencies.length,
        dependencies.slice(budget).map(label),
      ),
      drops,
    )
  }),
})
