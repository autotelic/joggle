import { Effect } from "effect"
import { policy } from "../policy.ts"
import { defineRule, finding, outcome, type Scope } from "../rule.ts"
import { stripFile } from "./call-pattern.ts"
import type { Diagnostic } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/duplicate-call-run"

/**
 * A run of calls one declaration shares with another, without sharing the whole
 * sequence.
 *
 * `call-pattern` compares the WHOLE sequence: two functions that do the same
 * three things and then diverge are two functions, and it is right not to call
 * them one. But when the shared run is the body of a helper that already exists,
 * the longer function has inlined it and should call it instead. That is the
 * case a whole-sequence comparison cannot see, and it is how a shared filter, a
 * shared validation or a shared query chain gets copied into a second call site.
 *
 * Deterministic. The calls are resolved, so "the same call" is identity rather
 * than spelling, and the run is extended left and right from a shared n-gram so
 * the report names the longest one.
 */
export const duplicateCallRun = defineRule({
  id: RULE_ID,
  severity: "info",
  description: "A run of calls one declaration shares with another, without the whole sequence.",
  judged: false,
  run: Effect.fn("joggle/duplicate-call-run")(function* (workspace: Workspace, scope: Scope) {
    const { minCalls, maxFindings } = policy.duplicateCallRun
    const eligible = workspace.units.filter(
      (unit) =>
        unit.kind === "function" &&
        unit.calls.length >= minCalls &&
        // A framework export is called by the framework, not by a sibling.
        !policy.frameworkExports.some((name) => name === unit.name),
    )
    if (eligible.length === 0) {
      return outcome([], [
        "no function makes " + minCalls + " or more resolved calls, so nothing had a run to share",
      ])
    }

    // Every function is indexed by each run of `minCalls` calls it contains, so
    // two functions that share a run meet at that run.
    const grams = new Map<string, Array<{ unit: Unit; start: number }>>()
    for (const unit of eligible) {
      for (let start = 0; start + minCalls <= unit.calls.length; start += 1) {
        const key = unit.calls.slice(start, start + minCalls).join("\u0000")
        const list = grams.get(key) ?? []
        list.push({ unit, start })
        grams.set(key, list)
      }
    }

    // The longest run per pair, so a pair is reported once.
    const runs = new Map<string, { left: Unit; right: Unit; length: number; start: number }>()
    for (const list of grams.values()) {
      // A run shared by a hundred functions is a common idiom, not a helper to
      // call. Bound the pairs so one popular run cannot cost a quadratic scan.
      const bounded = list.slice(0, 50)
      for (let one = 0; one < bounded.length; one += 1) {
        for (let two = one + 1; two < bounded.length; two += 1) {
          const a = bounded[one]
          const b = bounded[two]
          if (a === undefined || b === undefined) continue
          if (a.unit.file === b.unit.file) continue
          // The whole sequence matching is `call-pattern`'s finding.
          if (a.unit.callSignature === b.unit.callSignature) continue
          let left = 0
          while (
            a.start - left - 1 >= 0 &&
            b.start - left - 1 >= 0 &&
            a.unit.calls[a.start - left - 1] === b.unit.calls[b.start - left - 1]
          ) {
            left += 1
          }
          let right = minCalls
          while (
            a.start + right < a.unit.calls.length &&
            b.start + right < b.unit.calls.length &&
            a.unit.calls[a.start + right] === b.unit.calls[b.start + right]
          ) {
            right += 1
          }
          const length = left + right
          if (length < minCalls) continue
          const start = a.start - left
          const key = [a.unit.file, a.unit.name, b.unit.file, b.unit.name]
            .sort((one, two) => one.localeCompare(two))
            .join("\u0000")
          const existing = runs.get(key)
          if (existing === undefined || length > existing.length) {
            runs.set(key, { left: a.unit, right: b.unit, length, start })
          }
        }
      }
    }

    const findings: Array<Diagnostic> = []
    const reported = [...runs.values()]
      .filter(
        (run) =>
          scope.changed === undefined ||
          scope.changed.has(run.left.file) ||
          scope.changed.has(run.right.file),
      )
      .sort(
        (one, two) =>
          two.length - one.length ||
          one.left.file.localeCompare(two.left.file) ||
          one.left.name.localeCompare(two.left.name),
      )

    for (const run of reported) {
      if (findings.length >= maxFindings) break
      const steps = run.left.calls.slice(run.start, run.start + run.length).map(stripFile)
      findings.push(
        finding({
          ruleId: RULE_ID,
          severity: "info",
          message:
            run.left.name + " and " + run.right.name + " share " + run.length + " call(s) in the same order, but are not the same function.",
          help:
            "A shared run this long is a helper one of them has inlined: " +
            steps.join(" -> ") +
            ". If it is one thing, make it a function and call it from both.",
          location: run.left.location,
          identity: [RULE_ID, run.left.file, run.left.name, run.right.file, run.right.name].join("\u0000"),
          judged: false,
        }),
      )
    }

    return outcome(findings, [
      eligible.length +
        " function(s) with " +
        minCalls +
        " or more resolved calls; " +
        findings.length +
        " shared run(s) reported",
      ...(reported.length > findings.length
        ? [reported.length - findings.length + " were past the limit of " + maxFindings + " and were not reported"]
        : []),
    ])
  }),
})
