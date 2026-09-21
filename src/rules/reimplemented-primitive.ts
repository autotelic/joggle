import { Effect } from "effect"
import { lineAt, lineStarts } from "../cascade.ts"
import { policy } from "../policy.ts"
import { defineRule, finding, inScope, outcome, type Scope } from "../rule.ts"
import { stripFile } from "./call-pattern.ts"
import type { Diagnostic, Edit } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/reimplemented-primitive"

/**
 * A function that inlines exactly what an existing declaration already does.
 *
 * The strongest form of the case this tool is for: an agent writes a helper, and
 * the codebase already has that helper. The call sequences are resolved and
 * identical, so the claim is a FACT rather than a judgement -- there is nothing
 * for a model to decide, and asking one would be the mistake
 * `joggle/rule-judgment` exists to find.
 *
 * The operation is `replace`: call the existing declaration instead of repeating
 * its body. The cascade names the call run and the import to add.
 */
export const reimplementedPrimitive = defineRule({
  id: RULE_ID,
  severity: "info",
  description: "A function that inlines exactly what an existing declaration already does.",
  judged: false,
  operations: ["replace"],
  run: Effect.fn("joggle/reimplemented-primitive")(function* (workspace: Workspace, scope: Scope) {
    const { minCalls, maxFindings } = policy.reimplementedPrimitive

    // A declaration whose WHOLE body is its call sequence. That is the thing that
    // can be called instead of inlined; a longer declaration is not a primitive.
    const bySequence = new Map<string, Unit>()
    for (const unit of workspace.units) {
      if (unit.kind !== "function" || unit.calls.length < minCalls) continue
      const key = unit.calls.join("\u0000")
      if (!bySequence.has(key)) bySequence.set(key, unit)
    }
    if (bySequence.size === 0) {
      return outcome([], [
        "no function's whole body is a run of " + minCalls + " or more resolved calls",
      ])
    }

    const findings: Array<Diagnostic> = []
    let found = 0
    for (const unit of workspace.units) {
      if (unit.kind !== "function" || unit.calls.length < minCalls) continue
      if (!inScope(scope, unit.file)) continue
      const file = workspace.files.find((candidate) => candidate.path === unit.file)
      if (file === undefined) continue
      const sites = file.facts.callSites.filter(
        (site) => site.start >= unit.start && site.end <= unit.end,
      )
      // The pairing only holds when every call has its span.
      if (sites.length !== unit.calls.length) continue
      const starts = lineStarts(file.text)

      for (let start = 0; start + minCalls <= unit.calls.length; start += 1) {
        const length = unit.calls.length - start
        const helper = bySequence.get(unit.calls.slice(start, start + length).join("\u0000"))
        if (helper === undefined || helper === unit) continue
        // A function that already calls the helper is not inlining it.
        if (unit.calls.includes(helper.file + "#" + helper.name)) continue
        const first = sites[start]
        if (first === undefined) break
        found += 1
        if (findings.length >= maxFindings) break

        const edits: Array<Edit> = [
          {
            file: unit.file,
            line: lineAt(starts, first.start),
            column: 1,
            instruction:
              "replace these " + length + " call(s) with `" + helper.name + "` from " + helper.file,
          },
        ]
        if (helper.file !== unit.file) {
          edits.push({
            file: unit.file,
            line: 1,
            column: 1,
            instruction: "import `" + helper.name + "` from `" + helper.file + "`",
          })
        }

        findings.push(
          finding({
            ruleId: RULE_ID,
            severity: "info",
            message:
              unit.name +
              " inlines what `" +
              helper.name +
              "` already does: " +
              length +
              " call(s) in the same order.",
            help:
              "Call `" +
              helper.name +
              "` in " +
              helper.file +
              " instead of repeating its body. The calls are " +
              unit.calls.slice(start, start + length).map(stripFile).join(" -> ") +
              ".",
            location: unit.location,
            identity: [RULE_ID, unit.file, unit.name, helper.file, helper.name].join("\u0000"),
            judged: false,
            repair: {
              operation: "replace",
              keep: helper.location,
              remove: [],
              cascade: edits,
              complete: true,
              settled: "the call sequences are identical, so this is a fact rather than a judgement",
            },
          }),
        )
        break
      }
    }

    return outcome(findings, [
      bySequence.size +
        " declaration(s) whose whole body is a run of calls; " +
        found +
        " re-implementation(s) found",
    ])
  }),
})
