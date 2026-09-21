import { Effect } from "effect"
import { layersFrom } from "../architecture.ts"
import { classifyModules, moduleOf, modulesOf, roleRank } from "../roles.ts"
import { defineRule, finding, outcome, type Scope } from "../rule.ts"
import type { Diagnostic } from "../schema.ts"
import type { Workspace } from "../workspace.ts"

const RULE_ID = "joggle/module-direction"

/**
 * Dependencies point one way, where the roles say the way is.
 *
 * `layer-direction` does this against layers a repository DECLARES, and it is
 * precise and free when they are written down. It has two problems that are not
 * about precision. Its globs go stale silently -- eight modules fell out of
 * joggle's own layering in one afternoon, and the rule reported zero upward
 * imports over the twenty-eight files it still covered. And a repository with no
 * config gets no direction check at all, which is two of the four repositories
 * this has been run against.
 *
 * This is the same check with the order INFERRED. It cannot come from the import
 * graph, because a topological order of the edges respects every edge by
 * construction, so a layering derived from the graph can never be violated by it.
 * It comes from what the roles mean instead: utilities and infrastructure sit
 * below the domain, which sits below the transport and rendering edges. That is a
 * fact about the words rather than a fact about this repository, so it needs no
 * declaration and cannot go stale.
 *
 * When layers ARE declared this rule stays out of the way and says so. A written
 * layering is more precise than a guessed one, and two rules reporting the same
 * upward import is how a report doubles without informing.
 */
export const moduleDirection = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "A module depends on a module whose role sits above it.",
  judged: true,
  run: Effect.fn("joggle/module-direction")(function* (
    workspace: Workspace,
    scope: Scope,
    context,
  ) {
    const declared = layersFrom(context.config)
    if (declared.length > 0) {
      return outcome([], [
        "layers are declared, so `layer-direction` owns this check and this rule stays out of it",
      ])
    }

    const classified = yield* classifyModules(workspace, context, RULE_ID)
    if (classified.roles.size === 0) {
      return outcome([], classified.notes, classified.drops)
    }

    const modules = modulesOf(workspace)

    // One finding per (source module, target module) pair. Forty edges between two
    // modules are one architectural statement, not forty.
    const seen = new Set<string>()
    const diagnostics: Array<Diagnostic> = []
    for (const edge of workspace.imports.edges) {
      if (!edge.resolved || edge.from === edge.to) continue
      // A scoped run asks about the change: an upward dependency is a candidate
      // when one of its two ends moved.
      if (scope.changed !== undefined && !scope.changed.has(edge.from) && !scope.changed.has(edge.to)) {
        continue
      }
      const from = classified.roles.get(moduleKey(edge.from, workspace))
      const to = classified.roles.get(moduleKey(edge.to, workspace))
      if (from === undefined || to === undefined) continue
      if (from === to) continue
      // A module and its own subdirectory are not two layers. `src/react/rules`
      // importing from `src/react` is a child reaching into its parent area,
      // which is what nesting is for, and reporting it as an architectural
      // violation is how a direction check becomes noise.
      if (from.startsWith(to + "/") || to.startsWith(from + "/")) continue
      const fromRank = roleRank[from]
      const toRank = roleRank[to]
      // A role with no rank is not part of the architecture: a test may import
      // anything, and a module nobody could classify is not a claim about anyone.
      if (fromRank === undefined || toRank === undefined) continue
      if (toRank <= fromRank) continue
      const key = from + "\u0000" + to
      if (seen.has(key)) continue
      seen.add(key)
      diagnostics.push(
        finding({
          ruleId: RULE_ID,
          severity: "warn",
          message:
            "A " +
            from +
            " module imports a " +
            to +
            " module: " +
            moduleKey(edge.from, workspace) +
            " -> " +
            moduleKey(edge.to, workspace) +
            ".",
          help:
            "The roles are ordered " +
            order() +
            ", and " +
            from +
            " sits below " +
            to +
            ". That is inferred from what the two modules are, not from a declared layering -- write one in joggle.config.json if this repository disagrees, and this rule will step aside.",
          location: { file: edge.from, line: 1, column: 1 },
          identity: [RULE_ID, from, to].join("\u0000"),
          // The roles came from the model, so this finding does too. Saying
          // otherwise hides the model call from every downstream count.
          judged: true,
        }),
      )
    }

    return outcome(
      diagnostics,
      [
        ...classified.notes,
        modules.size + " module(s); " + diagnostics.length + " upward dependency pair(s)",
      ],
      classified.drops,
    )
  }),
})

/** The module a file belongs to, without needing a declaration to ask about. */
const moduleKey = (file: string, workspace: Workspace): string => {
  const unit = workspace.units.find((candidate) => candidate.file === file)
  return unit === undefined ? file : moduleOf(unit)
}

/** The order, written once so the help and the arithmetic cannot disagree. */
const order = (): string =>
  Object.entries(roleRank)
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
    .map(([role]) => role.replace(/_/g, " "))
    .join(" below ")
