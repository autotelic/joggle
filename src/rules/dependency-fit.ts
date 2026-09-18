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
  /** The module that reached for it, derived from the path. */
  readonly path: string
  /** The directory of the file that reached for it, for the manifest lookup. */
  readonly directory: string
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

const dependenciesIn = (workspace: Workspace): ReadonlyArray<Dependency> => {
  const grouped = new Map<
    string,
    { path: string; directory: string; specifier: string; count: number; examples: Array<string> }
  >()
  for (const edge of workspace.imports.edges) {
    // Internal imports are `layer-direction`'s business, and a relative specifier
    // cannot be a dependency on a framework.
    if (edge.resolved) continue
    if (edge.specifier.startsWith(".") || edge.specifier.startsWith("/")) continue
    if (edge.specifier.startsWith("node:")) continue
    const path = moduleOf(edge.from)
    if (path.length === 0) continue
    const cut = edge.from.lastIndexOf("/")
    const directory = cut === -1 ? "." : edge.from.slice(0, cut)
    const key = path + "\u0000" + edge.specifier
    const existing = grouped.get(key)
    if (existing === undefined) {
      grouped.set(key, {
        path,
        directory,
        specifier: edge.specifier,
        count: 1,
        examples: [edge.from],
      })
      continue
    }
    existing.count += 1
    if (existing.examples.length < policy.evidence.maxListedPaths) existing.examples.push(edge.from)
  }
  return [...grouped.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.specifier.localeCompare(right.specifier),
  )
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
    const dependencies = dependenciesIn(workspace)
    if (dependencies.length === 0) return outcome([])
    const budget = policy.dependencyFit.maxDependencies
    const judged = dependencies.slice(0, budget)

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

    const judge = yield* Judge
    // A verdict here is a guess about someone else's design, so without one the
    // rule stays silent rather than inventing a finding.
    const results = yield* judge.askMany(requests)

    const label = (dependency: Dependency): string =>
      dependency.path + " -> " + dependency.specifier
    const diagnostics: Array<Diagnostic> = []
    const drops: Array<Drop> = dependencies.slice(budget).map((dependency) => ({
      ruleId: RULE_ID,
      subject: label(dependency),
      stage: "budget" as const,
      reason: "this run judged " + budget + " dependencies and this one was past the budget",
    }))

    judged.forEach((dependency, index) => {
      const verdict = choiceOf(results[index]?.answers ?? {}, "fit")
      if (verdict === undefined) {
        drops.push({
          ruleId: RULE_ID,
          subject: label(dependency),
          stage: "unreadable",
          reason: "the response contained nothing for this dependency",
        })
        return
      }
      if (verdict.choice !== "violates") {
        const expected = verdict.choice === "framework_expected"
        drops.push({
          ruleId: RULE_ID,
          subject: label(dependency),
          stage: "declined" as const,
          reason: expected
            ? "the model says this is exactly where that framework belongs"
            : "the model says this dependency fits",
        })
        return
      }
      diagnostics.push(
        finding({
          ruleId: RULE_ID,
          severity: "warn",
          message:
            dependency.path +
            " depends on " +
            dependency.specifier +
            " in " +
            dependency.count +
            " file(s), which does not fit what this package is for.",
          help:
            "Move the use of " +
            dependency.specifier +
            " to the edge of the application, or take what it provides as an argument. If this dependency is deliberate, declare it under `architecture` in the config to pin the decision and stop the question being asked again.",
          location: { file: dependency.examples[0] ?? dependency.path, line: 1, column: 1 },
          identity: [RULE_ID, dependency.path, dependency.specifier].join("\u0000"),
          confidence: verdict.confidence,
          judged: true,
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
