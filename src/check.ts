import { Effect } from "effect"
import { Service as Judge } from "./judge.ts"
import { finding } from "./rule.ts"
import { allRules } from "./rules/index.ts"
import { sortDiagnostics, type Report, type Skipped } from "./report.ts"
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

  const workspace = yield* loadWorkspace(options.cwd, options.paths, discovered)

  const diagnostics: Array<Diagnostic> = []
  const skipped: Array<Skipped> = []

  for (const rule of selected) {
    const outcome = yield* rule.run(workspace).pipe(
      Effect.map((findings) => ({ _tag: "ok" as const, findings })),
      Effect.catch((error) => Effect.succeed({ _tag: "skipped" as const, error })),
    )
    if (outcome._tag === "ok") diagnostics.push(...outcome.findings)
    else skipped.push({ ruleId: rule.id, reason: reasonOf(outcome.error) })
  }

  if (options.typecheck && options.useTsgo) {
    const tsgo = yield* Tsgo
    const typeErrors = yield* tsgo.typecheck(options.cwd).pipe(Effect.orElseSucceed(() => []))
    diagnostics.push(...typecheckFindings(typeErrors))
  }

  const report: Report = {
    diagnostics: sortDiagnostics(diagnostics),
    files: workspace.files.length,
    rules: selected.length,
    skipped,
    judge: yield* judge.stats,
    elapsedMs: Date.now() - started,
  }
  return report
})
