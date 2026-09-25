import { Effect } from "effect"
import { Decision } from "effect/unstable/ai"
import { Atoms } from "../atoms.ts"
import { policy } from "../policy.ts"
import { verdictsOf, type Plan } from "../plans.ts"
import { locator, messages, reporter, type Report } from "../reporting.ts"
import { verdictOf } from "../verdict.ts"
import {
  outcome,
  qualityOf,
  type DecisionAnswers,
  type PlannedRule,
  type Scope,
} from "../rule.ts"
import type { Diagnostic, Drop } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/compose-types"

/** Which labels mean this rule is violated -- the read and the calibration share it. */
const VIOLATIONS = { verdict: ["composes", "same_name_drift"] } as const

// A type that lists every field of another type.
//
// The COMPOSE case is advice and is recorded rather than printed; the name-drift
// case -- one name declared twice with different fields -- is a defect and is the
// finding. See the read.
//
// "Composed of smaller canonical things" is a principle until it becomes a set
// comparison, and a set comparison is free. `B.fields` containing `A.fields` as a
// proper subset means B is A plus something. Whether B is GENUINELY an A -- or two
// declarations that happen to share field names, or the same name declared twice
// with different fields -- is the judgement, and it used to be left to the reader.
const isTypeUnit = (unit: Unit): boolean =>
  (unit.kind === "interface" || unit.kind === "type") &&
  unit.fields.length >= policy.composeTypes.minFields

/** A field set as a comparable key, order-insensitive. */
const signatureOf = (unit: Unit): string => [...unit.fields].sort().join("\u0000")

/**
 * Whether two declarations of one field can compose.
 *
 * Equality is too strict: this rule missed a genuine finding because two of four
 * shared fields are written differently -- `signal` as `AbortSignal | undefined`
 * on one side and `AbortSignal` on the other, `retry` as `RetryPolicy` against
 * `Partial<RetryPolicy>`. Composition resolves both. What it does not resolve is
 * `string` against `number`, which intersects to never. So the test is whether one
 * declaration mentions everything the other does.
 */
export const canCompose = (part: string | undefined, whole: string | undefined): boolean => {
  if (part === undefined || whole === undefined) return false
  if (part === whole) return true
  const words = (text: string): ReadonlyArray<string> =>
    text.replace(/[^A-Za-z0-9_$]+/g, " ").trim().split(" ").filter((word) => word !== "")
  const a = words(part)
  const b = words(whole)
  return a.every((word) => b.includes(word)) || b.every((word) => a.includes(word))
}

export const composeTypes: PlannedRule = {
  id: RULE_ID,
  severity: "warn",
  description: "A type that repeats every field of another type instead of composing it.",
  judged: true,
  onUnavailable: "report",
  messages: messages({
    same_name_drift:
      "{{name}} is declared in two places and they differ by {{count}} field(s): {{fields}}.",
    same_name_drift_help:
      "{{name}} is declared at {{wholeAt}} and at {{partAt}} with different fields, so any code that moves between the two is relying on which one it imported.{{unverified}}",
    composes_shared_fields:
      "{{name}} lists all {{partFields}} field(s) of {{part}} and adds {{count}}.",
    composes_shared_fields_help:
      "Declare it as {{name}} = {{part}} & { {{fields}} } so the shared part stays canonical and cannot drift from {{part}} ({{partAt}}).{{unverified}}",
  }),
  plan: Effect.fn("joggle/compose-types")(function* (workspace: Workspace, scope: Scope) {
    const report = reporter(composeTypes, locator(workspace))
    const all = workspace.units.filter(isTypeUnit)
    if (all.length === 0) {
      return {
        plans: [],
        read: () =>
          outcome([], [
            "no type declaration has " +
              policy.composeTypes.minFields +
              " or more fields, so nothing had a field set to compare",
          ]),
      }
    }

    const bounded = all.slice(0, policy.composeTypes.maxTypes)
    // One representative per distinct field set. A field set repeated twenty
    // times is one candidate for composition, not twenty comparisons.
    const parts = new Map<string, Unit>()
    for (const unit of bounded) {
      const signature = signatureOf(unit)
      if (!parts.has(signature)) parts.set(signature, unit)
    }

    const candidates: Array<{ whole: Unit; part: Unit; added: ReadonlyArray<string> }> = []
    for (const whole of bounded) {
      if (scope.changed !== undefined && !scope.changed.has(whole.file)) continue
      const wholeFields = new Set(whole.fields)
      let best: Unit | undefined
      for (const [signature, part] of parts) {
        if (part.fields.length >= whole.fields.length) continue
        if (best !== undefined && part.fields.length <= best.fields.length) continue
        if (whole.fields.length - part.fields.length > part.fields.length) continue
        const contained = signature
          .split("\u0000")
          .every(
            (field) =>
              wholeFields.has(field) &&
              canCompose(part.fieldTypes.get(field), whole.fieldTypes.get(field)),
          )
        if (contained) best = part
      }
      if (best === undefined) continue
      const added = whole.fields.filter((field) => !best.fields.includes(field))
      candidates.push({ whole, part: best, added })
    }

    if (candidates.length === 0) {
      return {
        plans: [],
        read: () =>
          outcome([], [
            all.length +
              " type declaration(s) in " +
              parts.size +
              " distinct field set(s); none contains another as a proper subset",
          ]),
      }
    }

    const atoms = yield* Atoms
    const planned = yield* Effect.forEach(candidates, (candidate) =>
      Effect.gen(function* () {
        const { whole, part, added } = candidate
        const sameName = whole.name === part.name
        // The state is the pair and the fields they share, with the declared type
        // of each shared field, so the question can weigh "is B genuinely an A".
        const shared = part.fields.map((field) => ({
          field,
          partType: part.fieldTypes.get(field) ?? null,
          wholeType: whole.fieldTypes.get(field) ?? null,
        }))
        const id = yield* atoms.add({
          whole: { name: whole.name, file: whole.file, line: whole.location.line },
          part: { name: part.name, file: part.file, line: part.location.line },
          sameName,
          shared,
          added,
        })
        const plan: Plan<DecisionAnswers> = {
          ruleId: RULE_ID,
          subject: whole.name + " (lists " + part.name + ")",
          concerns: [whole.file, part.file],
          atoms: [id],
          violations: VIOLATIONS,
          decisions: {
            verdict: Decision.classify({
              instructions: [
                `\`atoms[${id}].whole\` (${whole.name}) lists all ${part.fields.length} field(s) of \`atoms[${id}].part\` (${part.name}) and adds ${added.length}: ${added.join(", ")}.`,
                sameName
                  ? "The two declarations share a NAME."
                  : "The two declarations have different names.",
                `\`atoms[${id}].shared\` is each shared field with its type on both sides.`,
                "How do these two declarations relate?",
                "Answer `composes` when the whole is genuinely the part plus more, so it should be written as the part intersected with the added fields.",
                "When `atoms[${id}].sameName` is true the two declarations share a NAME, so answer `same_name_drift`: composing a type with itself is nonsense, however the fields line up.",
                "When one side is a raw or wire mirror -- a `*Row`, an `Unparsed*`, a `*Json` -- the two are different artefacts rather than one composition, so answer `independent`.",
                `\`atoms[${id}].whole.file\` and \`atoms[${id}].part.file\` are the two files. When one name appears in two deployables that cannot import each other, such as a server under services/rest and a client under services/ui, each side must define its own shape: answer \`independent\`, however the fields line up.`,
                "Answer `same_name_drift` when the two share a name inside one deployable and one has drifted from the other, so one should be renamed or the two unified.",
                "Answer `independent` when the shared fields are a coincidence and the two types are unrelated.",
                "Answer `already_composed` when the whole already states its composition, so there is nothing to change.",
              ].join("\n"),
              criteria: {
                composes: "The whole is the part plus more. Write it as part & { the added fields }.",
                same_name_drift: "One name, two different shapes. Rename one, or unify them.",
                independent: "Coincidental overlap, or two different artefacts (a domain type and its raw or wire mirror). The two are unrelated.",
                already_composed: "The composition is already written.",
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
        const drops: Array<Drop> = []
        planned.forEach((value, index) => {
          const { whole, part } = value.candidate
          const subject = whole.name + " (lists " + part.name + ")"
          const answer = verdicts[index]
          const verdict = verdictOf(answer?.["verdict"], VIOLATIONS.verdict)
          if (verdict === undefined) {
            diagnostics.push(findingFor(report, value.candidate, undefined, "no judgement was available", undefined, false))
            return
          }
          // The compose case is ADVICE, recorded rather than printed. On a real
          // repository it was 140 of 187 findings -- "B could compose A", every
          // one true and none urgent -- and the containment the candidate was
          // built from is the same evidence the question is given, so the model
          // agrees with it almost every time. A name declared twice is the defect
          // and stays a finding.
          if (verdict.label === "composes") {
            drops.push({
              ruleId: RULE_ID,
              subject,
              stage: "gated",
              reason: "compose advice is recorded, not printed",
            })
            return
          }
          if (verdict.label !== "same_name_drift") {
            drops.push({
              ruleId: RULE_ID,
              subject,
              stage: "declined",
              reason:
                verdict.label === "already_composed"
                  ? "the composition is already stated"
                  : "the shared fields are a coincidence",
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
          const review = quality.quality === "review"
          diagnostics.push(findingFor(report, value.candidate, verdict.confidence, undefined, "same_name_drift", review))
        })
        return outcome(diagnostics, [], drops)
      },
    }
  }),
}

const findingFor = (
  report: Report,
  candidate: { readonly whole: Unit; readonly part: Unit; readonly added: ReadonlyArray<string> },
  confidence: number | undefined,
  unverifiedReason: string | undefined,
  label: string | undefined,
  review: boolean,
): Diagnostic => {
  const { whole, part, added } = candidate
  const drifted = label === "same_name_drift" || (label === undefined && whole.name === part.name)
  return report({
    at: whole,
    messageId: drifted ? "same_name_drift" : "composes_shared_fields",
    data: {
      name: whole.name,
      part: part.name,
      count: added.length,
      fields: added.join(drifted ? ", " : "; "),
      partFields: part.fields.length,
      wholeAt: whole.file + ":" + whole.location.line,
      partAt: part.file + ":" + part.location.line,
      unverified: unverifiedReason === undefined ? "" : " Not verified: " + unverifiedReason + ".",
    },
    helpId: drifted ? "same_name_drift_help" : "composes_shared_fields_help",
    identity: [RULE_ID, whole.file, whole.name, part.name, drifted ? "drift" : "compose"].join("\u0000"),
    judged: unverifiedReason === undefined,
    confidence,
    severity: review || !drifted ? "info" : "warn",
  })
}
