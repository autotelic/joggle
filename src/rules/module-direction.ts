import { Effect } from "effect"
import { locator, messages, reporter } from "../reporting.ts"
import { layersFrom } from "../architecture.ts"
import { classifyModules, moduleOf, modulesOf } from "../roles.ts"
import { defineRule, inGraphScope, outcome, type Scope } from "../rule.ts"
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
// meta-allow: band-the-answer -- the roles come from one batched classification
// with no per-module quality to gate on; a rule that classifies rather than asks
// has no uncertain answer to withhold.
export const moduleDirection = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "A module depends on a module whose role sits above it.",
  judged: true,
  messages: messages({
    upward_module:
      "A {{from}} module imports a {{to}} module: {{fromModule}} -> {{toModule}}.",
    upward_module_help:
      "The roles are ordered {{order}}, and {{from}} sits below {{to}}. That order was inferred from what the two modules are, not from a declared layering -- write one in joggle.config.json if this repository disagrees, and this rule will step aside.",
  }),
  run: Effect.fn("joggle/module-direction")(function* (
    workspace: Workspace,
    scope: Scope,
    context,
  ) {
    const report = reporter(moduleDirection, locator(workspace))
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
      if (!edge.resolved || edge.importer === edge.to) continue
      // A scoped run asks about the change: an upward dependency is a candidate
      // when one of its two ends moved. A pure rename counts -- the move itself
      // can put a module on the wrong side of a boundary it used to respect.
      if (!inGraphScope(scope, edge.importer) && !inGraphScope(scope, edge.to)) continue
      const from = classified.roles.get(moduleKey(edge.importer, workspace))
      const to = classified.roles.get(moduleKey(edge.to, workspace))
      if (from === undefined || to === undefined) continue
      if (from === to) continue
      // A module and its own subdirectory are not two layers. `src/react/rules`
      // importing from `src/react` is a child reaching into its parent area,
      // which is what nesting is for, and reporting it as an architectural
      // violation is how a direction check becomes noise.
      if (from.startsWith(to + "/") || to.startsWith(from + "/")) continue
      const fromRank = classified.ranks.get(from)
      const toRank = classified.ranks.get(to)
      // A role with no rank is not part of the architecture: a test may import
      // anything, a module nobody could classify is not a claim about anyone, and
      // a run that could not order the roles reports no direction at all rather
      // than inventing one.
      if (fromRank === undefined || toRank === undefined) continue
      if (toRank <= fromRank) continue
      const key = from + "\u0000" + to
      if (seen.has(key)) continue
      seen.add(key)
      diagnostics.push(
        report({
                  at: { file: edge.importer, start: 0 },
                  messageId: "upward_module",
                  data: {
                    from,
                    to,
                    fromModule: moduleKey(edge.importer, workspace),
                    toModule: moduleKey(edge.to, workspace),
                    order: order(classified.ranks),
                  },
                  helpId: "upward_module_help",
                  identity: [RULE_ID, from, to].join("\u0000"),
                  judged: true,
                  severity: "warn",
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
const order = (ranks: ReadonlyMap<string, number>): string =>
  [...ranks.entries()]
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
    .map(([role]) => role.replace(/_/g, " "))
    .join(" below ")
