import { Effect } from "effect"
import { lineAt, lineStarts } from "../cascade.ts"
import { defineRule, finding, outcome, type Scope } from "../rule.ts"
import type { Diagnostic } from "../schema.ts"
import type { Workspace } from "../workspace.ts"

const RULE_ID = "joggle/nullability-drift"

// One column, two nullabilities.
//
// `field-type-drift` compares two TypeScript declarations. This compares a type
// whose nullability comes from somewhere else: the database. A column the
// migration leaves nullable and a schema that requires it is a decode that fails
// the first time real data arrives, and no amount of reading the TypeScript
// finds it, because the schema is confidently wrong and the migration is in
// another language.
//
// The mapping is explicit and OPT-IN, because it is not derivable: the row
// schema reads `payroll_crew.shakti_user_id` into a field called `person_id` --
// an alias in the query, and no name convention turns one into the other. A
// repository annotates the field with `.annotate({ sourceColumn: 'table.column' })`
// and this rule compares the two. Without the annotation there is nothing to
// compare, which is the honest state: the drift is real and invisible.
//
// Deterministic. Both halves are specifications read from the source -- the
// migration by its `table.<type>('col').notNullable()` chain, the schema by
// `Schema.NullOr` -- so there is nothing for a model to decide.

/** A column's nullability where a migration declared it. */
interface Column {
  readonly nullable: boolean
  readonly file: string
  readonly line: number
}

/**
 * Every column a migration declares, by `table.column`.
 *
 * Later migrations win: they are timestamp-named, so path order is chronological
 * order, and an `alterTable` is the newest word on a column.
 */
const columnsIn = (workspace: Workspace): ReadonlyMap<string, Column> => {
  const columns = new Map<string, Column>()
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
  return columns
}

export const nullabilityDrift = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "A column nullable in the database and required in a schema, or the reverse.",
  judged: false,
  run: Effect.fn("joggle/nullability-drift")(function* (workspace: Workspace, scope: Scope) {
    const columns = columnsIn(workspace)
    let annotated = 0
    const findings: Array<Diagnostic> = []

    for (const file of workspace.files) {
      const starts = lineStarts(file.text)
      for (const object of file.facts.objects) {
        // Only a schema declaration carries the annotation, and only a `Nullable`
        // reading is meaningful against a column.
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
          findings.push(
            finding({
              ruleId: RULE_ID,
              severity: "warn",
              message:
                "`" +
                source +
                "` is " +
                (column.nullable ? "nullable" : "required") +
                " in the migration and `" +
                field +
                "` is " +
                (schemaNullable ? "nullable" : "required") +
                " in the schema, so the database can hold a value the schema rejects" +
                (column.nullable ? "" : ", or the schema accepts one the database cannot") +
                ".",
              help:
                "The column is declared at " +
                column.file +
                ":" +
                String(column.line) +
                ". Make the schema agree with the migration (or the migration with the schema), or, if a null here is data rather than drift, say what the adapter does with it and pin the decision.",
              // Anchored at the schema, because that is the side that decodes
              // wrongly and the side a reader changes.
              location: { file: file.path, line: lineAt(starts, object.start), column: 1 },
              identity: [RULE_ID, source, field].join("\u0000"),
              judged: false,
            }),
          )
        }
      }
    }

    if (annotated === 0) {
      return outcome([], [
        "no schema field names its source column, so there was nothing to compare -- annotate with .annotate({ sourceColumn: 'table.column' }) to opt in",
      ])
    }

    return outcome(findings, [
      annotated +
        " schema field(s) named a source column; " +
        findings.length +
        " disagree with the migration on nullability",
    ])
  }),
})
