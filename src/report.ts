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
  /** Source text by root-relative path, for drawing code frames. */
  readonly sources: ReadonlyMap<string, string>
}

const rank: Record<Severity, number> = { error: 0, warn: 1, info: 2 }

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

/* -------------------------------------------------------------------------- */
/* Text                                                                       */
/* -------------------------------------------------------------------------- */

interface Palette {
  readonly bold: (text: string) => string
  readonly dim: (text: string) => string
  readonly red: (text: string) => string
  readonly yellow: (text: string) => string
  readonly cyan: (text: string) => string
}

const plain: Palette = {
  bold: (t) => t,
  dim: (t) => t,
  red: (t) => t,
  yellow: (t) => t,
  cyan: (t) => t,
}

const ansi = (on: boolean): Palette =>
  on
    ? {
        bold: (t) => `\u001b[1m${t}\u001b[0m`,
        dim: (t) => `\u001b[2m${t}\u001b[0m`,
        red: (t) => `\u001b[31m${t}\u001b[0m`,
        yellow: (t) => `\u001b[33m${t}\u001b[0m`,
        cyan: (t) => `\u001b[36m${t}\u001b[0m`,
      }
    : plain

const CONTEXT = 1

/**
 * A code frame, the way a compiler prints one. A diagnostic that points at a
 * line without showing it makes a reader open the file; this does not.
 */
const frame = (
  diagnostic: Diagnostic,
  source: string,
  gutter: number,
  c: Palette,
): ReadonlyArray<string> => {
  const lines = source.split("\n")
  const start = diagnostic.location.line
  const end = diagnostic.location.endLine ?? start
  const from = Math.max(1, start - CONTEXT)
  const to = Math.min(lines.length, end + CONTEXT)
  const out: Array<string> = []
  for (let n = from; n <= to; n += 1) {
    const text = lines[n - 1] ?? ""
    const num = String(n).padStart(gutter)
    if (n < start || n > end) {
      out.push(`${c.dim(`${num} │`)} ${c.dim(text)}`)
      continue
    }
    out.push(`${c.dim(`${num} │`)} ${text}`)
    const underline = (fromColumn: number, toColumn: number): void => {
      const width = Math.max(1, toColumn - fromColumn)
      const mark =
        diagnostic.severity === "error" ? c.red("─".repeat(width)) : c.yellow("─".repeat(width))
      out.push(`${c.dim(`${" ".repeat(gutter)} ·`)} ${" ".repeat(fromColumn - 1)}${mark}`)
    }
    // A wrapped span underlines its first and last line only, the way a compiler
    // frames it. Underlining every line in between is noise, not information.
    if (n === start) {
      const to = start === end ? (diagnostic.location.endColumn ?? text.length + 1) : text.length + 1
      underline(Math.max(1, diagnostic.location.column), to)
    } else if (n === end) {
      underline(1, diagnostic.location.endColumn ?? text.length + 1)
    }
  }
  return out
}

const text = (report: Report, c: Palette): string => {
  const lines: Array<string> = []
  const gutter = String(
    report.diagnostics.reduce((max, d) => Math.max(max, d.location.line), 0),
  ).length

  for (const diagnostic of report.diagnostics) {
    const marker = diagnostic.severity === "error" ? c.red("×") : c.yellow("⚠")
    const rule = diagnostic.judged ? diagnostic.ruleId : `${diagnostic.ruleId} (unverified)`
    lines.push(`${marker} ${c.bold(rule)}: ${diagnostic.message}`)
    lines.push(`${c.dim(`   ╦─[${diagnostic.location.file}:${diagnostic.location.line}:${diagnostic.location.column}]`)}`)
    const source = report.sources.get(diagnostic.location.file)
    if (source !== undefined) lines.push(...frame(diagnostic, source, gutter, c))
    if (diagnostic.help !== undefined) {
      const confidence =
        diagnostic.confidence === undefined ? "" : ` (${diagnostic.confidence.toFixed(2)})`
      lines.push(`${c.cyan(`   help: ${diagnostic.help}`)}${c.dim(confidence)}`)
    }
    lines.push("")
  }

  const errors = report.diagnostics.filter((d) => d.severity === "error").length
  const warnings = report.diagnostics.filter((d) => d.severity === "warn").length
  const judged = report.diagnostics.filter((d) => d.judged).length

  if (lines.length > 0) lines.push("")
  if (report.diagnostics.length === 0) {
    lines.push(`No problems found in ${report.files} files (${report.elapsedMs}ms).`)
  } else {
    const parts: Array<string> = []
    if (errors > 0) parts.push(c.red(`${errors} error${errors === 1 ? "" : "s"}`))
    parts.push(c.yellow(`${warnings} warning${warnings === 1 ? "" : "s"}`))
    lines.push(`Found ${parts.join(", ")} in ${report.files} files (${report.elapsedMs}ms).`)

    const byRule = new Map<string, number>()
    for (const d of report.diagnostics) byRule.set(d.ruleId, (byRule.get(d.ruleId) ?? 0) + 1)
    for (const [ruleId, count] of [...byRule].sort((a, b) => b[1] - a[1])) {
      lines.push(c.dim(`  ${String(count).padStart(4)}  ${ruleId}`))
    }

    const { requests, calls, replayed, unavailable } = report.judge
    const tail = unavailable > 0 ? `, ${unavailable} unavailable` : ""
    lines.push(
      c.dim(
        `  ${judged} of ${report.diagnostics.length} findings were verified by a judgement; ${requests} judgements, ${calls} API calls, ${replayed} replayed${tail}.`,
      ),
    )
  }
  for (const skip of report.skipped) {
    lines.push(c.dim(`  note: ${skip.ruleId} skipped — ${skip.reason}`))
  }
  return lines.join("\n")
}

/* -------------------------------------------------------------------------- */
/* Machine formats                                                            */
/* -------------------------------------------------------------------------- */

const json = (report: Report): string =>
  JSON.stringify(
    {
      diagnostics: report.diagnostics,
      summary: {
        files: report.files,
        rules: report.rules,
        problems: report.diagnostics.length,
        errors: report.diagnostics.filter((d) => d.severity === "error").length,
        warnings: report.diagnostics.filter((d) => d.severity === "warn").length,
        judged: report.diagnostics.filter((d) => d.judged).length,
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
    const level =
      diagnostic.severity === "error" ? "error" : diagnostic.severity === "warn" ? "warning" : "notice"
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

export const render = (
  report: Report,
  format: Format,
  options?: { readonly color?: boolean | undefined },
): string => {
  switch (format) {
    case "json":
      return json(report)
    case "github":
      return github(report)
    case "text":
      return text(report, ansi(options?.color === true))
  }
}

export const exitCodeFor = (report: Report, maxWarnings: number): number => {
  const errors = report.diagnostics.filter((d) => d.severity === "error").length
  const warnings = report.diagnostics.filter((d) => d.severity === "warn").length
  if (errors > 0) return 1
  if (maxWarnings >= 0 && warnings > maxWarnings) return 1
  return 0
}
