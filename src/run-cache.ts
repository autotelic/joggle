import { Effect, FileSystem, Path, Result, Schema, SchemaParser } from "effect"
import { policy } from "./policy.ts"
import { shortHash } from "./state.ts"
import { Baseline, StoredRun } from "./schema.ts"

// The persisted side of a run: the manifest that decides whether to replay, and
// the last run and baseline that are read back. Its own module because it is a
// boundary: every file here can be absent, truncated, or left over from another
// version, so every read decodes with a Schema and every failure is a miss.

/**
 * Everything the output depends on, as one hash.
 *
 * Analysis version, question version, model, the rule set, the root, and the
 * content of every analysed file. If this is unchanged then the previous report
 * is the report -- no parsing, no candidate generation, and no tokens.
 *
 * @param root - The analysed root.
 * @param files - Every analysed file, root-relative or absolute.
 * @param contents - The text of each file.
 * @param ruleIds - The rule set that ran.
 * @param toolFingerprint - The tool's own source hash.
 * @returns The manifest hash.
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
      `rules=${[...ruleIds].sort((left, right) => left.localeCompare(right)).join(",")}`,
      `files=${files.length}`,
      ...files.map((file) => `${file}\u0000${shortHash(contents.get(file) ?? "")}`),
    ].join("\n"),
  )

const runPath = (path: Path.Path, cacheDir: string): string => path.join(cacheDir, "last-run.json")

/** The baseline is the file the config names, resolved by the caller. */
export const baselinePath = (_path: Path.Path, file: string): string => file

/**
 * Reads the stored run, or nothing when it is absent or unreadable.
 *
 * @param fs - The file system to read from.
 * @param path - The path service.
 * @param cacheDir - The directory holding `last-run.json`.
 * @returns The decoded run, or `undefined` for a miss.
 */
export const readStored = (
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

/**
 * Writes the run, so the next one can replay it.
 *
 * @param fs - The file system to write to.
 * @param path - The path service.
 * @param cacheDir - The directory holding `last-run.json`.
 * @param run - The run to store.
 */
export const writeStored = (
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

/**
 * Reads the accepted findings, or nothing when there is no baseline.
 *
 * @param fs - The file system to read from.
 * @param file - The baseline file.
 * @returns The accepted identities, or `undefined` for a miss.
 */
export const readBaseline = (
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

/**
 * Writes the accepted findings as the new baseline.
 *
 * @param fs - The file system to write to.
 * @param path - The path service.
 * @param file - The baseline file.
 * @param identities - The finding identities to accept.
 */
export const writeBaseline = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
  identities: ReadonlyArray<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const parent = path.dirname(file)
    yield* Effect.orElseSucceed(fs.makeDirectory(parent, { recursive: true }), () => undefined)
    const body = JSON.stringify(
      { version: policy.version, identities: [...identities].sort((left, right) => left.localeCompare(right)) },
      null,
      2,
    )
    yield* Effect.orElseSucceed(fs.writeFileString(file, body), () => undefined)
  })
