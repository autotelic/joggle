import { Effect } from "effect"
import { policy } from "../policy.ts"
import { defineRule, finding, outcome, type Scope } from "../rule.ts"
import type { Diagnostic } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/compose-types"

/**
 * A type that lists every field of another type.
 *
 * "Composed of smaller canonical things" is a principle until it becomes a set
 * comparison, and a set comparison is free. `B.fields` containing `A.fields` as a
 * proper subset means B is A plus something, and writing it as `A & { ... }` is
 * how the smaller thing stays canonical: change A and B follows, instead of the
 * two drifting until they disagree.
 *
 * Deterministic, so it needs no model and no key. The judgement a person makes --
 * is B genuinely an A? -- is not asked here; the finding states the containment
 * and the reader decides. What the model is NOT needed for is noticing, and
 * noticing is the part nobody does by eye.
 *
 * A union or an intersection has no single field set and produces no candidate.
 * `A & B` already states its composition, which is the shape this is looking for.
 */
const isTypeUnit = (unit: Unit): boolean =>
  (unit.kind === "interface" || unit.kind === "type") &&
  unit.fields.length >= policy.composeTypes.minFields

/** A field set as a comparable key, order-insensitive. */
const signatureOf = (unit: Unit): string => [...unit.fields].sort().join("\u0000")

interface Pair {
  readonly whole: Unit
  readonly part: Unit
}

export const composeTypes = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "A type that repeats every field of another type instead of composing it.",
  judged: false,
  run: Effect.fn("joggle/compose-types")(function* (workspace: Workspace, scope: Scope) {
    const all = workspace.units.filter(isTypeUnit)
    if (all.length === 0) return outcome([])

    const bounded = all.slice(0, policy.composeTypes.maxTypes)
    // One representative per distinct field set. A field set repeated twenty
    // times is one candidate for composition, not twenty comparisons -- and this
    // is what keeps the work linear in DISTINCT shapes rather than in types.
    const parts = new Map<string, Unit>()
    for (const unit of bounded) {
      const signature = signatureOf(unit)
      if (!parts.has(signature)) parts.set(signature, unit)
    }

    const findings: Array<Diagnostic> = []
    for (const whole of bounded) {
      if (scope.changed !== undefined && !scope.changed.has(whole.file)) continue
      const wholeFields = new Set(whole.fields)
      let best: Unit | undefined
      for (const [signature, part] of parts) {
        // A proper subset, so an equal field set is a duplicate rather than a
        // composition -- that is `duplicate-implementation`'s finding, not this one.
        if (part.fields.length >= whole.fields.length) continue
        if (best !== undefined && part.fields.length <= best.fields.length) continue
        // The shared part has to be a meaningful fraction of the whole. Without
        // this, a six-field base under a thirty-one-field type is reported as
        // composition, and "B = A & { twenty-five more }" is a worse description
        // of B than B's own declaration is.
        if (whole.fields.length - part.fields.length > part.fields.length) continue
        const contained = signature
          .split("\u0000")
          .every((field) => wholeFields.has(field))
        if (contained) best = part
      }
      if (best === undefined) continue
      const added = whole.fields.filter((field) => !best.fields.includes(field))
      // The same name in two places is a different problem from two names where
      // one contains the other, and it is the more serious of the two: the two
      // declarations have already drifted, and the first version of this message
      // called it `X = X & { ... }`, which is nonsense on its face.
      const drifted = whole.name === best.name
      findings.push(
        finding({
          ruleId: RULE_ID,
          // Two different things in one rule, and they are not equally urgent. A
          // name declared twice with different fields is a defect: code that
          // moves between the declarations depends on which one it imported. A
          // type that could compose another is advice, and 177 pieces of advice
          // at warning level is how a report becomes a wall. The severity follows
          // the finding, decided here rather than by whoever reads it.
          severity: drifted ? "warn" : "info",
          message: drifted
            ? whole.name +
              " is declared in two places and they differ by " +
              added.length +
              " field(s): " +
              added.join(", ") +
              "."
            : whole.name +
              " lists all " +
              best.fields.length +
              " field(s) of " +
              best.name +
              " and adds " +
              added.length +
              ".",
          help: drifted
            ? whole.name +
              " is declared at " +
              whole.file +
              ":" +
              whole.location.line +
              " and at " +
              best.file +
              ":" +
              best.location.line +
              " with different fields, so any code that moves between the two is relying on which one it imported."
            : "Declare it as " +
              whole.name +
              " = " +
              best.name +
              " & { " +
              added.join("; ") +
              " } so the shared part stays canonical and cannot drift from " +
              best.name +
              " (" +
              best.file +
              ":" +
              best.location.line +
              ").",
          location: whole.location,
          identity: [RULE_ID, whole.file, whole.name, best.name, drifted ? "drift" : "compose"].join(
            "\u0000",
          ),
          judged: false,
        }),
      )
    }

    return outcome(
      findings,
      [
        all.length +
          " type declaration(s) in " +
          parts.size +
          " distinct field set(s)",
        ...(all.length > bounded.length
          ? [
              all.length -
                bounded.length +
                " type(s) were past the limit of " +
                policy.composeTypes.maxTypes +
                " and were not compared",
            ]
          : []),
      ],
    )
  }),
})
