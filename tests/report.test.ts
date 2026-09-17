import { expect, it } from "@effect/vitest"
import { exitCodeFor, render, sortDiagnostics, type Report } from "../src/report.ts"
import type { Diagnostic } from "../src/schema.ts"

const diagnostic = (overrides: Partial<Diagnostic> = {}): Diagnostic => ({
  ruleId: "joggle/duplicate-implementation",
  severity: "warn",
  message: "Something is duplicated.",
  location: { file: "src/a.ts", line: 3, column: 7 },
  judged: false,
  ...overrides,
})

const report = (diagnostics: ReadonlyArray<Diagnostic>): Report => ({
  diagnostics,
  files: 2,
  rules: 3,
  skipped: [{ ruleId: "joggle/naming-drift", reason: "TYPESAFE_API_KEY is not set" }],
  judge: { requests: 1, replayed: 0, calls: 0, unavailable: 0 },
  elapsedMs: 5,
  sources: new Map([["src/a.ts", "// header\nconst x = 1\nexport const b = 2\n"]]),
})

it("sorts by file, then position, then severity", () => {
  const sorted = sortDiagnostics([
    diagnostic({ location: { file: "src/b.ts", line: 1, column: 1 } }),
    diagnostic({ location: { file: "src/a.ts", line: 9, column: 1 } }),
    diagnostic({ location: { file: "src/a.ts", line: 2, column: 1 }, severity: "error" }),
  ])
  expect(sorted.map((entry) => `${entry.location.file}:${entry.location.line}`)).toEqual([
    "src/a.ts:2",
    "src/a.ts:9",
    "src/b.ts:1",
  ])
})

it("text output carries a code frame, the help and a summary", () => {
  const text = render(report([diagnostic({ help: "Keep the other one." })]), "text")
  expect(text).toContain("src/a.ts:3:7")
  expect(text).toContain("joggle/duplicate-implementation")
  expect(text).toContain("export const b = 2") // the source line itself
  expect(text).toContain("─") // the caret underline
  expect(text).toContain("help: Keep the other one.")
  expect(text).toContain("Found 1 warning in 2 files")
  expect(text).toContain("note: joggle/naming-drift skipped")
})

it("an unverified finding is labelled as such", () => {
  const text = render(report([diagnostic()]), "text")
  expect(text).toContain("(unverified)")
})

it("github output emits workflow commands", () => {
  const text = render(report([diagnostic({ severity: "error" })]), "github")
  expect(text).toContain("::error file=src/a.ts,line=3,col=7,title=joggle/duplicate-implementation::")
  expect(text).toContain("::notice title=joggle/naming-drift::")
})

it("json output is machine readable", () => {
  const parsed = JSON.parse(render(report([diagnostic()]), "json"))
  expect(parsed.summary.problems).toBe(1)
  expect(parsed.summary.judge.requests).toBe(1)
  expect(parsed.diagnostics[0].ruleId).toBe("joggle/duplicate-implementation")
})

it("exit codes follow errors and the warning budget", () => {
  expect(exitCodeFor(report([]), -1)).toBe(0)
  expect(exitCodeFor(report([diagnostic()]), -1)).toBe(0)
  expect(exitCodeFor(report([diagnostic()]), 0)).toBe(1)
  expect(exitCodeFor(report([diagnostic({ severity: "error" })]), 999)).toBe(1)
})
