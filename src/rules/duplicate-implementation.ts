import { Effect } from "effect"
import { defineRule, finding } from "../rule.ts"
import type { Diagnostic } from "../schema.ts"
import type { Unit } from "../workspace.ts"

const RULE_ID = "joggle/duplicate-implementation"

/**
 * Deterministic rule: group declarations by their normalized shape and report
 * every member after the first.
 *
 * This is the half of the entropy machine that a compression algorithm is
 * genuinely good at. It runs with no network, no API key and no cache, which
 * means the gate stays meaningful even when the judge is unavailable.
 */
export const duplicateImplementation = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "Structurally identical declarations in more than one file.",
  run: Effect.fn("joggle/duplicate-implementation")(function* (workspace) {
    const groups = new Map<string, Array<Unit>>()
    for (const unit of workspace.units) {
      const key = `${unit.kind}:${unit.shapeHash}`
      const existing = groups.get(key)
      if (existing === undefined) groups.set(key, [unit])
      else existing.push(unit)
    }

    const diagnostics: Array<Diagnostic> = []
    for (const group of groups.values()) {
      if (new Set(group.map((unit) => unit.file)).size < 2) continue
      const ordered = [...group].sort((a, b) =>
        a.file === b.file ? a.start - b.start : a.file < b.file ? -1 : 1,
      )
      const canonical = ordered[0]
      if (canonical === undefined) continue
      for (const unit of ordered.slice(1)) {
        diagnostics.push(
          finding({
            ruleId: RULE_ID,
            severity: "warn",
            message: `${unit.kind === "function" ? "Implementation" : "Declaration"} is structurally identical to \`${canonical.name}\` in ${canonical.file}:${canonical.location.line}.`,
            help: `Keep \`${canonical.name}\` and import it here. If the two are genuinely different concepts, change one so the shape differs.`,
            location: unit.location,
            judged: false,
          }),
        )
      }
    }
    return diagnostics
  }),
})
