import { Effect } from "effect"
import { policy } from "../policy.ts"
import { defineRule, finding, outcome, type Scope } from "../rule.ts"
import type { Diagnostic } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/name-the-primitive"

/**
 * A group of fields that always appears together and has no name.
 *
 * The other half of composing smaller canonical things. `compose-types` finds a
 * type that repeats a NAMED type; this finds the shape that no one has named yet
 * -- the three or four fields that appear together in nine different declarations
 * and are re-declared each time, so every new declaration is a chance to get one
 * of them slightly wrong.
 *
 * Deterministic and free, like the composition rule, and derived the same way: a
 * set comparison over field sets. The judgement a person makes -- is this
 * genuinely one thing? -- is not asked. The finding states the co-occurrence and
 * the reader decides, because noticing is the part nobody does by eye.
 */
const isTypeUnit = (unit: Unit): boolean =>
  (unit.kind === "interface" || unit.kind === "type") &&
  unit.fields.length >= policy.nameThePrimitive.minFields

const signatureOf = (fields: ReadonlyArray<string>): string => [...fields].sort().join("\u0000")

export const nameThePrimitive = defineRule({
  id: RULE_ID,
  severity: "info",
  description: "A group of fields repeated across declarations with no name of its own.",
  judged: false,
  run: Effect.fn("joggle/name-the-primitive")(function* (workspace: Workspace, scope: Scope) {
    const { minFields, minOccurrences, maxFindings } = policy.nameThePrimitive
    const types = workspace.units.filter(isTypeUnit)
    if (types.length === 0) {
      return outcome([], [
        "no type declaration has " +
          minFields +
          " or more fields, so there was nothing to mine for repeated groups",
      ])
    }

    // Every field set that already has a name, so a group that is one of them is
    // not reported: that is `compose-types`' finding, and it is the better one.
    const named = new Set(types.map((unit) => signatureOf(unit.fields)))

    // Which declarations each pair of fields appears in together.
    const pairOccurrences = new Map<string, Array<Unit>>()
    for (const unit of types) {
      const fields = [...new Set(unit.fields)]
      for (let a = 0; a < fields.length; a += 1) {
        for (let b = a + 1; b < fields.length; b += 1) {
          const left = fields[a]
          const right = fields[b]
          if (left === undefined || right === undefined) continue
          const key = signatureOf([left, right])
          const existing = pairOccurrences.get(key)
          if (existing === undefined) pairOccurrences.set(key, [unit])
          else existing.push(unit)
        }
      }
    }

    const considered = [...pairOccurrences.entries()]
      .filter(([, units]) => units.length >= minOccurrences)
      .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))

    // Every group the repeated pairs imply. Starting from a pair and intersecting
    // the declarations that carry it finds GROUPS rather than pairs without mining
    // every subset of every declaration.
    const groups: Array<{ units: ReadonlyArray<Unit>; fields: ReadonlyArray<string> }> = []
    for (const [, units] of considered) {
      const first = units[0]
      if (first === undefined) continue
      let group = new Set(first.fields)
      for (const unit of units) {
        const fields = new Set(unit.fields)
        group = new Set([...group].filter((field) => fields.has(field)))
      }
      if (group.size < minFields) continue
      // A group that already has a name is `compose-types`' finding, not this one.
      if (named.has(signatureOf([...group]))) continue
      groups.push({ units, fields: [...group].sort() })
    }
    // Largest first, then most repeated, so a cap keeps the strongest groups and
    // a larger group absorbs the smaller ones it contains.
    groups.sort(
      (left, right) =>
        right.fields.length - left.fields.length ||
        right.units.length - left.units.length ||
        left.fields.join(",").localeCompare(right.fields.join(",")),
    )

    const kept: Array<ReadonlyArray<string>> = []
    const findings: Array<Diagnostic> = []
    for (const entry of groups) {
      const units = entry.units
      const fields = entry.fields
      if (findings.length >= maxFindings) break
      const first = units[0]
      if (first === undefined) continue
      if (scope.changed !== undefined && !scope.changed.has(first.file)) continue
      // A group already reported in full makes this one redundant: reporting
      // `{id, project, updated_at}` beside the five-field group that contains it is
      // the same finding twice.
      if (kept.some((seen) => fields.every((field) => seen.includes(field)))) continue
      kept.push(fields)

      findings.push(
        finding({
          ruleId: RULE_ID,
          severity: "info",
          message:
            fields.join(", ") +
            " appear together in " +
            units.length +
            " declaration(s) and are never named as one thing.",
          help:
            "Extract them as a named type and compose it, so the next declaration adds a field in one place instead of four. See " +
            first.file +
            ":" +
            first.location.line +
            ", where " +
            first.name +
            " repeats them.",
          location: first.location,
          identity: [RULE_ID, fields.join("\u0000")].join("\u0000"),
          judged: false,
        }),
      )
    }

    return outcome(findings, [
      types.length +
        " type declaration(s); " +
        considered.length +
        " field group(s) repeat in at least " +
        minOccurrences +
        " declarations" +
        (findings.length >= maxFindings ? " (capped at " + maxFindings + ")" : ""),
    ])
  }),
})
