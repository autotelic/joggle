import { Effect } from "effect"
import { policy } from "../policy.ts"
import { defineRule, finding, outcome, type Scope } from "../rule.ts"
import type { Diagnostic } from "../schema.ts"
import type { Workspace } from "../workspace.ts"

const RULE_ID = "joggle/name-as-address"

/**
 * A name too common to be an address.
 *
 * The reference material this rule comes from opens with the measurement that
 * motivates it: an agent finds code by searching for a name, so `grep create`
 * returning 1,585 hits is not a style problem, it is a retrieval problem. The
 * agent cannot find this declaration, and every future change to this codebase
 * pays for that.
 *
 * The measure is derived rather than declared: how many files contain a call that
 * RESOLVES to this declaration. Resolution matters, because it makes the count
 * about this function rather than about a spelling -- thirty call sites named
 * `parse` reaching three different functions is not sixty hits on any one of them.
 *
 * And the name has to be a single word. `fetchPayrollProjections` used in thirty
 * files is a good address used often; `range` used in thirty files is a bad one,
 * and the difference is the name rather than the count.
 *
 * Deterministic and free: the call sites come from the parse and the resolution
 * from the pass that already resolves types.
 */
const isSingleWord = (name: string): boolean => /^[a-z][a-z0-9]*$/.test(name)

export const nameAsAddress = defineRule({
  id: RULE_ID,
  severity: "info",
  description: "A generic single-word export called from too many files to be searchable.",
  judged: false,
  run: Effect.fn("joggle/name-as-address")(function* (workspace: Workspace, _scope: Scope) {
    const { minFiles, maxFindings } = policy.nameAsAddress
    const exported = workspace.units.filter((unit) => unit.exported)

    // Which files call each declaration, by resolved identity.
    const calledFrom = new Map<string, Set<string>>()
    for (const unit of workspace.units) {
      for (const callee of unit.calls) {
        const files = calledFrom.get(callee) ?? new Set<string>()
        files.add(unit.file)
        calledFrom.set(callee, files)
      }
    }

    const candidates = exported
      .filter((unit) => isSingleWord(unit.name))
      .map((unit) => ({ unit, files: calledFrom.get(unit.file + "#" + unit.name)?.size ?? 0 }))
      .filter((entry) => entry.files >= minFiles)
      .sort((left, right) => right.files - left.files)

    if (candidates.length === 0) {
      return outcome([], [
        exported.length +
          " exported declaration(s), none of them a single-word name called from " +
          minFiles +
          " or more files",
      ])
    }

    const findings: Array<Diagnostic> = candidates.slice(0, maxFindings).map((entry) =>
      finding({
        ruleId: RULE_ID,
        severity: "info",
        message:
          "`" +
          entry.unit.name +
          "` is called from " +
          entry.files +
          " files, so searching for it finds everything and nothing.",
        help:
          "A name is how this declaration is found: it is the address, not a summary. Rename it to say what it is for -- `" +
          entry.unit.name +
          "` gives a reader and an agent nothing to narrow by, while a name of two or three specific words makes every future search cheaper.",
        location: entry.unit.location,
        identity: [RULE_ID, entry.unit.file, entry.unit.name].join("\u0000"),
        judged: false,
      }),
    )

    return outcome(findings, [
      candidates.length +
        " single-word export(s) called from " +
        minFiles +
        " or more files" +
        (candidates.length > maxFindings ? " (showing " + maxFindings + ")" : ""),
    ])
  }),
})
