import { Effect, FileSystem, Path } from "effect"
import { pathToFileURL } from "node:url"
import { shortHash } from "./state.ts"
import type { Rule } from "./rule.ts"

/**
 * Rules that arrive from the repository instead of from this package.
 *
 * A linter is a registry. `allRules` is a hardcoded array in this package, which
 * makes the rule CONTRACT pluggable and the rule SET closed: writing an opinion
 * of your own means forking the tool. ESLint solved this and the shape is worth
 * copying -- a rule is a value, a plugin is a module that exports values, and the
 * config says which ones to run.
 *
 * A plugin module exports `rules`. Nothing else about it is special, so a plugin
 * is also how a PRESET ships: the opinions in this package could be published as
 * one, and a repository could enable it alongside its own.
 *
 * Two things this deliberately does not do:
 *
 * - It does not swallow a plugin that fails to load. A rule that silently is not
 *   there is worse than one that errors, because the report looks clean.
 * - It does not skip fingerprinting. `policy.analysisVersion` was a hand-bumped
 *   string that got forgotten twice, and the same hole opens the moment a rule
 *   can live outside the directory this tool hashes: an edited plugin with an
 *   unchanged path would replay a stale report. Each plugin's own source is
 *   hashed into the run manifest for that reason.
 */
export interface Loaded {
  readonly rules: ReadonlyArray<Rule>
  /** Plugins that could not be loaded, and why. Reported, never dropped. */
  readonly failures: ReadonlyArray<{ readonly specifier: string; readonly reason: string }>
  /** Content hashes, one per loaded plugin. */
  readonly fingerprints: ReadonlyArray<string>
}

const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"]

/**
 * A specifier as a file: relative to the repository, or a bare module name.
 *
 * A bare name is left to the runtime's own resolution, which is what makes a
 * published plugin (`@acme/joggle-rules`) work without this knowing anything
 * about how packages are installed.
 */
const resolve = (
  specifier: string,
  cwd: string,
  path: Path.Path,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) return specifier
    const fs = yield* FileSystem.FileSystem
    const base = path.isAbsolute(specifier) ? specifier : path.join(cwd, specifier)
    for (const candidate of [base, ...EXTENSIONS.map((extension) => base + extension)]) {
      if (yield* Effect.orElseSucceed(fs.exists(candidate), () => false)) return candidate
    }
    return base
  })

const rulesOf = (module: unknown): ReadonlyArray<Rule> => {
  if (typeof module !== "object" || module === null) return []
  const exported = (module as Record<string, unknown>)["rules"]
  return Array.isArray(exported) ? (exported as ReadonlyArray<Rule>) : []
}

export const loadPlugins = (
  specifiers: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<Loaded, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (specifiers.length === 0) return { rules: [], failures: [], fingerprints: [] }
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const rules: Array<Rule> = []
    const failures: Array<{ specifier: string; reason: string }> = []
    const fingerprints: Array<string> = []

    for (const specifier of specifiers) {
      // A specifier that resolves to nothing is not special-cased: `import`
      // fails on it and the runtime's own message is the failure reason, which
      // is more accurate than anything this could invent.
      const resolved = yield* resolve(specifier, cwd, path)

      const attempt = yield* Effect.tryPromise({
        try: () => import(pathToFileURL(resolved).href),
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(
        Effect.map((module) => ({ ok: true as const, module })),
        Effect.catch((reason) => Effect.succeed({ ok: false as const, reason })),
      )

      if (!attempt.ok) {
        failures.push({ specifier, reason: attempt.reason })
        continue
      }
      const found = rulesOf(attempt.module)
      if (found.length === 0) {
        failures.push({ specifier, reason: "loaded, but exports no `rules` array" })
        continue
      }
      rules.push(...found)

      // The plugin's own source, so editing it invalidates the run cache the same
      // way editing this package does.
      const text = yield* Effect.orElseSucceed(fs.readFileString(resolved), () => "")
      fingerprints.push(specifier + "\u0000" + shortHash(text))
    }

    return { rules, failures, fingerprints }
  })
