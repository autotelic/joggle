import { Effect } from "effect"
import { policy } from "../policy.ts"
import { defineRule, finding, outcome, type Scope } from "../rule.ts"
import type { Diagnostic } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/call-pattern"

/**
 * Two declarations that make the same calls in the same order.
 *
 * The one thing a body-shape comparison cannot see. `duplicate-implementation`
 * hashes what a declaration LOOKS like, and a re-implementation can look nothing
 * like its original while doing exactly the same things in exactly the same
 * order -- validate, then save, then notify. That is the same logic written twice,
 * and neither a shape hash nor a token overlap reliably finds it, because both are
 * distracted by everything else in the body.
 *
 * `calls` is resolved, so "both call the same function" is identity rather than
 * spelling: two call sites resolve to the same `file#name` or they do not. And the
 * shapes are required to DIFFER, because when they match this is already
 * `duplicate-implementation`'s finding and reporting it twice is how a report
 * stops being read.
 *
 * Deterministic and free. The sequences come from the parse, the resolution from
 * the same pass that resolves types, and nothing here needs a model.
 */
const callSequence = (unit: Unit): ReadonlyArray<string> => unit.calls

export const callPattern = defineRule({
  id: RULE_ID,
  severity: "info",
  description: "Declarations that make the same calls in the same order with different bodies.",
  judged: false,
  run: Effect.fn("joggle/call-pattern")(function* (workspace: Workspace, scope: Scope) {
    const { minCalls, maxFindings } = policy.callPattern
    const eligible = workspace.units.filter(
      (unit) =>
        callSequence(unit).length >= minCalls &&
        unit.kind === "function" &&
        // A framework export cannot be merged however alike two of them are: the
        // framework calls each one by file. Two Remix loaders that read a param,
        // fetch, check auth and return json are the same shape because they are
        // the same job, and consolidating them is not available.
        !policy.frameworkExports.some((name) => name === unit.name),
    )
    if (eligible.length === 0) {
      return outcome([], [
        "no function makes " +
          minCalls +
          " or more resolved calls, so nothing had an orchestration to compare",
      ])
    }

    const groups = new Map<string, Array<Unit>>()
    for (const unit of eligible) {
      const existing = groups.get(unit.callSignature)
      if (existing === undefined) groups.set(unit.callSignature, [unit])
      else existing.push(unit)
    }

    const findings: Array<Diagnostic> = []
    const skipped = { identical: 0 }
    const reported = [...groups.entries()]
      .filter(([, units]) => units.length > 1)
      .sort(
        (left, right) =>
          right[1].length - left[1].length || left[0].localeCompare(right[0]),
      )

    for (const [, units] of reported) {
      if (findings.length >= maxFindings) break
      // Different bodies, or this is the duplicate rule's finding and not this
      // one's. Two declarations with the same shape AND the same calls are one
      // declaration written twice.
      if (new Set(units.map((unit) => unit.shapeHash)).size === 1) {
        skipped.identical += 1
        continue
      }
      const first = units[0]
      if (first === undefined) continue
      if (
        scope.changed !== undefined &&
        !units.some((unit) => scope.changed?.has(unit.file))
      ) {
        continue
      }

      const names = [...new Set(units.map((unit) => unit.name))]
      const steps = callSequence(first).map(stripFile)
      findings.push(
        finding({
          ruleId: RULE_ID,
          severity: "info",
          message:
            names.join(", ") +
            " make the same " +
            steps.length +
            " call(s) in the same order, written " +
            units.length +
            " different ways.",
          help:
            "One of these is the original and the rest re-implement it: " +
            steps.join(" -> ") +
            ". Compare them and keep one, or make the shared part a function the others call.",
          location: first.location,
          identity: [RULE_ID, first.callSignature].join("\u0000"),
          judged: false,
        }),
      )
    }

    // Counted by what happened to each group, not by how many groups there were.
    // "13 shared orchestrations" beside one finding is the kind of note that
    // teaches a reader to stop believing the notes.
    return outcome(findings, [
      eligible.length +
        " function(s) with " +
        minCalls +
        " or more resolved calls; " +
        findings.length +
        " reported, " +
        skipped.identical +
        " already covered by shape equality (duplicate-implementation)",
    ])
  }),
})

/** `path/to/file.ts#name` reads better as `file:name` in a sentence. */
function stripFile(resolved: string): string {
  const cut = resolved.lastIndexOf("#")
  if (cut === -1) return resolved
  const path = resolved.slice(0, cut)
  const name = resolved.slice(cut + 1)
  const slash = path.lastIndexOf("/")
  return (slash === -1 ? path : path.slice(slash + 1)) + ":" + name
}
