import { Effect } from "effect"
import { policy } from "../policy.ts"
import { defineRule, finding, inScope, outcome, type Scope } from "../rule.ts"
import type { Diagnostic } from "../schema.ts"
import type { TypeFact } from "../typetrace.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/one-concept-one-type"

/**
 * One declared name, resolving to different types in different files.
 *
 * JOGGLE.md names this as the first type-aware rule, and the reason is that text
 * cannot see it. `User` in the API and `User` in the UI read identically and are
 * two types; `User` written twice with the same members reads identically and is
 * one type written twice. Only the compiler can tell which, because only the
 * compiler resolves the name.
 *
 * The measured case from JOGGLE.md: one `User`, 46 resolved entries across 24
 * declaring files, 3 distinct resolved shapes, 4 of them `any`. This rule reports
 * the divergence and names every declaration that took part, so the reader sees
 * the three meanings instead of the one word.
 *
 * Deterministic. The compiler's answer is a fact, not a judgement; what to DO
 * about two meanings is the reader's decision, and the help gives them the
 * material for it.
 */
export const oneConceptOneType = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "One declared name resolving to different types in different files.",
  judged: false,
  run: Effect.fn("joggle/one-concept-one-type")(function* (workspace: Workspace, scope: Scope) {
    const byName = new Map<string, Array<{ readonly unit: Unit; readonly fact: TypeFact }>>()
    for (const unit of workspace.units) {
      // Functions are already compared as names and as call sequences. This rule
      // is about the one contract the compiler enforces, and that is a type.
      if (unit.kind === "function") continue
      // An exported name is a contract other modules import. Two file-local
      // helpers that share a name are two locals, and nothing outside their own
      // files can confuse them, so reporting them is noise.
      if (!unit.exported) continue
      const fact = unit.typeFacts
      // A run without a trace has no answer, and "no answer" is not "no
      // divergence": the empty index is why the note below distinguishes them.
      if (fact === undefined || fact.display === "") continue
      const list = byName.get(unit.name) ?? []
      list.push({ unit, fact })
      byName.set(unit.name, list)
    }

    const findings: Array<Diagnostic> = []
    let divergent = 0
    for (const [name, entries] of byName) {
      const files = new Set(entries.map((entry) => entry.unit.file))
      const meanings = new Set(entries.map((entry) => entry.fact.display))
      // One file declaring the name twice is a different rule; this is the
      // cross-file meaning of a name, which is what a reader importing it faces.
      if (files.size < 2 || meanings.size < 2) continue
      if (!entries.some((entry) => inScope(scope, entry.unit.file))) continue
      divergent += 1
      if (findings.length >= policy.oneConceptOneType.maxFindings) continue
      const first = entries[0]
      if (first === undefined) continue
      findings.push(
        finding({
          ruleId: RULE_ID,
          severity: "warn",
          message:
            "`" +
            name +
            "` resolves to " +
            meanings.size +
            " different types across " +
            files.size +
            " file(s).",
          help:
            "One name should mean one type. The compiler resolved it to: " +
            entries
              .map(
                (entry) =>
                  entry.unit.file +
                  ":" +
                  entry.unit.location.line +
                  " -> " +
                  short(entry.fact.display),
              )
              .join("; ") +
            ". Share one declaration, or give the two concepts two names.",
          location: first.unit.location,
          identity: [RULE_ID, name].join("\u0000"),
          judged: false,
        }),
      )
    }

    if (byName.size === 0) {
      return outcome([], [
        workspace.types.sites === 0
          ? "no resolved types were available: run with --types to ask the compiler"
          : "no exported type declaration carried a resolved type to compare",
      ])
    }
    return outcome(findings, [
      byName.size +
        " exported type name(s) with a resolved type; " +
        divergent +
        " resolve to more than one",
      ...(divergent > findings.length
        ? [
            divergent -
              findings.length +
              " were past the limit of " +
              policy.oneConceptOneType.maxFindings +
              " and were not reported",
          ]
        : []),
    ])
  }),
})

/** A resolved type, cut to the length a finding's help can carry. */
const short = (value: string): string =>
  value.length <= policy.oneConceptOneType.maxTypeChars
    ? value
    : value.slice(0, policy.oneConceptOneType.maxTypeChars) + "..."
