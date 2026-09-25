import { Effect } from "effect"
import { Decision } from "effect/unstable/ai"
import { Atoms } from "../atoms.ts"
import { lineAt, lineStarts } from "../cascade.ts"
import { verdictsOf, type Plan } from "../plans.ts"
import {
  finding,
  marginOfAnswer,
  outcome,
  qualityOf,
  type DecisionAnswers,
  type PlannedRule,
  type Scope,
} from "../rule.ts"
import type { Diagnostic, Drop } from "../schema.ts"
import type { Workspace } from "../workspace.ts"

const RULE_ID = "joggle/nullability-drift"

// One column, two nullabilities.
//
// `field-type-drift` compares two TypeScript declarations. This compares a type
// whose nullability comes from somewhere else: the database. A column the
// migration leaves nullable and a schema that requires it is a decode that fails
// the first time real data arrives.
//
// The mapping is explicit and OPT-IN, because it is not derivable: the row schema
// reads `payroll_crew.shakti_user_id` into a field called `person_id`, an alias in
// the query. A repository annotates the field with
// `.annotate({ sourceColumn: 'table.column' })`.
//
// Both halves -- the migration's `.notNullable()` chain and the schema's
// `Schema.NullOr` -- are specifications read from the source, so the DISAGREEMENT
// is a fact. Whether it is a defect, or a null that is data the adapter handles,
// is the judgement, and it is the one the help text used to hand to the reader.
export const nullabilityDrift: PlannedRule = {
  id: RULE_ID,
  severity: "warn",
  description: "A column nullable in the database and required in a schema, or the reverse.",
  judged: true,
  onUnavailable: "report",
  plan: Effect.fn("joggle/nullability-drift")(function* (workspace: Workspace, scope: Scope) {
    // Every column a migration declares, by `table.column`. Later migrations win:
    // they are timestamp-named, so path order is chronological order.
    const columns = new Map<string, { nullable: boolean; file: string; line: number }>()
    const files = [...workspace.files].sort((left, right) => left.path.localeCompare(right.path))
    for (const file of files) {
      const starts = lineStarts(file.text)
      for (const column of file.facts.columns) {
        columns.set(column.table + "." + column.column, {
          nullable: column.nullable,
          file: file.path,
          line: lineAt(starts, column.start),
        })
      }
    }

    const candidates: Array<{
      source: string
      field: string
      schemaNullable: boolean
      column: { nullable: boolean; file: string; line: number }
      schema: { file: string; line: number }
    }> = []
    let annotated = 0
    for (const file of workspace.files) {
      const starts = lineStarts(file.text)
      for (const object of file.facts.objects) {
        if (!object.declared) continue
        for (const [field, source] of Object.entries(object.sources)) {
          const column = columns.get(source)
          if (column === undefined) continue
          annotated += 1
          if (scope.changed !== undefined && !scope.changed.has(file.path) && !scope.changed.has(column.file)) {
            continue
          }
          const schemaNullable = object.nullable.includes(field)
          if (schemaNullable === column.nullable) continue
          candidates.push({
            source,
            field,
            schemaNullable,
            column,
            schema: { file: file.path, line: lineAt(starts, object.start) },
          })
        }
      }
    }

    if (annotated === 0) {
      return {
        plans: [],
        read: () =>
          outcome([], [
            "no schema field names its source column, so there was nothing to compare -- annotate with .annotate({ sourceColumn: 'table.column' }) to opt in",
          ]),
      }
    }

    if (candidates.length === 0) {
      return {
        plans: [],
        read: () =>
          outcome([], [
            annotated + " schema field(s) named a source column; all agree with the migration on nullability",
          ]),
      }
    }

    const atoms = yield* Atoms
    const planned = yield* Effect.forEach(candidates, (candidate) =>
      Effect.gen(function* () {
        const id = yield* atoms.add({
          source: candidate.source,
          field: candidate.field,
          schemaNullable: candidate.schemaNullable,
          columnNullable: candidate.column.nullable,
          schema: candidate.schema,
          column: { file: candidate.column.file, line: candidate.column.line },
        })
        const plan: Plan<DecisionAnswers> = {
          ruleId: RULE_ID,
          subject: candidate.source + " / " + candidate.field,
          concerns: [candidate.schema.file, candidate.column.file],
          atoms: [id],
          decisions: {
            verdict: Decision.classify({
              instructions: [
                `\`atoms[${id}].source\` is \`${candidate.source}\`. The migration declares it ${candidate.column.nullable ? "nullable" : "required"} (\`atoms[${id}].columnNullable\`), and the schema field \`atoms[${id}].field\` is ${candidate.schemaNullable ? "nullable" : "required"} (\`atoms[${id}].schemaNullable\`).`,
                "Is that disagreement a defect, or is a null here data that the adapter handles?",
                "Answer `drift` when the schema should agree with the migration: the database can hold a null the schema rejects, or the schema accepts a null the database cannot.",
                "Answer `handled` when a null here is data rather than drift and the adapter does something deliberate with it.",
                "Answer `mismapped` when the field does not in fact read that column, so the annotation is wrong.",
              ].join("\n"),
              criteria: {
                drift: "The two should agree. Make the schema (or the migration) match.",
                handled: "A null is data, and the adapter handles it deliberately.",
                mismapped: "The field does not read that column.",
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
          const { candidate } = value
          const subject = candidate.source + " / " + candidate.field
          const answer = verdicts[index]
          const verdict = answer === undefined ? undefined : answer["verdict"]
          if (verdict === undefined || !("label" in verdict)) {
            diagnostics.push(findingFor(candidate, undefined, "no judgement was available"))
            return
          }
          if (verdict.label !== "drift") {
            drops.push({
              ruleId: RULE_ID,
              subject,
              stage: "declined",
              reason:
                verdict.label === "handled"
                  ? "a null here is data the adapter handles"
                  : "the field does not read that column",
            })
            return
          }
          const score = verdict.probabilities[verdict.label] ?? 0
          const quality = qualityOf({
            score,
            margin: marginOfAnswer(verdict),
            confidence: verdict.confidence,
          })
          if (quality.quality !== "act") {
            drops.push({
              ruleId: RULE_ID,
              subject,
              stage: "gated",
              reason: quality.quality === "review" ? "flagged: " + quality.reason : quality.reason,
            })
            return
          }
          diagnostics.push(findingFor(candidate, verdict.confidence, undefined))
        })
        return outcome(diagnostics, [
          annotated +
            " schema field(s) named a source column; " +
            diagnostics.length +
            " of " +
            candidates.length +
            " disagreement(s) reported",
        ], drops)
      },
    }
  }),
}

const findingFor = (
  candidate: {
    readonly source: string
    readonly field: string
    readonly schemaNullable: boolean
    readonly column: { readonly nullable: boolean; readonly file: string; readonly line: number }
    readonly schema: { readonly file: string; readonly line: number }
  },
  confidence: number | undefined,
  unverifiedReason: string | undefined,
): Diagnostic => {
  const input: Parameters<typeof finding>[0] = {
    ruleId: RULE_ID,
    severity: "warn",
    message:
      "`" +
      candidate.source +
      "` is " +
      (candidate.column.nullable ? "nullable" : "required") +
      " in the migration and `" +
      candidate.field +
      "` is " +
      (candidate.schemaNullable ? "nullable" : "required") +
      " in the schema, so the database can hold a value the schema rejects" +
      (candidate.column.nullable ? "" : ", or the schema accepts one the database cannot") +
      ".",
    help:
      "The column is declared at " +
      candidate.column.file +
      ":" +
      String(candidate.column.line) +
      ". Make the schema agree with the migration (or the migration with the schema), or, if a null here is data rather than drift, say what the adapter does with it and pin the decision." +
      (unverifiedReason === undefined ? "" : " Not verified: " + unverifiedReason + "."),
    location: { file: candidate.schema.file, line: candidate.schema.line, column: 1 },
    identity: [RULE_ID, candidate.source, candidate.field].join("\u0000"),
    judged: unverifiedReason === undefined,
  }
  return confidence === undefined ? finding(input) : finding({ ...input, confidence })
}