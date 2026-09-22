import { Effect } from "effect"
import { lineAt, lineStarts } from "../cascade.ts"
import { policy } from "../policy.ts"
import { defineRule, finding, inScope, outcome, type Scope } from "../rule.ts"
import { stripFile } from "./call-pattern.ts"
import type { Diagnostic, Edit } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/reimplemented-primitive"

/** Split a call's argument list on top-level commas, respecting nesting and quotes. */
const splitTopLevel = (text: string): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let depth = 0
  let quote = ""
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? ""
    if (quote !== "") {
      if (character === quote && text[index - 1] !== "\\") quote = ""
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character
      continue
    }
    if (character === "(" || character === "[" || character === "{") depth += 1
    else if (character === ")" || character === "]" || character === "}") depth -= 1
    else if (character === "," && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part !== "")
}

/**
 * The INPUTS a call reads, as opposed to the calls it chains.
 *
 * Keying on callee names alone reported two functions as re-implementations
 * because both read `Number -> Number -> Number -> String`, when the difference
 * was what they fed in (`row.companyTotal` against `row.crewTotal`). Keying on
 * the raw argument text instead broke the real case, where one declaration
 * writes `save(validate(normalise(row)))` and the other sequences the same three
 * calls through locals. So a nested call and a bare identifier -- a local or a
 * parameter -- both become `#`, while a member access, a literal or an
 * expression is kept. A chain therefore keeps only its source, and two
 * different sources stop looking alike.
 */
const inputKey = (call: string): string => {
  const open = call.indexOf("(")
  const close = call.lastIndexOf(")")
  if (open === -1 || close <= open) return "()"
  const args = splitTopLevel(call.slice(open + 1, close))
  if (args.length === 0) return "()"
  return "(" + args.map(argKey).join(",") + ")"
}

const argKey = (arg: string): string => {
  const normalized = arg.replace(/\s+/g, " ")
  if (normalized.includes("(")) return "#"
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized)) return "#"
  return normalized
}

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

    const fileOf = new Map(workspace.files.map((file) => [file.path, file]))

    // A call is its callee AND its arguments. Keying on callee names alone
    // reported `companyYearTotalsJson` as a re-implementation of
    // `crewSummaryToJson` because both read `Number -> Number -> Number ->
    // String`; the arguments are what told the two apart.
    const signatureOf = (
      unit: Unit,
    ):
      | {
          readonly keys: ReadonlyArray<string>
          readonly sites: ReadonlyArray<{ readonly start: number; readonly end: number }>
          readonly text: string
        }
      | undefined => {
      const file = fileOf.get(unit.file)
      if (file === undefined) return undefined
      const sites = file.facts.callSites.filter(
        (site) => site.start >= unit.start && site.end <= unit.end,
      )
      // The pairing only holds when every call has its span.
      if (sites.length !== unit.calls.length) return undefined
      const keys = sites.map(
        (site, index) =>
          (unit.calls[index] ?? "") + "\u0001" + inputKey(file.text.slice(site.start, site.end)),
      )
      return { keys, sites, text: file.text }
    }

    // A declaration whose WHOLE body is its call sequence. That is the thing that
    // can be called instead of inlined; a longer declaration is not a primitive.
    const bySequence = new Map<string, Unit>()
    for (const unit of workspace.units) {
      if (unit.kind !== "function" || unit.calls.length < minCalls) continue
      const signature = signatureOf(unit)
      if (signature === undefined) continue
      const key = signature.keys.join("\u0000")
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
      const signature = signatureOf(unit)
      if (signature === undefined) continue
      const starts = lineStarts(signature.text)

      for (let start = 0; start + minCalls <= unit.calls.length; start += 1) {
        const length = unit.calls.length - start
        const helper = bySequence.get(signature.keys.slice(start, start + length).join("\u0000"))
        if (helper === undefined || helper === unit) continue
        // A function that already calls the helper is not inlining it.
        if (unit.calls.includes(helper.file + "#" + helper.name)) continue
        const first = signature.sites[start]
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
