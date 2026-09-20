import { Effect, FileSystem, Result, Schema, SchemaParser } from "effect"
import type { Severity } from "./schema.ts"

/**
 * The file where a repository answers "it depends on what".
 *
 * `plumb` and this tool draw a line: plumb asks whether one file is well formed,
 * and its rules are written once and applied everywhere. joggle asks whether two
 * things are the same, and whether a thing fits THIS repository. The second
 * question has no universal answer, which is why an engineer says "it depends" -
 * and "it depends on what" is a question with a finite answer list. This file is
 * that list.
 *
 * Three parts, in the order a person meets them:
 *
 *   evidence.repository   the architecture, declared in prose, sent as context
 *                         to every judgement. This is the part that turns "it
 *                         depends" into "it depends on the following, which I
 *                         have written down here".
 *   rules                 which rules run, and how loudly.
 *   ignore                exceptions, by rule and by path.
 *
 * The judgement layer then does not have to infer the conventions of the
 * codebase from a bounded evidence panel; it is told them. And when the answer
 * to "it depends on what" changes, that is a one-line edit here rather than a
 * threshold change buried in rule logic.
 */
export const JoggleConfig = Schema.Struct({
  /**
   * Which rules run, how loudly, and where.
   *
   * A rule's value is a severity, or a severity plus the paths it applies to.
   * Scoping is what makes a PRESET usable: a preset that checks a domain layer's
   * purity should run everywhere, while one that decomposes a domain's types
   * should only run inside it. Without this, enabling a preset means running all
   * of it on all of the repository, which is how people decide a linter is too
   * noisy rather than too specific.
   */
  rules: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Union([
        Schema.Literals(["error", "warn", "info", "off"]),
        Schema.Struct({
          severity: Schema.Literals(["error", "warn", "info", "off"]),
          /** Globs, relative to the analysed root. Absent means everywhere. */
          paths: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ]),
    ),
  ),
  ignore: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        /** Rule id, exact or with `*`. Absent means every rule. */
        rule: Schema.optionalKey(Schema.String),
        /** Path glob, relative to the analysed root. */
        path: Schema.String,
        reason: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  /**
   * Rule modules to load from the repository, in addition to the built-in set.
   *
   * Relative specifiers resolve against the analysed root, so a repository's own
   * rules live with the repository's own config. A module exports `rules`.
   */
  /**
   * Rule modules to load from the repository, in addition to the built-in set.
   *
   * Relative specifiers resolve against the analysed root, so a repository's own
   * rules live with the repository's own config. A module exports `rules`.
   */
  plugins: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Packages of opinions: rule modules that also carry default severities.
   *
   * Mechanically identical to `plugins` -- the same loader, the same module shape
   * -- and listed separately because the intent is different. A plugin is code
   * someone wrote for their repository. A preset is a coherent position about how
   * code should be organised, which arrives with the severities it was designed
   * to run at and which the repository may override.
   */
  presets: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * The repository's layering, if it has one.
   *
   * Listed from most depended-upon to least, so a later layer may import an
   * earlier one and never the reverse. This is the part of a codebase's
   * architecture that is DECIDABLE -- it is a property of the import graph, not
   * of anyone's taste -- which is why it is enforced here rather than judged.
   */
  architecture: Schema.optionalKey(
    Schema.Struct({
      layers: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          include: Schema.Array(Schema.String),
          /**
           * Specifiers this layer may not import.
           *
           * The invariant that keeps a new architecture from eroding. A domain
           * package is pure by definition, and "pure" is not a judgement -- it
           * is an import-graph question with an exact answer. `react*` and
           * `fastify*` are prefix patterns on purpose: a name without a
           * wildcard has to match exactly, so `react` does not catch
           * `react-dom` by accident.
           */
          forbid: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
  evidence: Schema.optionalKey(
    Schema.Struct({
      /**
       * The repository's architecture, in the repository's own words.
       *
       * Kept short on purpose. It is sent with every judgement, so it is paid
       * for on every call, and a paragraph of aspiration is worse than a
       * sentence of fact: "pages compose atomic blocks from
       * components/<name>/ bundles" is worth more than "we value clean code".
       */
      repository: Schema.optionalKey(Schema.String),
    }),
  ),
})

export interface JoggleConfig extends Schema.Schema.Type<typeof JoggleConfig> {}

export interface IgnoreRule {
  readonly rule: string | undefined
  readonly path: string
  readonly reason: string | undefined
}

export const emptyConfig: JoggleConfig = {}

/**
 * Glob matching for path patterns: `*` stops at a separator, `**` does not.
 *
 * Exported because the architecture rules match file paths against declared
 * layers, and two matchers would be two behaviours for one config file.
 */
export const matchesGlob = (glob: string, value: string): boolean =>
  globToRegExp(glob).test(value)

const globToRegExp = (glob: string): RegExp => {
  const escaped = glob
    .split("")
    .map((character) => (/[.+^${}()|[\]\\?]/.test(character) ? "\\" + character : character))
    .join("")
  return new RegExp("^" + escaped.split("**").join("\u0000").split("*").join("[^/]*").split("\u0000").join(".*") + "$")
}

/** Whether a finding should be suppressed by the config's exceptions. */
export const isIgnored = (
  config: JoggleConfig,
  ruleId: string,
  path: string,
): boolean =>
  (config.ignore ?? []).some((entry) => {
    if (entry.rule !== undefined && !globToRegExp(entry.rule).test(ruleId)) return false
    return globToRegExp(entry.path).test(path)
  })

/**
 * A rule's configuration, in both of its forms.
 *
 * Written once so that everything downstream sees one shape. A rule declared as
 * a bare severity and one declared with paths differ only in where they apply,
 * which is not a distinction the rest of the program should have to carry.
 */
export interface RuleSetting {
  readonly severity: Severity | "off"
  readonly paths: ReadonlyArray<string> | undefined
}

const settingFor = (config: JoggleConfig, ruleId: string): RuleSetting | undefined => {
  const configured = config.rules?.[ruleId]
  if (configured === undefined) return undefined
  return typeof configured === "string"
    ? { severity: configured, paths: undefined }
    : { severity: configured.severity, paths: configured.paths }
}

/** The severity to use for a rule: the config's, or the rule's own. */
export const severityFor = (
  config: JoggleConfig,
  ruleId: string,
  fallback: Severity,
): Severity | "off" => settingFor(config, ruleId)?.severity ?? fallback

/**
 * Whether a rule's configuration lets it speak about this file.
 *
 * Applied to the FINDING, not to the rule. A rule reads the whole workspace -- a
 * duplicate is by definition about more than one file -- so scoping a rule out
 * of a file it is not configured for would mean it could not see that file at
 * all, and a duplicate across the boundary would vanish rather than be reported
 * or not. What is scoped is where the answer may be reported.
 */
export const appliesAt = (config: JoggleConfig, ruleId: string, path: string): boolean => {
  const paths = settingFor(config, ruleId)?.paths
  return paths === undefined || paths.some((glob) => matchesGlob(glob, path))
}

/** Whether a rule runs at all under this config. */
export const isEnabled = (
  config: JoggleConfig,
  ruleId: string,
  fallback: Severity,
): boolean => severityFor(config, ruleId, fallback) !== "off"

export const loadConfig = (
  file: string,
): Effect.Effect<JoggleConfig, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* Effect.orElseSucceed(fs.exists(file), () => false)
    if (!exists) return emptyConfig
    const text = yield* Effect.orElseSucceed(fs.readFileString(file), () => "")
    return Result.getOrUndefined(SchemaParser.decodeUnknownResult(Schema.fromJsonString(JoggleConfig))(text)) ?? emptyConfig
  })
