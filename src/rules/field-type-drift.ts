import { Effect } from "effect"
import { policy } from "../policy.ts"
import { defineRule, finding, outcome, type Scope } from "../rule.ts"
import { canCompose } from "./compose-types.ts"
import type { Diagnostic } from "../schema.ts"
import type { Workspace } from "../workspace.ts"

const RULE_ID = "joggle/field-type-drift"

// One field name declared with two incompatible types.
//
// A field name is a promise about meaning. When `projectId` is a `string` in one
// declaration and a `number` in another, code that moves between them compiles
// against whichever it imported and fails against the other, and the reader has
// to hold two meanings for one word.
//
// `compose-types` compares field SETS and asks whether one type could be written
// as another plus something. This is the complement: it compares the TYPE of a
// shared field and asks whether the two declarations can both be right.
//
// Compatible is not equal. `string` against `string | undefined` and `Policy`
// against `Partial<Policy>` are one concept written with different strictness --
// see `canCompose` -- so they are not drift. `string` against `number` is, and
// that is the finding.
//
// Deterministic, so it needs no model and no key. Whether the two are one concept
// or two is the reader's call; the finding states the disagreement.

/** The words a name is built from: `supervisorRate` is two, `files` is one. */
const wordsOf = (name: string): ReadonlyArray<string> =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")

interface Declaration {
  readonly type: string
  readonly unit: string
  readonly file: string
  readonly line: number
}

/** One field whose two declarations disagree. */
interface Drift {
  readonly field: string
  readonly left: Declaration
  readonly right: Declaration
}

export const fieldTypeDrift = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "One field name declared with different, incompatible types.",
  judged: false,
  run: Effect.fn("joggle/field-type-drift")(function* (workspace: Workspace, scope: Scope) {
    // Field name -> type text -> the declarations that use it.
    const byField = new Map<string, Map<string, Array<Declaration>>>()
    for (const unit of workspace.units) {
      if (unit.kind !== "interface" && unit.kind !== "type") continue
      for (const [field, annotation] of unit.fieldTypes) {
        const type = annotation.trim()
        // A shorthand member (`{ name }`) records the name as its own type, which
        // is not a type at all. Skip it rather than compare it.
        if (type === "" || type === field) continue
        const types = byField.get(field) ?? new Map<string, Array<Declaration>>()
        const declarations = types.get(type) ?? []
        declarations.push({ type, unit: unit.name, file: unit.file, line: unit.location.line })
        types.set(type, declarations)
        byField.set(field, types)
      }
    }

    const findings: Array<Diagnostic> = []
    let drifted = 0
    // Group by the declaration the finding is anchored to. A type with five
    // drifting fields produced five findings on the same line, which read as
    // duplicates and inflated the count; one finding that lists them is smaller
    // and truer to what a reader has to decide.
    const groups = new Map<string, { file: string; line: number; unit: string; drifts: Array<Drift> }>()
    for (const [field, types] of byField) {
      if (types.size < 2) continue
      if (wordsOf(field).length < policy.fieldTypeDrift.minWords) continue
      const entries = [...types.entries()]
      // The first pair of types that cannot both describe one concept.
      let pair: readonly [string, string] | undefined
      for (let left = 0; left < entries.length && pair === undefined; left += 1) {
        for (let right = left + 1; right < entries.length; right += 1) {
          const one = entries[left]
          const two = entries[right]
          if (one === undefined || two === undefined) continue
          if (!canCompose(one[0], two[0])) {
            pair = [one[0], two[0]]
            break
          }
        }
      }
      if (pair === undefined) continue
      const left = entries.find(([type]) => type === pair?.[0])?.[1][0]
      const right = entries.find(([type]) => type === pair?.[1])?.[1][0]
      if (left === undefined || right === undefined) continue
      // One declaration cannot disagree with itself.
      if (left.file === right.file && left.unit === right.unit) continue
      if (scope.changed !== undefined && !(scope.changed.has(left.file) || scope.changed.has(right.file))) {
        continue
      }
      drifted += 1
      const key = left.file + "\u0000" + left.line
      const group = groups.get(key) ?? { file: left.file, line: left.line, unit: left.unit, drifts: [] }
      group.drifts.push({ field, left, right })
      groups.set(key, group)
    }

    for (const group of groups.values()) {
      if (findings.length >= policy.fieldTypeDrift.maxFindings) break
      const first = group.drifts[0]
      if (first === undefined) continue
      const message =
        group.drifts.length === 1
          ? "`" + first.field + "` is `" + first.left.type + "` in " + first.left.unit + " and `" + first.right.type + "` in " + first.right.unit + "."
          : group.drifts.length +
            " field(s) of " +
            group.unit +
            " disagree with another declaration: " +
            group.drifts
              .slice(0, 3)
              .map((drift) => "`" + drift.field + "` (`" + drift.left.type + "` vs `" + drift.right.type + "`)")
              .join(", ") +
            (group.drifts.length > 3 ? ", and " + (group.drifts.length - 3) + " more" : "") +
            "."
      const where = group.drifts
        .map(
          (drift) =>
            drift.field +
            ": " +
            drift.left.file +
            ":" +
            drift.left.line +
            " and " +
            drift.right.file +
            ":" +
            drift.right.line,
        )
        .join("; ")
      findings.push(
        finding({
          ruleId: RULE_ID,
          severity: "warn",
          message,
          help:
            "One field name, two incompatible types. If they are one concept, share one declaration of it; if they are two concepts, give them two names. " +
            where +
            ".",
          location: { file: group.file, line: group.line, column: 1 },
          identity: [
            RULE_ID,
            group.file,
            String(group.line),
            ...group.drifts.map((drift) => drift.field).sort((left, right) => left.localeCompare(right)),
          ].join("\u0000"),
          judged: false,
        }),
      )
    }

    if (byField.size === 0) {
      return outcome([], ["no interface or type alias declared a field with a type to compare"])
    }

    return outcome(findings, [
      byField.size + " field name(s) across the type declarations; " + drifted + " with incompatible types",
      ...(drifted > findings.length
        ? [drifted - findings.length + " were past the limit of " + policy.fieldTypeDrift.maxFindings + " and were not reported"]
        : []),
    ])
  }),
})
