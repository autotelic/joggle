import { Effect } from "effect"
import { Decision } from "effect/unstable/ai"
import { Atoms } from "../atoms.ts"
import { policy } from "../policy.ts"
import { verdictsOf, type Plan } from "../plans.ts"
import { locator, messages, reporter, type Report } from "../reporting.ts"
import {
  budgetNote,
  outcome,
  qualityOf,
  type DecisionAnswers,
  type PlannedRule,
  type Scope,
} from "../rule.ts"
import { verdictOf } from "../verdict.ts"
import type { Diagnostic, Drop } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"
// meta-allow: no-pattern-classifier -- pending the fact-based rebuild: guard shapes by regex and a hand-maintained set of wide types.
// See docs/rule-coupling.md.

const RULE_ID = "joggle/types-over-logic"

// A guard clause on a value whose type should carry the guarantee.
//
// The rule this repository kept needing: a problem is chased down by ADDING
// LOGIC -- another `if`, another `typeof`, another null check -- where refining a
// type (a brand, a refined schema, a non-nullable type parsed once) would make
// the check unnecessary and the class of bug impossible. `parse, don't validate`
// as a finding rather than a principle.
//
// The deterministic half is the shape: a function guards a value it declared as a
// bare primitive (`string`, `number`, `unknown`), a nullable, or `any`, and the
// guard returns or throws. The judgement is whether the guard is where the type
// SHOULD be established (a parse boundary), or whether it is logic standing in
// for a type that should already exist.
const BARE = new Set(["string", "number", "boolean", "object", "unknown", "any"])
const NULLABLE = /\bnull\b|\bundefined\b/

/** The value a guard clause tests, and the check as written. */
const GUARDS: ReadonlyArray<RegExp> = [
  /if\s*\(\s*!\s*([A-Za-z_$][\w$]*)\s*\)/g,
  /if\s*\(\s*([A-Za-z_$][\w$]*)\s*===?\s*(?:null|undefined)\s*\)/g,
  /if\s*\(\s*(?:typeof\s+)?([A-Za-z_$][\w$]*)\s*!==?\s*["'][^"']+["']\s*\)/g,
]

interface Guard {
  readonly value: string
  readonly check: string
}

const guardsIn = (text: string): ReadonlyArray<Guard> => {
  const found: Array<Guard> = []
  for (const pattern of GUARDS) {
    pattern.lastIndex = 0
    let match = pattern.exec(text)
    while (match !== null) {
      const value = match[1]
      const start = match.index
      // A guard CLAUSE returns or throws; a bare `if (x) doThing()` is control
      // flow, not an invariant.
      const after = text.slice(start, start + 220)
      if (value !== undefined && (after.includes("return") || after.includes("throw"))) {
        found.push({ value, check: match[0] })
      }
      match = pattern.exec(text)
    }
  }
  return found
}

/**
 * The declared type of a name, from a parameter or local annotation, or "".
 *
 * One argument rather than two adjacent strings: the linter's own
 * `no-swappable-primitive-params` would flag `(text, name)`.
 */
const declaredTypeOf = (input: { readonly text: string; readonly name: string }): string => {
  const pattern = new RegExp("\\b" + input.name + "\\s*\\??\\s*:\\s*([^,;)\\n=]+)")
  return pattern.exec(input.text)?.[1]?.trim() ?? ""
}

/** A type wide enough that a guard is carrying an invariant it could hold. */
const isWide = (declared: string): boolean => BARE.has(declared) || NULLABLE.test(declared)

export const typesOverLogic: PlannedRule = {
  id: RULE_ID,
  severity: "info",
  description: "A runtime guard on a value whose type should carry the guarantee.",
  judged: true,
  move: "expand",
  onUnavailable: "report",
  messages: messages({
    guard_not_type:
      "{{name}} guards `{{value}}` (`{{declared}}`) with `{{check}}`, a check a type could carry.",
    guard_not_type_help:
      "Parse the value once at the boundary into a narrower type -- a branded id, a validated schema type, a non-nullable type -- and every guard like this one disappears. If the check is genuinely the boundary, pin that decision so it is not asked again.{{unverified}}",
  }),
  plan: Effect.fn("joggle/types-over-logic")(function* (workspace: Workspace, scope: Scope) {
    const report = reporter(typesOverLogic, locator(workspace))
    const candidates: Array<{ unit: Unit; guard: Guard; declared: string }> = []
    for (const unit of workspace.units) {
      if (unit.kind !== "function") continue
      if (unit.text.length > policy.evidence.maxSourceChars) continue
      if (scope.changed !== undefined && !scope.changed.has(unit.file)) continue
      for (const guard of guardsIn(unit.text)) {
        const declared = declaredTypeOf({ text: unit.text, name: guard.value })
        if (declared === "" || !isWide(declared)) continue
        candidates.push({ unit, guard, declared })
      }
    }

    if (candidates.length === 0) {
      return {
        plans: [],
        read: () =>
          outcome([], [
            "no function guards a value it declared as a bare primitive, a nullable or unknown",
          ]),
      }
    }

    const budget = policy.evidence.maxMembers * 16
    const judged = candidates.slice(0, budget)
    const overBudget: ReadonlyArray<Drop> = candidates.slice(budget).map((candidate) => ({
      ruleId: RULE_ID,
      subject: candidate.unit.name,
      stage: "budget" as const,
      reason: "past the budget of " + String(budget) + " guards",
    }))

    const atoms = yield* Atoms
    const planned = yield* Effect.forEach(judged, (candidate) =>
      Effect.gen(function* () {
        const id = yield* atoms.add({
          declaration: { name: candidate.unit.name, file: candidate.unit.file, line: candidate.unit.location.line },
          value: candidate.guard.value,
          declaredType: candidate.declared,
          check: candidate.guard.check,
          source: candidate.unit.text.slice(0, policy.evidence.maxSourceChars),
        })
        const plan: Plan<DecisionAnswers> = {
          ruleId: RULE_ID,
          subject: candidate.unit.name + " (" + candidate.unit.file + ")",
          concerns: [candidate.unit.file],
          atoms: [id],
          violations: { verdict: ["type_should_carry_it"] },
          decisions: {
            verdict: Decision.classify({
              instructions: [
                `\`atoms[${id}].source\` is a function. It guards \`atoms[${id}].value\`, declared as \`atoms[${id}].declaredType\`, with \`atoms[${id}].check\`.`,
                "A parameter or local typed `T | null`, `string | number`, or `unknown` that this guard narrows is the common shape of the problem: the wide type is doing the work a narrower one should.",
                "Does the guard stand in for a type that should carry the guarantee, or is it where the guarantee is legitimately established?",
                "Answer `type_should_carry_it` when the value could be parsed once at the boundary into a narrower type -- a branded id, a validated schema type, a non-nullable type -- so that this check and every later one like it disappears and the class of bug becomes impossible.",
                "Answer `boundary_check` ONLY when the function's own job is to turn untrusted input into a typed value: a raw or unparsed argument, network data, a schema decode. A function that takes an already-typed value and handles its null or union case is NOT a boundary -- the narrowing belongs in the caller's type.",
                "Answer `runtime_condition` ONLY when the guard tests state a type cannot hold: a flag, a network result, a value looked up at run time.",
              ].join("\n"),
              criteria: {
                type_should_carry_it: "A type should carry it. Parse once at the boundary and brand it.",
                boundary_check: "This is the boundary. The check establishes the type.",
                runtime_condition: "Runtime state, not a type invariant.",
              },
            }),
          },
          read: (answers) => answers,
        }
        return { candidate, id, plan }
      }),
      { concurrency: "unbounded" },
    )

    return {
      plans: planned.map((value) => value.plan),
      read: (answers) => {
        const verdicts = verdictsOf<DecisionAnswers>(answers)
        const diagnostics: Array<Diagnostic> = []
        const drops: Array<Drop> = [...overBudget]
        planned.forEach((value, index) => {
          const { unit } = value.candidate
          const subject = unit.name + " (" + unit.file + ")"
          const verdict = verdictOf(verdicts[index]?.["verdict"], ["type_should_carry_it"])
          if (verdict === undefined) {
            diagnostics.push(findingFor(report, value.candidate, undefined, "no judgement was available"))
            return
          }
          if (verdict.label !== "type_should_carry_it") {
            drops.push({
              ruleId: RULE_ID,
              subject,
              stage: "declined",
              reason:
                verdict.label === "boundary_check"
                  ? "this is the parse boundary"
                  : "the guard tests runtime state",
            })
            return
          }
          const quality = qualityOf({
            score: verdict.probability,
            margin: verdict.margin,
            confidence: verdict.confidence,
          })
          if (quality.quality === "drop") {
            drops.push({
              ruleId: RULE_ID,
              subject,
              stage: "gated",
              reason: quality.reason,
            })
            return
          }
          diagnostics.push(findingFor(report, value.candidate, verdict.confidence, undefined))
        })
        return outcome(
          diagnostics,
          budgetNote("guards", budget, candidates.length, candidates.slice(budget).map((c) => c.unit.name)),
          drops,
        )
      },
    }
  }),
}

const findingFor = (
  report: Report,
  candidate: { readonly unit: Unit; readonly guard: Guard; readonly declared: string },
  confidence: number | undefined,
  unverifiedReason: string | undefined,
): Diagnostic =>
  report({
    at: candidate.unit,
    messageId: "guard_not_type",
    data: {
      name: candidate.unit.name,
      value: candidate.guard.value,
      declared: candidate.declared,
      check: candidate.guard.check,
      unverified: unverifiedReason === undefined ? "" : " Not verified: " + unverifiedReason + ".",
    },
    helpId: "guard_not_type_help",
    identity: [RULE_ID, candidate.unit.file, candidate.unit.name, candidate.guard.value].join("\u0000"),
    judged: unverifiedReason === undefined,
    severity: "info",
    confidence,
  })
