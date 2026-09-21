import { Effect } from "effect"
import { policy } from "../policy.ts"
import { defineRule, finding, outcome, type Scope } from "../rule.ts"
import type { Diagnostic } from "../schema.ts"
import type { Workspace } from "../workspace.ts"

const RULE_ID = "joggle/object-shape"

/**
 * Object literals that share a shape and have no name.
 *
 * The entropy machine called this `object-duplicate` and described the fix as
 * "define a named type or interface, type-annotate all occurrences with it". It is
 * the runtime-value half of what `compose-types` does for declarations: a type
 * that repeats another type is a composition problem, and a literal that repeats
 * five others is a type nobody wrote down.
 *
 * Deterministic and free. Object literals are already collected per file; all this
 * adds is comparing their key sets across files.
 *
 * The key set is sorted before comparison, because `{a, b}` and `{b, a}` are one
 * shape. And a literal has to be in two different files, because two literals one
 * line apart are one author's habit rather than a missing type.
 */
export const objectShape = defineRule({
  id: RULE_ID,
  severity: "info",
  description: "Object literals that share a shape with no type of their own.",
  judged: false,
  run: Effect.fn("joggle/object-shape")(function* (workspace: Workspace, scope: Scope) {
    const { minKeys, maxFindings } = policy.objectShape
    // A shape a declared type already names is not a shape nobody named. This is
    // the precision half of the rule: every interface and type alias contributes
    // its field set, and a literal whose keys are exactly that set is skipped.
    // A shape a declared type already describes is not a shape nobody named.
    // Every interface and type alias contributes its field set, and a
    // `Schema.Struct` field object contributes its keys and the non-optional ones.
    // A shape a declared type already names is not a shape nobody named. A
    // literal is a use of a type when every key it has is a field of that type:
    // an exact match, and also a projection that drops optional fields -- the
    // common case, and the one the old "has every required field" test missed,
    // because optionality is not recorded for an interface.
    const declared: Array<ReadonlySet<string>> = []
    for (const unit of workspace.units) {
      if (unit.kind !== "interface" && unit.kind !== "type") continue
      if (unit.fields.length < minKeys) continue
      declared.push(new Set(unit.fields))
    }
    for (const file of workspace.files) {
      for (const site of file.facts.objects) {
        if (!site.declared) continue
        declared.push(new Set(site.keys))
      }
    }
    const isDeclared = (keys: ReadonlySet<string>): boolean =>
      declared.some((type) => [...keys].every((key) => type.has(key)))

    const groups = new Map<string, Array<{ file: string; start: number }>>()
    for (const file of workspace.files) {
      for (const site of file.facts.objects) {
        const keys = [...new Set(site.keys)]
        if (keys.length < minKeys) continue
        if (isDeclared(new Set(keys))) continue
        const signature = [...keys].sort().join("\u0000")
        const existing = groups.get(signature)
        if (existing === undefined) groups.set(signature, [{ file: file.path, start: site.start }])
        else existing.push({ file: file.path, start: site.start })
      }
    }

    const repeated = [...groups.entries()]
      .filter(([, sites]) => new Set(sites.map((site) => site.file)).size >= 2)
      .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))

    if (repeated.length === 0) {
      return outcome([], [
        "no object literal with " +
          minKeys +
          " or more keys appears in two or more files",
      ])
    }

    const findings: Array<Diagnostic> = []
    for (const [signature, sites] of repeated) {
      if (findings.length >= maxFindings) break
      const first = sites[0]
      if (first === undefined) continue
      if (scope.changed !== undefined && !sites.some((site) => scope.changed?.has(site.file))) continue
      const keys = signature.split("\u0000")
      const files = [...new Set(sites.map((site) => site.file))]
      findings.push(
        finding({
          ruleId: RULE_ID,
          severity: "info",
          message:
            sites.length +
            " object literal(s) in " +
            files.length +
            " file(s) share this shape: { " +
            keys.join("; ") +
            " }.",
          help:
            "Define a type with these fields and annotate each site with it. A shape nobody named is a shape nobody validates, and the sixth copy is written from memory: " +
            files.slice(0, policy.evidence.maxListedPaths).join(", ") +
            (files.length > policy.evidence.maxListedPaths
              ? " and " + (files.length - policy.evidence.maxListedPaths) + " more"
              : "") +
            ".",
          location: { file: first.file, line: 1, column: 1 },
          identity: [RULE_ID, signature].join("\u0000"),
          judged: false,
        }),
      )
    }

    return outcome(findings, [
      repeated.length +
        " shape(s) repeated across files" +
        (repeated.length > findings.length
          ? ", " + (repeated.length - findings.length) + " outside the scope of this run"
          : ""),
    ])
  }),
})
