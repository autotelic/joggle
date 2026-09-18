import type { Diagnostic, Drop, Note, Severity } from "./schema.ts"

/**
 * The funnel, worded for the report.
 *
 * One line per rule that dropped anything, with the counts by stage and one
 * example. The example matters more than the count: "gated 12" says a threshold
 * may be wrong, while naming one candidate and the reason it failed says whether
 * the threshold is wrong about the right thing.
 */
export const funnelNotes = (drops: ReadonlyArray<Drop>): ReadonlyArray<Note> => {
  const byRule = new Map<string, Map<string, number>>()
  for (const drop of drops) {
    const stages = byRule.get(drop.ruleId) ?? new Map<string, number>()
    stages.set(drop.stage, (stages.get(drop.stage) ?? 0) + 1)
    byRule.set(drop.ruleId, stages)
  }
  const notes: Array<Note> = []
  for (const [ruleId, stages] of byRule) {
    const parts = [...stages.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([stage, count]) => stage + " " + count)
    const example = drops.find((drop) => drop.ruleId === ruleId)
    notes.push({
      ruleId,
      reason:
        "dropped " +
        parts.join(", ") +
        (example === undefined ? "" : "; e.g. " + example.subject + ": " + example.reason),
    })
  }
  return notes
}

/**
 * Output formats, modelled on oxlint's, because oxlint already decided what a
 * linter's output should look like and its decisions are worth copying:
 *
 *   text     one line per problem. Greppable, editor-clickable, tiny in CI.
 *            This is the default precisely because it is not pretty.
 *   stylish  ESLint-compatible: grouped by file, aligned, coloured.
 *   unix     `path:line:col: message [Severity/rule]`, then a count.
 *   json     everything, for another tool.
 *   github   Actions workflow commands.
 *
 * A hand-rolled code frame was removed in favour of the compact form: on a
 * 1,870-file codebase the frames made the report 8,083 lines where oxlint would
 * print 340. A linter's output is read on a terminal and scrolled in CI, and
 * those two want different things.
 */
export type Format = "text" | "stylish" | "unix" | "json" | "github"

/** A skip or a bound: a rule id and a reason. Defined in schema so a stored run
 *  can be decoded with it. */
export type Skipped = Note

export interface Report {
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly files: number
  readonly rules: number
  readonly skipped: ReadonlyArray<Skipped>
  /**
   * Bounds the rules hit, in their own words. A note is not a failure: it is
   * something the rule chose not to look at, and it belongs next to the findings
   * so that a reader can tell "nothing there" from "we stopped looking".
   */
  readonly notes: ReadonlyArray<Skipped>
  /**
   * Candidates the rules considered and did not report, with the reason.
   *
   * This is the funnel that produced the findings. Without it, a rule that found
   * nothing and a rule that looked at nothing read the same.
   */
  readonly drops: ReadonlyArray<Drop>
  /**
   * Where the wall clock went. A run that takes a minute is fine; a run that
   * takes a minute for a reason nobody can see is not.
   */
  readonly timings: ReadonlyArray<{ readonly phase: string; readonly ms: number }>
  readonly judge: {
    readonly requests: number
    readonly replayed: number
    /** Wire calls. Fewer than requests means batching worked. */
    readonly calls: number
    readonly unavailable: number
    readonly inputTokens: number
    readonly outputTokens: number
  }
  readonly elapsedMs: number
  /** True when this run replayed a stored report because nothing changed. */
  readonly replayed: boolean
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

/**
 * The report is a ranked list, not a file listing. A Noul per candidate gives
 * every finding a comparable score -- see the re-ranking cookbook -- so the
 * most likely real duplication is read first. File order is the tiebreak, which
 * keeps runs deterministic.
 */
export const rankDiagnostics = (
  diagnostics: ReadonlyArray<Diagnostic>,
): ReadonlyArray<Diagnostic> =>
  [...diagnostics].sort(
    (a, b) =>
      (b.score ?? -1) - (a.score ?? -1) ||
      a.location.file.localeCompare(b.location.file) ||
      a.location.line - b.location.line,
  )

interface Palette {
  readonly bold: (text: string) => string
  readonly dim: (text: string) => string
  readonly red: (text: string) => string
  readonly yellow: (text: string) => string
  readonly underline: (text: string) => string
}

const plain: Palette = {
  bold: (t) => t,
  dim: (t) => t,
  red: (t) => t,
  yellow: (t) => t,
  underline: (t) => t,
}

const ansi = (on: boolean): Palette =>
  on
    ? {
        bold: (t) => `\u001b[1m${t}\u001b[0m`,
        dim: (t) => `\u001b[2m${t}\u001b[0m`,
        red: (t) => `\u001b[31m${t}\u001b[0m`,
        yellow: (t) => `\u001b[33m${t}\u001b[0m`,
        underline: (t) => `\u001b[4m${t}\u001b[0m`,
      }
    : plain

/** oxlint and ESLint say "warning"; the internal severity stays short. */
const label = (severity: Severity): string => (severity === "warn" ? "warning" : severity)

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`

const counts = (report: Report) => ({
  errors: report.diagnostics.filter((d) => d.severity === "error").length,
  warnings: report.diagnostics.filter((d) => d.severity === "warn").length,
  judged: report.diagnostics.filter((d) => d.judged).length,
})

const problemSummary = (report: Report): string => {
  const { errors, warnings } = counts(report)
  const total = report.diagnostics.length
  if (total === 0) return "0 problems"
  const parts: Array<string> = []
  if (errors > 0) parts.push(plural(errors, "error"))
  if (warnings > 0) parts.push(plural(warnings, "warning"))
  return `${plural(total, "problem")} (${parts.join(", ")})`
}

/** joggle-specific tail: how much of this was actually decided, and by what. */
const provenance = (report: Report): string => {
  if (report.replayed) {
    return `Replayed the previous run: nothing it depends on changed across ${plural(report.files, "file")}. No analysis, no judgements, no tokens.`
  }
  const { judged } = counts(report)
  if (report.diagnostics.length === 0 && report.judge.requests === 0) return ""
  const { requests, calls, replayed, unavailable, inputTokens } = report.judge
  const u = unavailable > 0 ? `, ${unavailable} unavailable` : ""
  const phases = report.timings
    .filter((timing) => timing.ms >= 50)
    .sort((a, b) => b.ms - a.ms)
    .map((timing) => `${timing.phase} ${Math.round(timing.ms / 100) / 10}s`)
    .join(", ")
  const where = phases === "" ? "" : ` (${phases})`
  const tokens = `${inputTokens.toLocaleString("en-US")} input tokens`
  return `Finished in ${Math.round(report.elapsedMs / 100) / 10}s on ${plural(report.files, "file")} using ${plural(report.rules, "rule")}${where}. ${judged} of ${report.diagnostics.length} findings verified by a judgement; ${requests} judgements in ${calls} API calls, ${replayed} replayed${u}, ${tokens}.`
}

const notes = (report: Report): ReadonlyArray<string> => [
  ...report.skipped.map((skip) => `note: ${skip.ruleId} skipped — ${skip.reason}`),
  ...report.notes.map((note) => `note: ${note.ruleId} — ${note.reason}`),
]

/* -------------------------------------------------------------------------- */
/* text                                                                       */
/* -------------------------------------------------------------------------- */

const text = (report: Report): string => {
  const lines = report.diagnostics.map((d) => {
    const { file, line, column } = d.location
    const help = d.help === undefined ? "" : ` help: ${d.help}`
    const score = d.score === undefined ? "" : ` (${d.score.toFixed(2)})`
    return `${file}:${line}:${column}: ${label(d.severity)} ${d.ruleId}${score}: ${d.message}${help}`
  })
  if (lines.length > 0) lines.push("")
  lines.push(problemSummary(report))
  const provenanceLine = provenance(report)
  if (provenanceLine !== "") lines.push(provenanceLine)
  lines.push(...notes(report))
  return lines.join("\n")
}

/* -------------------------------------------------------------------------- */
/* stylish                                                                    */
/* -------------------------------------------------------------------------- */

const stylish = (report: Report, c: Palette): string => {
  const lines: Array<string> = []
  const byFile = new Map<string, Array<Diagnostic>>()
  for (const diagnostic of report.diagnostics) {
    const existing = byFile.get(diagnostic.location.file)
    if (existing === undefined) byFile.set(diagnostic.location.file, [diagnostic])
    else existing.push(diagnostic)
  }

  for (const [file, diagnostics] of byFile) {
    lines.push("")
    lines.push(c.underline(file))
    const where = diagnostics.map((d) => `${d.location.line}:${d.location.column}`)
    const severity = diagnostics.map((d) => label(d.severity))
    const whereWidth = Math.max(...where.map((w) => w.length))
    const severityWidth = Math.max(...severity.map((s) => s.length))
    diagnostics.forEach((diagnostic, index) => {
      // Pad before colouring: ANSI escapes count as characters to padEnd.
      const padded = (severity[index] ?? "").padEnd(severityWidth)
      const level = diagnostic.severity === "error" ? c.red(padded) : c.yellow(padded)
      const verified = diagnostic.judged ? "" : c.dim(" (unverified)")
      const score = diagnostic.score === undefined ? "" : diagnostic.score.toFixed(2)
      lines.push(
        `  ${c.dim((where[index] ?? "").padEnd(whereWidth))}  ${level}  ${c.dim(score.padEnd(4))}  ${diagnostic.message}${verified}  ${c.dim(diagnostic.ruleId)}`,
      )
    })
  }

  const { errors } = counts(report)
  const summary = problemSummary(report)
  if (lines.length > 0) lines.push("")
  lines.push(errors > 0 ? c.red(`✖ ${summary}`) : c.yellow(`✖ ${summary}`))
  const provenanceLine = provenance(report)
  if (provenanceLine !== "") lines.push(c.dim(provenanceLine))
  lines.push(...notes(report).map((n) => c.dim(n)))
  return lines.join("\n")
}

/* -------------------------------------------------------------------------- */
/* unix                                                                       */
/* -------------------------------------------------------------------------- */

const unix = (report: Report): string => {
  const lines = report.diagnostics.map((d) => {
    const { file, line, column } = d.location
    const severity = d.severity === "error" ? "Error" : "Warning"
    return `${file}:${line}:${column}: ${d.message} [${severity}/${d.ruleId}]`
  })
  lines.push("")
  lines.push(problemSummary(report).replace(/ \(.*\)$/, ""))
  return lines.join("\n")
}

/* -------------------------------------------------------------------------- */
/* machine formats                                                            */
/* -------------------------------------------------------------------------- */

const json = (report: Report): string =>
  JSON.stringify(
    {
      diagnostics: report.diagnostics,
      summary: {
        files: report.files,
        rules: report.rules,
        problems: report.diagnostics.length,
        ...counts(report),
        skipped: report.skipped,
        notes: report.notes,
        judge: report.judge,
        replayed: report.replayed,
        timings: report.timings,
        elapsedMs: report.elapsedMs,
        // The funnel, in the machine-readable format too. It was in the report and
        // not in the JSON, which made the one artifact a script can read the one
        // artifact that hid where the candidates went -- and reading it is how the
        // gated band below was found.
        drops: report.drops,
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
    case "unix":
      return unix(report)
    case "stylish":
      return stylish(report, ansi(options?.color === true))
    case "text":
      return text(report)
  }
}

export const exitCodeFor = (report: Report, maxWarnings: number): number => {
  const { errors, warnings } = counts(report)
  if (errors > 0) return 1
  if (maxWarnings >= 0 && warnings > maxWarnings) return 1
  return 0
}
