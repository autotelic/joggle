import { Clock, Effect, FileSystem, Path, Result, Schema, SchemaParser } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import { shortHash } from "./state.ts"
import { sourceFingerprint } from "./fingerprint.ts"
import { loadParses } from "./parsecache.ts"
import { JudgeStats } from "./decision.ts"
import { policy } from "./policy.ts"
import { finding } from "./rule.ts"
import { Rules } from "./rules/index.ts"
import type { Rule } from "./rule.ts"
import type { Loaded } from "./plugins.ts"
import { funnelNotes, rankDiagnostics, type Report, type Skipped } from "./report.ts"
import { everyFile, type Scope } from "./rule.ts"
import { appliesAt, isEnabled, isIgnored, severityFor, type JoggleConfig } from "./config.ts"
import {
  Baseline,
  StoredRun,
  WorkspaceError,
  type Drop,
  type Diagnostic,
  type JudgeTotals,
} from "./schema.ts"
import { Service as Tsgo } from "./tsgo.ts"
import { discoverFiles, loadWorkspace } from "./workspace.ts"
import type { ImportGraph } from "./imports.ts"

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
  /** Where the committed artifacts live: judgements and the baseline. */
  readonly cacheDir: string
  /**
   * Where the ephemeral run cache lives. Defaults to the committed cache
   * directory, but the caller normally points it at the machine cache so that a
   * run writes nothing into the repository it is analysing.
   */
  readonly runCacheDir?: string | undefined
  /** Rules, severities and exceptions, from joggle.config.json. */
  readonly config: JoggleConfig
  /** Rules loaded from `plugins`, fingerprinted. */
  readonly plugins?: Loaded | undefined
  /** Replay the stored run when nothing the output depends on has changed. */
  readonly replayUnchanged: boolean
  /**
   * Answer "what did this change introduce" instead of "what is wrong with the
   * repository". Candidate generation is restricted to declarations that moved,
   * and the stored run is left alone because a scoped run is not a full run.
   */
  readonly changed: boolean
  /** Report only findings that are not already accepted in this baseline. */
  readonly baselinePath: string | undefined
  /** Write the current findings as the accepted baseline. */
  readonly updateBaselinePath: string | undefined
}

const reasonOf = (error: AiError.AiError): string => error.message

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

/* -------------------------------------------------------------------------- */
/* Run manifest                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything the output depends on, as one hash.
 *
 * Analysis version, question version, model, the rule set, the root, and the
 * content of every analysed file. If this is unchanged then the previous report
 * is the report -- no parsing, no candidate generation, and no tokens.
 *
 * Rule LOGIC changes are covered by `policy.analysisVersion` and nothing else:
 * a filter or a clustering rule can change every finding while leaving every
 * question byte-identical. Bump it when the rules move.
 */
export const manifestOf = (
  root: string,
  files: ReadonlyArray<string>,
  contents: ReadonlyMap<string, string>,
  ruleIds: ReadonlyArray<string>,
  toolFingerprint: string,
): string =>
  shortHash(
    [
      // The tool's own source, so a rule change cannot be forgotten. The declared
      // version stays beside it as the documented fallback.
      `tool=${toolFingerprint}`,
      `analysis=${policy.analysisVersion}`,
      `questions=${policy.questionVersion}`,
      `model=${policy.model}`,
      `root=${root}`,
      `rules=${[...ruleIds].sort().join(",")}`,
      `files=${files.length}`,
      ...files.map((file) => `${file}\u0000${shortHash(contents.get(file) ?? "")}`),
    ].join("\n"),
  )

/**
 * Which files moved since the stored run, or undefined when there is none to
 * compare against.
 */
const changedSince = (
  stored: StoredRun | undefined,
  hashOf: ReadonlyMap<string, string>,
): ReadonlySet<string> | undefined => {
  if (stored === undefined) return undefined
  const before = new Map(stored.sources.map((source) => [source.path, source.hash]))
  const changed = new Set<string>()
  for (const [file, hash] of hashOf) {
    if (before.get(file) !== hash) changed.add(file)
  }
  for (const file of before.keys()) {
    if (!hashOf.has(file)) changed.add(file)
  }
  return changed
}

/** Exported declaration names by root-relative path. */
const exportsOf = (workspace: {
  readonly units: ReadonlyArray<{ readonly file: string; readonly name: string; readonly exported: boolean }>
}): ReadonlyMap<string, ReadonlyArray<string>> => {
  const out = new Map<string, Array<string>>()
  for (const unit of workspace.units) {
    if (!unit.exported) continue
    const names = out.get(unit.file)
    if (names === undefined) out.set(unit.file, [unit.name])
    else names.push(unit.name)
  }
  return out
}

/**
 * A change to a file's EXPORTS can move what a dependent's type names resolve
 * to, so dependents come into scope -- but only then.
 *
 * Closing over importers unconditionally looked harmless and was not: a
 * body-only edit to one widely-imported file pulled 190 files into scope, which
 * is most of the analysis back again for a change that could not have affected
 * any of them.
 */
const affectedBy = (
  changed: ReadonlySet<string>,
  imports: ImportGraph,
  before: ReadonlyMap<string, ReadonlyArray<string>>,
  after: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlySet<string> => {
  const out = new Set(changed)
  for (const file of changed) {
    const was = [...(before.get(file) ?? [])].sort().join(",")
    const now = [...(after.get(file) ?? [])].sort().join(",")
    if (was === now) continue
    for (const edge of imports.importersOf.get(file) ?? []) out.add(edge.from)
  }
  return out
}

const runPath = (path: Path.Path, cacheDir: string): string => path.join(cacheDir, "last-run.json")
const baselinePath = (path: Path.Path, file: string): string => file

const readStored = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cacheDir: string,
): Effect.Effect<StoredRun | undefined> =>
  Effect.gen(function* () {
    const file = runPath(path, cacheDir)
    const exists = yield* Effect.orElseSucceed(fs.exists(file), () => false)
    if (!exists) return undefined
    const text = yield* Effect.orElseSucceed(fs.readFileString(file), () => "")
    if (text.trim() === "") return undefined
    return Result.getOrUndefined(SchemaParser.decodeUnknownResult(Schema.fromJsonString(StoredRun))(text))
  })

const writeStored = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cacheDir: string,
  run: StoredRun,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.orElseSucceed(fs.makeDirectory(cacheDir, { recursive: true }), () => undefined)
    yield* Effect.orElseSucceed(
      fs.writeFileString(runPath(path, cacheDir), JSON.stringify(run, null, 2)),
      () => undefined,
    )
  })

const readBaseline = (
  fs: FileSystem.FileSystem,
  file: string,
): Effect.Effect<ReadonlySet<string> | undefined> =>
  Effect.gen(function* () {
    const exists = yield* Effect.orElseSucceed(fs.exists(file), () => false)
    if (!exists) return undefined
    const text = yield* Effect.orElseSucceed(fs.readFileString(file), () => "")
    const decoded = Result.getOrUndefined(SchemaParser.decodeUnknownResult(Schema.fromJsonString(Baseline))(text))
    return decoded === undefined ? undefined : new Set(decoded.identities)
  })

const writeBaseline = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
  identities: ReadonlyArray<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const parent = path.dirname(file)
    yield* Effect.orElseSucceed(fs.makeDirectory(parent, { recursive: true }), () => undefined)
    const body = JSON.stringify(
      { version: policy.version, identities: [...identities].sort() },
      null,
      2,
    )
    yield* Effect.orElseSucceed(fs.writeFileString(file, body), () => undefined)
  })

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One pass over the workspace: deterministic candidates, then judgement for
 * the rules that ask for it, then a single sorted report.
 */
export const runCheck = Effect.fn("joggle.check")(function* (options: Options) {
  const started = yield* Clock.currentTimeMillis
  // Built-in rules plus the repository's own. A plugin rule is not special: it
  // is selectable, configurable, severable and ignorable like any other, which is
  // the whole point of it being a registry rather than an array.
  const builtInRules = yield* Rules
  const universe: ReadonlyArray<Rule> = [
    ...builtInRules,
    ...(options.plugins?.rules ?? []),
  ]
  const selected = (
    options.rules === undefined
      ? universe
      : universe.filter((rule) => options.rules?.includes(rule.id) === true)
  ).filter((rule) => isEnabled(options.config, rule.id, rule.severity))

  const judgeStats = yield* JudgeStats
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const discovered =
    options.paths.length === 0 && options.useTsgo
      ? yield* Effect.gen(function* () {
          const tsgo = yield* Tsgo
          return yield* tsgo.listFiles(options.cwd).pipe(Effect.orElseSucceed(() => undefined))
        })
      : undefined

  const discoverStarted = yield* Clock.currentTimeMillis
  const discovery = yield* discoverFiles(options.cwd, options.paths, discovered)
  const files = discovery.files

  // A run that found no source files did not pass. Reporting "0 problems" for an
  // empty file set is the worst output this program can produce, because it looks
  // exactly like success -- and that is how the architecture rules measured
  // nothing at all while appearing clean, when the tool was invoked with no path
  // argument and TypeScript discovery came back empty.
  if (files.length === 0) {
    const where =
      options.paths.length === 0
        ? "no source files under " + options.cwd + ", and no path argument was given"
        : "no source files under " + options.paths.join(", ") + " in " + options.cwd
    return yield* Effect.fail(
      new WorkspaceError({ path: options.cwd, operation: "discover", cause: new Error(where) }),
    )
  }

  // Read once. The manifest needs the content, and a miss hands the same text to
  // the parser rather than reading the tree twice.
  const contents = new Map<string, string>()
  for (const absolute of files) {
    const text = yield* Effect.orElseSucceed(fs.readFileString(absolute), () => undefined)
    if (text !== undefined) contents.set(absolute, text)
  }
  const discoverMs = (yield* Clock.currentTimeMillis) - discoverStarted

  // The tool's own source, which is also the parse cache's version: the parser is
  // part of the tool, so an entry produced by a different parser is not a cache
  // hit, it is a wrong answer.
  const toolFingerprint = [
    yield* sourceFingerprint(policy.analysisVersion),
    ...(options.plugins?.fingerprints ?? []),
  ].join("\u0000")
  const manifest = manifestOf(
    options.cwd,
    files,
    contents,
    selected.map((rule) => rule.id),
    toolFingerprint,
  )
  const hashOf = new Map(
    files.map((file) => [path.relative(options.cwd, file), shortHash(contents.get(file) ?? "")]),
  )

  const finish = (report: Report): Effect.Effect<Report> =>
    Effect.gen(function* () {
      let diagnostics = report.diagnostics
      let note: Skipped | undefined
      if (options.baselinePath !== undefined) {
        const known = yield* readBaseline(fs, baselinePath(path, options.baselinePath))
        if (known !== undefined) {
          const before = diagnostics.length
          diagnostics = diagnostics.filter(
            (entry) => entry.identity === undefined || !known.has(entry.identity),
          )
          note = {
            ruleId: "joggle",
            reason: `${before - diagnostics.length} finding(s) already in the baseline were not reported`,
          }
        }
      }
      if (options.updateBaselinePath !== undefined) {
        const identities = report.diagnostics
          .map((entry) => entry.identity)
          .filter((identity): identity is string => identity !== undefined)
        yield* writeBaseline(fs, path, baselinePath(path, options.updateBaselinePath), identities)
      }
      return note === undefined ? { ...report, diagnostics } : { ...report, diagnostics, notes: [...report.notes, note] }
    })

  const runCache = options.runCacheDir ?? options.cacheDir

  const stored = yield* readStored(fs, path, runCache)
  if (options.replayUnchanged) {
    if (stored !== undefined && stored.manifest === manifest) {
      return yield* finish({
        diagnostics: stored.diagnostics,
        files: stored.files,
        rules: stored.rules,
        skipped: stored.skipped,
        drops: stored.drops ?? [],
        notes: [
          {
            ruleId: "joggle",
            reason: `replayed the previous run: nothing it depends on changed across ${stored.files} files`,
          },
        ],
        timings: [{ phase: "replay-check", ms: discoverMs }],
        // This run spent nothing, so it reports nothing spent.
        judge: { requests: 0, replayed: 0, calls: 0, unavailable: 0, inputTokens: 0, outputTokens: 0 },
        elapsedMs: (yield* Clock.currentTimeMillis) - started,
        replayed: true,
      })
    }
  }

  const workspaceStarted = yield* Clock.currentTimeMillis
  const parseCache = yield* loadParses(options.cacheDir, toolFingerprint)
  const workspace = yield* loadWorkspace(
    options.cwd,
    options.paths,
    files,
    contents,
    parseCache.parses,
  )
  // Written after the load, and only when something was actually parsed.
  yield* parseCache.save
  const timings: Array<{ phase: string; ms: number }> = [
    { phase: "workspace", ms: (yield* Clock.currentTimeMillis) - workspaceStarted },
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

  // Scope after the workspace is loaded: closing over the import graph needs it.
  let scope: Scope = everyFile
  if (options.changed) {
    const changed = changedSince(stored, hashOf)
    if (changed === undefined) {
      notes.push({
        ruleId: "joggle",
        reason: "scoped run with no stored run to compare against: every file is in scope",
      })
    } else {
      const beforeExports = new Map(
        (stored?.sources ?? []).map((source) => [source.path, source.exports]),
      )
      const affected = affectedBy(
        changed,
        workspace.imports,
        beforeExports,
        exportsOf(workspace),
      )
      scope = { changed: affected }
      notes.push({
        ruleId: "joggle",
        reason: `scoped to ${affected.size} file(s) that moved: this answers what the change introduced, not what is wrong with the repository`,
      })
    }
  }

  const drops: Array<Drop> = []

  // The rules are independent, and the judged ones wait on the network. Running
  // them concurrently overlaps those waits; the results are collected in order, so
  // the report is unchanged. The DecisionModel layer serializes its own cache
  // writes, so two rules finishing at once cannot interleave a full write.
  const ruleResults = yield* Effect.forEach(
    effective,
    (rule) =>
      Effect.gen(function* () {
        const ruleStarted = yield* Clock.currentTimeMillis
        // The config goes in, because a rule that enforces a layering is entitled
        // to know what the layering is. Rules that need nothing take two
        // parameters.
        const result = yield* rule.run(workspace, scope, { config: options.config }).pipe(
          Effect.map((value) => ({ _tag: "ok" as const, value })),
          Effect.catch((error) => Effect.succeed({ _tag: "skipped" as const, error })),
        )
        return { rule, result, ms: (yield* Clock.currentTimeMillis) - ruleStarted }
      }),
    { concurrency: policy.judge.requestConcurrency },
  )
  for (const { rule, result, ms } of ruleResults) {
    if (result._tag === "ok") {
      diagnostics.push(...result.value.diagnostics)
      for (const note of result.value.notes) notes.push({ ruleId: rule.id, reason: note })
      drops.push(...result.value.drops)
    } else {
      skipped.push({ ruleId: rule.id, reason: reasonOf(result.error) })
    }
    timings.push({ phase: rule.id.replace("joggle/", ""), ms })
  }

  // What the run did not look at.
  //
  // The funnel rule applied to the one bound that had no report: every bound in
  // this program is a decision not to look at something, and a bound nobody can
  // see is indistinguishable from a bug. Discovery used to drop non-source files
  // inside its own loop, so "287 files" read as the repository rather than as a
  // fifth of it.
  if (discovery.truncated) {
    notes.push({
      ruleId: "joggle",
      reason: "the file walk hit its own limit: this run saw only part of the tree",
    })
  }
  // A plugin that did not load is reported, not logged and forgotten. A rule
  // that is silently absent makes the report look clean, which is the one
  // failure mode this program keeps having to design against.
  for (const failure of options.plugins?.failures ?? []) {
    notes.push({
      ruleId: "joggle",
      reason: "plugin " + failure.specifier + " was not loaded: " + failure.reason,
    })
  }
  // What the run extracted, before a single rule filtered it.
  //
  // This note exists because its absence made a clean report unreadable. Run
  // against a 110-file library, joggle reported "2 problems" and nothing else,
  // and there was no way to tell whether the rules had looked at a clean codebase
  // or at almost nothing. The extraction was fine -- 257 declarations -- but the
  // only counts in the report were the FILTERED ones each rule chose to mention,
  // so "11 type declaration(s)" read as the population when it was 11 of 53.
  const kinds = new Map<string, number>()
  for (const unit of workspace.units) kinds.set(unit.kind, (kinds.get(unit.kind) ?? 0) + 1)
  const exported = workspace.units.filter((unit) => unit.exported).length
  notes.push({
    ruleId: "joggle",
    reason:
      "extracted " +
      workspace.units.length +
      " declaration(s) from " +
      workspace.files.length +
      " file(s): " +
      [...kinds.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([kind, count]) => count + " " + kind)
        .join(", ") +
      "; " +
      exported +
      " exported, " +
      (workspace.units.length - exported) +
      " file-local",
  })

  if (parseCache.issues.length > 0) {
    notes.push({
      ruleId: "joggle",
      reason: "the parse cache did not decode and was ignored: " + parseCache.issues[0],
    })
  }
  const parsedFromCache = workspace.parses.hits()
  const parsedAgain = workspace.parses.misses()
  if (parsedFromCache > 0 || parsedAgain > 0) {
    notes.push({
      ruleId: "joggle",
      reason:
        "parsed " +
        parsedAgain +
        " file(s) and reused " +
        parsedFromCache +
        " parse(s) from the cache",
    })
  }
  if (workspace.testDeclarations > 0) {
    notes.push({
      ruleId: "joggle",
      reason:
        workspace.testDeclarations +
        " declaration(s) in test files are compared only against each other: a factory is supposed to be repeated",
    })
  }
  if (workspace.excludedHelpers > 0) {
    notes.push({
      ruleId: "joggle",
      reason:
        workspace.excludedHelpers +
        " transpiler helper(s) were not analysed: they appear once per file by construction",
    })
  }
  if (discovery.ignored > 0) {
    notes.push({
      ruleId: "joggle",
      reason:
        "ignored by .gitignore: " +
        discovery.ignored +
        " file(s) and " +
        discovery.ignoredDirectories +
        " director" +
        (discovery.ignoredDirectories === 1 ? "y" : "ies") +
        " not analysed",
    })
  }
  if (discovery.skipped.length > 0) {
    const total = discovery.skipped.reduce((sum, entry) => sum + entry.count, 0)
    const shown = discovery.skipped.slice(0, 4).map((entry) => entry.extension + " " + entry.count)
    const rest = discovery.skipped.length - shown.length
    notes.push({
      ruleId: "joggle",
      reason:
        "not parsed: " +
        total +
        " file(s) outside the parser's extensions (" +
        shown.join(", ") +
        (rest > 0 ? ", and " + rest + " more" : "") +
        ")",
    })
  }
  if (workspace.unparsed.length > 0) {
    const example = workspace.unparsed[0]
    notes.push({
      ruleId: "joggle",
      reason:
        workspace.unparsed.length +
        " file(s) failed to parse, e.g. " +
        (example === undefined ? "" : example.path + ": " + example.reason),
    })
  }

  // The funnel, in the report rather than in a debug log.
  //
  // A rule that reports nothing is either a rule with nothing to look at or a
  // rule whose gate is too tight, and the finding count cannot tell the two
  // apart. This is what does -- and it is the only way a threshold can be tuned
  // from evidence rather than from a guess.
  notes.push(...funnelNotes(drops))

  if (options.typecheck && options.useTsgo) {
    const tsgo = yield* Tsgo
    const typeErrors = yield* tsgo.typecheck(options.cwd).pipe(Effect.orElseSucceed(() => []))
    diagnostics.push(...typecheckFindings(typeErrors))
  }

  // The config decides how loudly a rule speaks and what is excepted. Both are
  // applied here rather than inside the rules, so a rule cannot opt out of being
  // configured.
  const configured = diagnostics
    .map((entry) => ({ entry, severity: severityFor(options.config, entry.ruleId, entry.severity) }))
    .filter((item): item is { entry: Diagnostic; severity: import("./schema.ts").Severity } => item.severity !== "off")
    .map((item) => ({ ...item.entry, severity: item.severity }))
    .filter((entry) => !isIgnored(options.config, entry.ruleId, entry.location.file))
    // Scoped out by configuration: this rule is not configured to speak about
    // this file. A finding, not a rule, is what gets scoped.
    .filter((entry) => appliesAt(options.config, entry.ruleId, entry.location.file))

  // The workspace's own phases, alongside the per-rule timings. A run that says
  // "workspace 4.4s" and nothing else is a run nobody can make faster.
  timings.push(...workspace.phases)

  const judgeTotals: JudgeTotals = yield* judgeStats.read
  const elapsedMs = (yield* Clock.currentTimeMillis) - started
  const report: Report = {
    diagnostics: rankDiagnostics(configured),
    files: workspace.files.length,
    rules: effective.length,
    skipped,
    notes,
    drops,
    timings,
    judge: judgeTotals,
    elapsedMs,
    replayed: false,
  }

  // Stored before the baseline filter, so a later replay reproduces the whole
  // run and the baseline is applied to it again rather than baked in.
  // A scoped run is not a full run, so it must not become the baseline that the
  // next full run is compared against.
  if (!options.changed) {
    yield* writeStored(fs, path, runCache, {
      version: policy.version,
      manifest,
      sources: workspace.files.map((file) => ({
        path: file.path,
        hash: hashOf.get(file.path) ?? "",
        exports: [...(exportsOf(workspace).get(file.path) ?? [])].sort(),
      })),
      diagnostics: report.diagnostics,
      files: report.files,
      rules: report.rules,
      skipped: report.skipped,
      notes: report.notes,
      drops: report.drops,
      judge: judgeTotals,
      elapsedMs,
    })
  }

  return yield* finish(report)
})
