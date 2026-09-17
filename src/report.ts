import type { Diagnostic, Severity } from "./schema.ts"

export type Format = "text" | "json" | "github"

export interface Skipped {
  readonly ruleId: string
  readonly reason: string
}

export interface Report {
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly files: number
  readonly rules: number
  readonly skipped: ReadonlyArray<Skipped>
  readonly judge: {
    readonly requests: number
    readonly replayed: number
    readonly calls: number
    readonly unavailable: number
  }
  readonly elapsedMs: number
}

const rank: Record<Severity, number> = { error: 0, warn: 1, info: 2 }

/** Deterministic ordering, so two runs on the same tree produce the same diff. */
export const sortDiagnostics = (
  diagnostics: ReadonlyArray<Diagnostic>,
): ReadonlyArray<Diagnostic> =>
  [...diagnostics].sort(
    (a, b) =>
      a.location.file.localeCompare(b.location.file) ||
      a.location.line - b.location.line ||
      a.location.column - b.location.column ||
      rank[a.severity] - rank[b.severity] ||
      a.ruleId.localeCompare(b.ruleId),
  )

const icon = (severity: Severity): string =>
  severity === "error" ? "error" : severity === "warn" ? "warn " : "info "

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`

const text = (report: Report): string => {
  const lines: Array<string> = []
  for (const diagnostic of report.diagnostics) {
    const { file, line, column } = diagnostic.location
    lines.push(`${file}:${line}:${column}  ${icon(diagnostic.severity)}  ${diagnostic.ruleId}  ${diagnostic.message}`)
    if (diagnostic.help !== undefined) lines.push(`  help: ${diagnostic.help}`)
    if (diagnostic.confidence !== undefined) {
      lines.push(`  confidence: ${diagnostic.confidence.toFixed(2)}`)
    }
  }

  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length
  const warnings = report.diagnostics.filter((diagnostic) => diagnostic.severity === "warn").length
  const judged = report.diagnostics.filter((diagnostic) => diagnostic.judged).length
  const total = report.diagnostics.length

  if (lines.length > 0) lines.push("")
  lines.push(
    total === 0
      ? `No problems found in ${plural(report.files, "file")} (${report.elapsedMs}ms).`
      : `${plural(total, "problem")} (${errors} errors, ${warnings} warnings) in ${plural(report.files, "file")} (${report.elapsedMs}ms).`,
  )
  if (report.judge.requests > 0 || report.skipped.length > 0) {
    const judge = report.judge
    const unavailable = judge.unavailable > 0 ? `, ${judge.unavailable} unavailable` : ""
    lines.push(
      `  ${judged} judged findings; ${judge.requests} judgements, ${judge.calls} API calls, ${judge.replayed} replayed${unavailable}.`,
    )
  }
  for (const skip of report.skipped) {
    lines.push(`  note: ${skip.ruleId} skipped — ${skip.reason}`)
  }
  return lines.join("\n")
}

const json = (report: Report): string =>
  JSON.stringify(
    {
      diagnostics: report.diagnostics,
      summary: {
        files: report.files,
        rules: report.rules,
        problems: report.diagnostics.length,
        errors: report.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
        warnings: report.diagnostics.filter((diagnostic) => diagnostic.severity === "warn").length,
        judged: report.diagnostics.filter((diagnostic) => diagnostic.judged).length,
        skipped: report.skipped,
        judge: report.judge,
        elapsedMs: report.elapsedMs,
      },
    },
    null,
    2,
  )

/** GitHub Actions workflow commands, so CI annotations come for free. */
const github = (report: Report): string => {
  const lines: Array<string> = []
  for (const diagnostic of report.diagnostics) {
    const level = diagnostic.severity === "error" ? "error" : diagnostic.severity === "warn" ? "warning" : "notice"
    const { file, line, column } = diagnostic.location
    const body = diagnostic.help === undefined ? diagnostic.message : `${diagnostic.message} ${diagnostic.help}`
    lines.push(
      `::${level} file=${file},line=${line},col=${column},title=${diagnostic.ruleId}::${body.replace(/\r?\n/g, " ")}`,
    )
  }
  for (const skip of report.skipped) {
    lines.push(`::notice title=${skip.ruleId}::rule skipped — ${skip.reason}`)
  }
  return lines.join("\n")
}

export const render = (report: Report, format: Format): string => {
  switch (format) {
    case "json":
      return json(report)
    case "github":
      return github(report)
    case "text":
      return text(report)
  }
}

export const exitCodeFor = (report: Report, maxWarnings: number): number => {
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length
  const warnings = report.diagnostics.filter((diagnostic) => diagnostic.severity === "warn").length
  if (errors > 0) return 1
  if (maxWarnings >= 0 && warnings > maxWarnings) return 1
  return 0
}
