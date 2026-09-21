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
  structure: { concepts: 12, declarations: 18, duplicated: 6, overloaded: 1 },
  skipped: [{ ruleId: "joggle/naming-drift", reason: "TYPESAFE_API_KEY is not set" }],
  drops: [],
  notes: [{ ruleId: "joggle/duplicate-meaning", reason: "12 of 412 clusters were not judged" }],
  timings: [{ phase: "workspace", ms: 1200 }],
  decision: { requests: 1, replayed: 0, calls: 1, unavailable: 0, inputTokens: 900, outputTokens: 40 },
  elapsedMs: 5,
  replayed: false,
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

it("a finding that proposes an operation says what it costs", () => {
  const rendered = render(
    report([
      diagnostic({
        repair: {
          operation: "merge",
          remove: [],
          cascade: [
            { file: "src/b.ts", line: 1, column: 1, instruction: "import it" },
            { file: "src/c.ts", line: 2, column: 1, instruction: "call it" },
          ],
          complete: true,
          settled: "the table and the model agree",
        },
      }),
    ]),
    "text",
  )
  expect(rendered).toContain("-> merge, 2 edits")
  // And a finding with no operation is a plain linter line.
  expect(render(report([diagnostic()]), "text")).not.toContain("->")
})

it("the shape line reports the concepts against the declarations", () => {
  const rendered = render(report([]), "text")
  expect(rendered).toContain("12 concepts")
  expect(rendered).toContain("18 declarations")
  expect(rendered).toContain("6 duplicated")
})

it("default output is one greppable line per problem, like oxlint", () => {
  const out = render(report([diagnostic({ help: "Keep the other one." })]), "text")
  expect(out).toContain("src/a.ts:3:7: warning joggle/duplicate-implementation:")
  expect(out).toContain("help: Keep the other one.")
  expect(out).toContain("1 problem (1 warning)")
  expect(out).toContain("note: joggle/naming-drift skipped")
  // No code frame: the compact form is what keeps CI logs readable.
  expect(out).not.toContain("│")
})

it("stylish groups by file and colours only when asked", () => {
  const plainOut = render(report([diagnostic()]), "stylish")
  expect(plainOut).toContain("src/a.ts")
  expect(plainOut).toContain("✖ 1 problem (1 warning)")
  expect(plainOut).not.toContain("\u001b")
  const coloured = render(report([diagnostic()]), "stylish", { color: true })
  expect(coloured).toContain("\u001b[")
})

it("unix output is machine-parsable and ends with a count", () => {
  const out = render(report([diagnostic()]), "unix")
  expect(out).toContain("src/a.ts:3:7: Something is duplicated. [Warning/joggle/duplicate-implementation]")
  expect(out).toContain("1 problem")
})

it("github output emits workflow commands", () => {
  const text = render(report([diagnostic({ severity: "error" })]), "github")
  expect(text).toContain("::error file=src/a.ts,line=3,col=7,title=joggle/duplicate-implementation::")
  expect(text).toContain("::notice title=joggle/naming-drift::")
})

it("json output is machine readable", () => {
  const parsed = JSON.parse(render(report([diagnostic()]), "json"))
  expect(parsed.summary.problems).toBe(1)
  expect(parsed.summary.decision.requests).toBe(1)
  expect(parsed.diagnostics[0].ruleId).toBe("joggle/duplicate-implementation")
})

it("exit codes follow errors and the warning budget", () => {
  expect(exitCodeFor(report([]), -1)).toBe(0)
  expect(exitCodeFor(report([diagnostic()]), -1)).toBe(0)
  expect(exitCodeFor(report([diagnostic()]), 0)).toBe(1)
  expect(exitCodeFor(report([diagnostic({ severity: "error" })]), 999)).toBe(1)
})
