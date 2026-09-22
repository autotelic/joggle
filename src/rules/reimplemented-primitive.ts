import { Effect, Schema } from "effect"
import { Decision } from "effect/unstable/ai"
import { Atoms } from "../atoms.ts"
import { lineAt, lineStarts } from "../cascade.ts"
import { policy } from "../policy.ts"
import { verdictsOf, type Plan } from "../plans.ts"
import {
  finding,
  inScope,
  marginOfAnswer,
  outcome,
  qualityOf,
  type DecisionAnswers,
  type PlannedRule,
  type Scope,
} from "../rule.ts"
import { stripFile } from "./call-pattern.ts"
import type { Diagnostic, Drop, Edit } from "../schema.ts"
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
 * Two halves, and the split is the point of `docs/two-regimes.md`.
 *
 * The deterministic half is GENERATION: which pairs are even candidates. That is
 * the resolved call graph -- a function whose whole body is a run of calls has a
 * key, and two functions with the same key are a pair worth judging. The keys are
 * coarse on purpose (`inputKey` keeps only a call's source, because a chain
 * written nested and the same chain written through locals must match), so the
 * key is a high-recall filter and not the verdict.
 *
 * The judged half is the VERDICT: are these two the same operation? That is the
 * question `same_behavior` used to ask and answered badly, because it was asked
 * over text with no call sites in the state. Here the state IS the call graph --
 * both bodies, their callees resolved to declarations, and the leaf inputs they
 * read -- which is the evidence the old question was missing.
 *
 * A run with no model key reports the pair unverified rather than deciding it,
 * which is what a high-recall candidate deserves.
 */
export const reimplementedPrimitive: PlannedRule = {
  id: RULE_ID,
  severity: "info",
  description: "A function that inlines exactly what an existing declaration already does.",
  judged: true,
  onUnavailable: "report",
  operations: ["replace"],
  plan: Effect.fn("joggle/reimplemented-primitive")(function* (
    workspace: Workspace,
    scope: Scope,
  ) {
    const { minCalls, maxPairs } = policy.reimplementedPrimitive

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
      return {
        plans: [],
        read: () =>
          outcome([], [
            "no function's whole body is a run of " + minCalls + " or more resolved calls",
          ]),
      }
    }

    // Every pair: a run of calls in one declaration matching the whole body of
    // another. This is candidate generation and nothing more.
    const pairs: Array<{
      readonly unit: Unit
      readonly helper: Unit
      readonly start: number
      readonly length: number
    }> = []
    for (const unit of workspace.units) {
      if (unit.kind !== "function" || unit.calls.length < minCalls) continue
      if (!inScope(scope, unit.file)) continue
      const signature = signatureOf(unit)
      if (signature === undefined) continue
      for (let start = 0; start + minCalls <= unit.calls.length; start += 1) {
        const length = unit.calls.length - start
        const helper = bySequence.get(signature.keys.slice(start, start + length).join("\u0000"))
        if (helper === undefined || helper === unit) continue
        // A function that already calls the helper is not inlining it.
        if (unit.calls.includes(helper.file + "#" + helper.name)) continue
        pairs.push({ unit, helper, start, length })
        break
      }
    }

    if (pairs.length === 0) {
      return {
        plans: [],
        read: () =>
          outcome([], [
            bySequence.size +
              " declaration(s) whose whole body is a run of calls; no two share one",
          ]),
      }
    }

    // A bounded fan-out: one request per pair is the cache's requirement, and a
    // pathological repository should cost a budget rather than an afternoon.
    const atoms = yield* Atoms
    const planned = yield* Effect.forEach(
      pairs.slice(0, maxPairs),
      (pair) =>
        Effect.gen(function* () {
          const body = callGraphEvidence(pair.unit, workspace)
          const helper = callGraphEvidence(pair.helper, workspace)
          const id = yield* atoms.add({ declared: body, existing: helper, length: pair.length })
          const plan: Plan<DecisionAnswers> = {
            ruleId: RULE_ID,
            subject: pair.unit.name + " (" + pair.unit.file + ")",
            concerns: [pair.unit.file, pair.helper.file],
            atoms: [id],
            decisions: {
              same: Decision.classify({
                instructions: [
                  `Is \`atoms[${id}].declared\` the same operation as \`atoms[${id}].existing\`?`,
                  "Each side lists the calls it makes, resolved to the declaration each reaches, and the inputs each call reads.",
                  "Answer `same_operation` when the declared one could be replaced by a call to the existing one with no change in behaviour: the same work on the same inputs, in the same order.",
                  "Answer `different_inputs` when the two read different things, so they are two operations that happen to compose the same helpers.",
                  "Answer `different_order` when they call the same things in a different order, or interleave them differently.",
                  "Answer `different_work` when one does something the other does not.",
                ].join("\n"),
                criteria: {
                  same_operation: "The same work on the same inputs. One can call the other.",
                  different_inputs: "Same helpers, different inputs. Two operations, not one.",
                  different_order: "Same calls, different order or interleaving.",
                  different_work: "They do not do the same thing.",
                },
              }),
            },
            read: (answers) => answers,
          }
          return { pair, id, plan }
        }),
      { concurrency: "unbounded" },
    )

    return {
      plans: planned.map((entry) => entry.plan),
      read: (answers) => {
        const verdicts = verdictsOf<DecisionAnswers>(answers)
        const diagnostics: Array<Diagnostic> = []
        const drops: Array<Drop> = []
        planned.forEach((entry, index) => {
          const { pair } = entry
          const subject = pair.unit.name + " (" + pair.unit.file + ")"
          const answer = verdicts[index]
          const same = answer === undefined ? undefined : answer["same"]
          if (same === undefined || !("label" in same)) {
            // No judgement: report the fact unverified. A high-recall candidate
            // with no verdict is still a candidate a reader may want.
            diagnostics.push(
              findingFor(pair, workspace, "no judgement was available", "no judgement was available"),
            )
            return
          }
          if (same.label !== "same_operation") {
            drops.push({
              ruleId: RULE_ID,
              subject,
              stage: "declined",
              reason: "the model read them as " + same.label.replace(/_/g, " "),
            })
            return
          }
          const quality = qualityOf({
            score: probabilityOfLabel(same),
            margin: marginOfAnswer(same),
            confidence: same.confidence,
          })
          if (quality.quality === "drop") {
            drops.push({ ruleId: RULE_ID, subject, stage: "gated", reason: quality.reason })
            return
          }
          diagnostics.push(
            findingFor(
              pair,
              workspace,
              quality.quality === "act" ? undefined : quality.reason,
              "no judgement was available",
            ),
          )
        })
        return outcome(diagnostics, [], drops)
      },
    }
  }),
}

/** The probability the answer gave its own label. */
const probabilityOfLabel = (answer: { label: string; probabilities?: Record<string, number> }): number =>
  answer.probabilities?.[answer.label] ?? 0.7

/**
 * One declaration as a call graph, which is the state the question needs.
 *
 * `calls` are resolved to `file#name`; `inputs` are what each call reads, with a
 * local or a nested call collapsed to `#` -- the same collapse `inputKey` makes,
 * but now it is EVIDENCE rather than the verdict. The model sees that two
 * functions call the same three helpers and read different fields, and decides;
 * the key alone used to decide for it.
 */
const callGraphEvidence = (unit: Unit, workspace: Workspace): Schema.Json => {
  const file = workspace.files.find((candidate) => candidate.path === unit.file)
  const sites =
    file === undefined
      ? []
      : file.facts.callSites.filter((site) => site.start >= unit.start && site.end <= unit.end)
  const inputs = sites.map((site) =>
    file === undefined ? "()" : inputKey(file.text.slice(site.start, site.end)),
  )
  return {
    symbol: unit.name,
    path: unit.file,
    line: unit.location.line,
    calls: unit.calls.map(stripFile),
    inputs,
    source: unit.text.slice(0, policy.evidence.maxSourceChars),
    documented: unit.doc !== undefined,
    doc: unit.doc?.slice(0, policy.evidence.maxDocChars) ?? null,
  }
}

/** The finding for one candidate: verified, or the fact with the reason it is not. */
const findingFor = (
  pair: { readonly unit: Unit; readonly helper: Unit; readonly start: number; readonly length: number },
  workspace: Workspace,
  unverifiedReason: string | undefined,
  fallbackReason: string,
): Diagnostic => {
  const { unit, helper, start, length } = pair
  const file = workspace.files.find((candidate) => candidate.path === unit.file)
  const sites =
    file === undefined
      ? []
      : file.facts.callSites.filter((site) => site.start >= unit.start && site.end <= unit.end)
  const first = sites[start]
  const starts = file === undefined ? [] : lineStarts(file.text)

  const edits: Array<Edit> = [
    {
      file: unit.file,
      line: first === undefined ? unit.location.line : lineAt(starts, first.start),
      column: 1,
      instruction: "replace these " + length + " call(s) with `" + helper.name + "` from " + helper.file,
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

  const verified = unverifiedReason === undefined
  return finding({
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
      "." +
      (verified ? "" : " Not verified: " + (unverifiedReason ?? fallbackReason) + "."),
    location: unit.location,
    identity: [RULE_ID, unit.file, unit.name, helper.file, helper.name].join("\u0000"),
    judged: verified,
    repair: {
      operation: "replace",
      keep: helper.location,
      remove: [],
      cascade: edits,
      complete: true,
      settled: verified
        ? "the model read the two call graphs as the same operation"
        : "the call graphs match, so this is a candidate rather than a verdict",
    },
  })
}
