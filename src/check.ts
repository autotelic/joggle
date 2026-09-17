import { Effect } from "effect"
import { Service as Judge } from "./judge.ts"
import { finding } from "./rule.ts"
import { allRules } from "./rules/index.ts"
import { rankDiagnostics, type Report, type Skipped } from "./report.ts"
import type { Diagnostic, JudgeError } from "./schema.ts"
import { Service as Tsgo } from "./tsgo.ts"
import { loadWorkspace } from "./workspace.ts"

export interface Options {
  readonly cwd: string
  /** Explicit inputs. Empty means "whatever tsgo says the project is". */
  readonly paths: ReadonlyArray<string>
  /** Rule ids to run. Absent means every rule. */
  readonly rules: ReadonlyArray<string> | undefined
  /** Carry tsgo's own diagnostics in the same report. */
  readonly typecheck: boolean
  /** Use tsgo for project discovery instead of walking directories. */
  readonly useTsgo: boolean
  /**
   * True when the caller chose where judgements are stored. If they did not,
   * joggle refuses to persist evidence for files that live outside the analysis
   * root -- otherwise analysing another repository from here would write that
   * repository's source into this one's committed cache.
   */
  readonly cacheDirExplicit: boolean
}

const reasonOf = (error: JudgeError): string => {
  switch (error._tag) {
    case "joggle/JudgeUnavailable":
      return error.reason
    case "joggle/JudgeRejected":
      return `HTTP ${error.status}: ${error.detail}`
    case "joggle/JudgeMalformed":
      return error.detail
    case "joggle/JudgeTransport":
      return error.detail
    default:
      return String(error)
  }
}

const typecheckFindings = (output: ReadonlyArray<{ readonly file: string; readonly line: number; readonly column: number; readonly severity: "error" | "warning"; readonly code: string; readonly message: string }>): ReadonlyArray<Diagnostic> =>
  output.map((diagnostic) =>
    finding({
      ruleId: "joggle/typecheck",
      severity: diagnostic.severity === "error" ? "error" : "warn",
      message: `${diagnostic.code}: ${diagnostic.message}`,
      location: { file: diagnostic.file, line: diagnostic.line, column: diagnostic.column },
      judged: false,
    }),
  )

/**
 * One pass over the workspace: deterministic candidates, then judgement for
 * the rules that ask for it, then a single sorted report.
 */
export const runCheck = Effect.fn("joggle.check")(function* (options: Options) {
  const started = Date.now()
  const selected =
    options.rules === undefined
      ? allRules
      : allRules.filter((rule) => options.rules?.includes(rule.id) === true)

  const judge = yield* Judge

  const discovered =
    options.paths.length === 0 && options.useTsgo
      ? yield* Effect.gen(function* () {
          const tsgo = yield* Tsgo
          return yield* tsgo.listFiles(options.cwd).pipe(Effect.orElseSucceed(() => undefined))
        })
      : undefined

  const workspaceStarted = Date.now()
  const workspace = yield* loadWorkspace(options.cwd, options.paths, discovered)
  const timings: Array<{ phase: string; ms: number }> = [
    { phase: "workspace", ms: Date.now() - workspaceStarted },
  ]

  const diagnostics: Array<Diagnostic> = []
  const skipped: Array<Skipped> = []
  const notes: Array<Skipped> = []

  // A file outside the root produces a "../" relative path. Its evidence has no
  // business in a cache whose location nobody chose.
  const escaping = workspace.files.filter((file) => file.path.startsWith(".."))
  const breach = !options.cacheDirExplicit && escaping.length > 0
  if (breach) {
    const first = escaping[0]
    diagnostics.push(
      finding({
        ruleId: "joggle/cache-boundary",
        severity: "error",
        message: `Analysed files live outside the project root (${first?.path ?? "?"}), so judgements would be persisted into a cache that does not own that code.`,
        help: "Pass --cache-dir pointing outside the analysed tree, or run joggle from the analysed project's root.",
        location: { file: first?.path ?? ".", line: 1, column: 1 },
        judged: false,
      }),
    )
  }

  const effective = breach ? selected.filter((rule) => !rule.judged) : selected
  if (breach) {
    for (const rule of selected) {
      if (rule.judged) {
        skipped.push({ ruleId: rule.id, reason: "cache boundary: evidence would cross repositories" })
      }
    }
  }

  for (const rule of effective) {
    const ruleStarted = Date.now()
    const result = yield* rule.run(workspace).pipe(
      Effect.map((value) => ({ _tag: "ok" as const, value })),
      Effect.catch((error) => Effect.succeed({ _tag: "skipped" as const, error })),
    )
    if (result._tag === "ok") {
      diagnostics.push(...result.value.diagnostics)
      for (const note of result.value.notes) notes.push({ ruleId: rule.id, reason: note })
    } else {
      skipped.push({ ruleId: rule.id, reason: reasonOf(result.error) })
    }
    timings.push({ phase: rule.id.replace("joggle/", ""), ms: Date.now() - ruleStarted })
  }

  if (options.typecheck && options.useTsgo) {
    const tsgo = yield* Tsgo
    const typeErrors = yield* tsgo.typecheck(options.cwd).pipe(Effect.orElseSucceed(() => []))
    diagnostics.push(...typecheckFindings(typeErrors))
  }

  const report: Report = {
    diagnostics: rankDiagnostics(diagnostics),
    files: workspace.files.length,
    rules: effective.length,
    skipped,
    notes,
    timings,
    judge: yield* judge.stats,
    elapsedMs: Date.now() - started,
  }
  return report
})
