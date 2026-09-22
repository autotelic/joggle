import { Cause, Config, Console, Effect, Exit, Layer, Option, Path, Predicate, Runtime } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { runCheck } from "./check.ts"
import { layer as decisionLayer } from "./decision.ts"
import { ask } from "./ask.ts"
import { runCacheDirFor } from "./state.ts"
import { loadConfig, isEnabled, severityFor } from "./config.ts"
import { layer as gitLayer, Service as Git } from "./git.ts"
import { loadPlugins, withDefaults } from "./plugins.ts"
import { policy } from "./policy.ts"
import { exitCodeFor, render } from "./report.ts"
import { loadWorkspace } from "./workspace.ts"
import { allRules, builtIn, Rules } from "./rules/index.ts"
import { layerFromConfig as tsgoLayer } from "./tsgo.ts"

/**
 * One report, through Effect's Console rather than a raw stdout write.
 *
 * `Console.log` appends the newline, so a body that already ends in one is
 * trimmed first; the output is byte-identical and a test can capture it.
 */
const write = (text: string): Effect.Effect<void> =>
  Console.log(text.endsWith("\n") ? text.slice(0, -1) : text)

/**
 * The repository's rule set: its config, its plugins, and the layer the run
 * reads.
 *
 * One function so `check` and `rules` cannot disagree about what is enforced.
 * They did: `rules` listed the built-ins while `check` ran the configured
 * preset, which is the one output a reader uses to answer "what is enforced".
 */
const ruleSetFor = (cwd: string, configFile: string | undefined) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const settings = yield* loadConfig(path.resolve(cwd, configFile ?? "joggle.config.json"))
    const loaded = yield* loadPlugins(
      [...(settings.presets ?? []), ...(settings.plugins ?? [])],
      cwd,
    )
    // A preset's severities and scoping sit under the repository's own, per rule:
    // enabling twenty opinions and then turning one off should not mean
    // restating the other nineteen.
    const effective = withDefaults(loaded.config, settings)
    // The repository's rules join the built-in ones here, once, so the run
    // itself reads one rule set from the context and never sees a plugin.
    return {
      settings,
      loaded,
      effective,
      rules: [...allRules, ...loaded.rules],
      layer: Layer.succeed(Rules, [...allRules, ...loaded.rules]),
    }
  })

const check = Command.make(
  "check",
  {
    paths: Argument.String("paths").pipe(
      Argument.withDescription(
        "Files or directories to analyse. Default: whatever tsgo says the project is.",
      ),
      Argument.variadic(),
    ),
    rule: Flag.String("rule").pipe(
      Flag.withDescription("Only run these rule ids, comma-separated."),
      Flag.optional,
    ),
    format: Flag.Literals("format", ["text", "stylish", "unix", "json", "github"]).pipe(
      Flag.withDescription("How to render the report."),
      Flag.withDefault("text"),
    ),
    maxWarnings: Flag.Int("max-warnings").pipe(
      Flag.withDescription("Exit non-zero when warnings exceed this count (-1 disables)."),
      Flag.withDefault(-1),
    ),
    typecheck: Flag.Boolean("typecheck").pipe(
      Flag.withDescription("Include tsgo's own diagnostics as joggle/typecheck."),
      Flag.withDefault(false),
    ),
    types: Flag.Boolean("types").pipe(
      Flag.withDescription("Resolve declaration types through tsgo's trace (enables type-aware rules)."),
      Flag.withDefault(false),
    ),
    maxTokens: Flag.Int("max-tokens").pipe(
      Flag.withDescription("Input-token budget for judgement in this run."),
      Flag.withDefault(policy.decision.maxInputTokens),
    ),
    offline: Flag.Boolean("offline").pipe(
      Flag.withDescription("Answer only from the committed judgement cache; never call the model."),
      Flag.withDefault(false),
    ),
    noTsgo: Flag.Boolean("no-tsgo").pipe(
      Flag.withDescription("Never invoke tsgo; walk the paths on disk instead."),
      Flag.withDefault(false),
    ),
    noReplay: Flag.Boolean("no-replay").pipe(
      Flag.withDescription("Do not reuse the stored run when nothing changed."),
      Flag.withDefault(false),
    ),
    changed: Flag.Boolean("changed").pipe(
      Flag.withDescription("Scope to files changed since the stored run (machine-local)."),
      Flag.withDefault(false),
    ),
    since: Flag.String("since").pipe(
      Flag.withDescription("Scope to files changed since a git revision (for example origin/main)."),
      Flag.optional,
    ),
    pr: Flag.Boolean("pr").pipe(
      Flag.withDescription("Scope to the pull request for the current branch."),
      Flag.withDefault(false),
    ),
    prNumber: Flag.String("pr-number").pipe(
      Flag.withDescription("Scope to a specific pull request, by number or URL."),
      Flag.optional,
    ),
    baseline: Flag.String("baseline").pipe(
      Flag.withDescription("Report only findings not already accepted in this baseline file."),
      Flag.optional,
    ),
    updateBaseline: Flag.String("update-baseline").pipe(
      Flag.withDescription("Write the current findings to this file as the accepted baseline."),
      Flag.optional,
    ),
    cacheDir: Flag.String("cache-dir").pipe(
      Flag.withDescription("Where the committed answer cache lives (default <cwd>/.joggle)."),
      Flag.optional,
    ),
    cwd: Flag.String("cwd").pipe(
      Flag.withDescription("Project root to analyse (default: the current directory)."),
      Flag.optional,
    ),
    config: Flag.String("config").pipe(
      Flag.withDescription("Config file, relative to the project root (default joggle.config.json)."),
      Flag.optional,
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      // Absolute at the boundary. Everything downstream compares paths -- tsgo's
      // file list against the root, git's changed files against the workspace --
      // and a relative root makes those comparisons fail quietly.
      const cwd = path.resolve(Option.getOrUndefined(config.cwd) ?? process.cwd())
      const cacheDir = Option.getOrUndefined(config.cacheDir) ?? path.join(cwd, ".joggle")
      const apiKey = yield* Config.option(Config.String("TYPESAFE_API_KEY"))
      const ruleFlag = Option.getOrUndefined(config.rule)
      const rules =
        ruleFlag === undefined
          ? undefined
          : ruleFlag
              .split(",")
              .map((id) => id.trim())
              .filter((id) => id.length > 0)

      // Relative to the analysed root, so a config travels with the repository it
      // describes rather than with the shell that invoked the tool.
      const ruleSet = yield* ruleSetFor(cwd, Option.getOrUndefined(config.config))
      const { loaded, effective } = ruleSet
      const rulesLayer = ruleSet.layer

      // The git base, resolved before the run so the engine never has to know
      // about git. `--pr` wins when both are given: it is the more specific
      // question, and its answer already implies a base. An empty string is the
      // adapter's spelling of "the pull request for this branch".
      const since = Option.getOrUndefined(config.since)
      const prNumber = Option.getOrUndefined(config.prNumber)
      const git = yield* Git
      const gitScope =
        config.pr || prNumber !== undefined
          ? { pr: prNumber ?? "" }
          : since === undefined
            ? undefined
            : { since }
      const changedSet =
        gitScope === undefined ? undefined : yield* git.changedFiles(cwd, gitScope)
      const changedPaths = changedSet?.changed
      const movedPaths = changedSet?.moved
      const changedBase =
        gitScope === undefined
          ? undefined
          : gitScope.pr !== undefined
            ? gitScope.pr === ""
              ? "the current branch's pull request"
              : "PR " + gitScope.pr
            : gitScope.since

      // The machine cache holds the run cache and the wire cache. The
      // per-decision answer cache in `cacheDir` is the one CI replays.
      const machineCache = yield* runCacheDirFor(cwd)

      const report = yield* runCheck({
        config: effective,
        plugins: loaded,
        cwd,
        paths: config.paths,
        rules,
        typecheck: config.typecheck,
        types: config.types ? "trace" : "off",
        maxInputTokens: config.maxTokens,
        useTsgo: !config.noTsgo,
        cacheDirExplicit: Option.isSome(config.cacheDir),
        cacheDir,
        // The run cache is machine-local on purpose: it is a performance
        // artifact, and a run should not write a report into a repository it is
        // only visiting.
        runCacheDir: machineCache,
        // A git-scoped run is never a replay: the stored report is the whole
        // repository, and the caller asked about a slice of it.
        replayUnchanged: !config.noReplay && changedPaths === undefined,
        changed: config.changed,
        changedPaths,
        movedPaths,
        changedBase,
        baselinePath: Option.getOrUndefined(config.baseline),
        updateBaselinePath: Option.getOrUndefined(config.updateBaseline),
      }).pipe(
        Effect.provide(rulesLayer),
        Effect.provide(decisionLayer({ cacheDir, wireCacheDir: machineCache, offline: config.offline, apiKey })),
        Effect.provide(tsgoLayer(cwd)),
      )

      yield* write(render(report, config.format, { color: process.stdout.isTTY === true }))
      yield* Effect.sync(() => {
        process.exitCode = exitCodeFor(report, config.maxWarnings)
      })
    }).pipe(Effect.provide(gitLayer)),
).pipe(
  Command.withDescription(
    "Report cross-file duplication and naming drift. With no paths, analyse the project tsgo sees. --since, --pr and --pr-number answer what a change introduced; --changed does the same against the last stored run.",
  ),
  Command.withShortDescription("Report cross-file duplication and naming drift."),
  Command.withExamples([
    { command: "joggle check", description: "Analyse the project tsgo sees." },
    {
      command: "joggle check src --format stylish",
      description: "Read findings for a directory, grouped by file.",
    },
    {
      command: "joggle check --pr",
      description: "Report only what this branch's pull request introduced.",
    },
    {
      command: "joggle check --since origin/main",
      description: "Report only what this branch introduced, from git.",
    },
    {
      command: "joggle check --offline",
      description: "Replay committed judgements; never call the model.",
    },
    { command: "joggle check --format github", description: "Emit GitHub Actions annotations." },
  ]),
)

const askCommand = Command.make(
  "ask",
  {
    query: Argument.String("query").pipe(
      Argument.withDescription('A question in prose, for example "where is the retry policy defined?".'),
    ),
    paths: Argument.String("paths").pipe(
      Argument.withDescription("Files or directories to rank against. Default: the whole project."),
      Argument.variadic(),
    ),
    cacheDir: Flag.String("cache-dir").pipe(
      Flag.withDescription("Where the committed answer cache lives (default <cwd>/.joggle)."),
      Flag.optional,
    ),
    maxTokens: Flag.Int("max-tokens").pipe(
      Flag.withDescription("Input-token budget; candidates are trimmed to fit and the request is halved if the provider still rejects it."),
      Flag.withDefault(policy.ask.maxInputTokens),
    ),
    cwd: Flag.String("cwd").pipe(
      Flag.withDescription("Project root to analyse (default: the current directory)."),
      Flag.optional,
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const cwd = path.resolve(Option.getOrUndefined(config.cwd) ?? process.cwd())
      const cacheDir = Option.getOrUndefined(config.cacheDir) ?? path.join(cwd, ".joggle")
      const apiKey = yield* Config.option(Config.String("TYPESAFE_API_KEY"))
      const workspace = yield* loadWorkspace(cwd, config.paths.length > 0 ? config.paths : ["."])
      const answer = yield* ask(workspace, config.query, { maxInputTokens: config.maxTokens }).pipe(
        Effect.provide(
          decisionLayer({
            cacheDir,
            wireCacheDir: yield* runCacheDirFor(cwd),
            offline: false,
            apiKey,
          }),
        ),
      )
      yield* write(
        [
          answer.exists.toFixed(2) +
            " that the code answers this; " +
            answer.considered +
            " declaration(s) ranked",
          ...answer.matches.map(
            (match) =>
              match.score.toFixed(3) +
              "  " +
              match.path +
              ":" +
              match.line +
              "  " +
              match.symbol +
              " (" +
              match.kind +
              ")",
          ),
        ].join("\n"),
      )
    }),
).pipe(
  Command.withDescription("Ask a question about the code; rank the declarations that answer it."),
  Command.withShortDescription("Rank declarations that answer a question."),
  Command.withExamples([
    {
      command: 'joggle ask "where is the retry policy defined?"',
      description: "Rank the declarations that answer a question.",
    },
  ]),
)

const rules = Command.make(
  "rules",
  {
    cwd: Flag.String("cwd").pipe(
      Flag.withDescription("Project root whose config to read (default: the current directory)."),
      Flag.optional,
    ),
    config: Flag.String("config").pipe(
      Flag.withDescription("Config file, relative to the project root (default joggle.config.json)."),
      Flag.optional,
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const cwd = path.resolve(Option.getOrUndefined(config.cwd) ?? process.cwd())
      // The same rule set the check runs, so this answers "what is enforced"
      // rather than "what ships".
      const ruleSet = yield* ruleSetFor(cwd, Option.getOrUndefined(config.config))
      const all = ruleSet.rules.filter((rule) => isEnabled(ruleSet.effective, rule.id, rule.severity))
      const width = all.reduce((max, rule) => Math.max(max, rule.id.length), 0)
      const lines = all.map(
        (rule) =>
          `${rule.id.padEnd(width)}  ${severityFor(ruleSet.effective, rule.id, rule.severity).padEnd(5)}  ${rule.judged ? "judged" : "static"}  ${rule.description}`,
      )
      // A plugin that failed to load is the difference between "not enforced"
      // and "silently absent", and this is the command that should say so.
      for (const failure of ruleSet.loaded.failures) {
        lines.push(`note: ${failure.specifier} was not loaded: ${failure.reason}`)
      }
      yield* write(lines.join("\n"))
    }),
).pipe(
  Command.withDescription("List the rules this repository enforces, with their severities."),
  Command.withShortDescription("List the enforced rules."),
  Command.withExamples([
    { command: "joggle rules", description: "What the current repository enforces." },
    {
      command: "joggle rules --cwd ../other-repo",
      description: "What another repository enforces.",
    },
  ]),
)

const cli = Command.make("joggle").pipe(
  Command.withDescription(
    "Cross-file patterns and idioms for TypeScript, enforced like a linter: deterministic where it can prove, System One where it has to judge.",
  ),
  Command.withExamples([
    {
      command: "joggle check --pr",
      description: "Check only what this branch's pull request changed.",
    },
    { command: "joggle check --since origin/main", description: "Check only what this branch changed." },
    { command: "joggle rules", description: "See what is enforced here." },
  ]),
  Command.withSubcommands([check, askCommand, rules]),
)

const services = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, builtIn)

const program = Command.run(cli, { version: policy.version }).pipe(Effect.provide(services))

/**
 * Never fail silently. A typed failure, an interruption and a defect all have
 * to reach stderr with enough detail to act on. This is a CI gate, and a gate
 * that exits non-zero without saying why is worse than no gate at all.
 */
/**
 * A typed failure deserves a sentence, not a stack.
 *
 * `Cause.pretty` prints the operation, the cause and the whole trace, which is
 * right for a defect and wrong for "you did not pass a path": the one line that
 * matters ends up buried under the machinery that produced it.
 */
const describeFailure = (failure: unknown): string | undefined => {
  if (typeof failure !== "object" || failure === null) return undefined
  const record = failure as Record<string, unknown>
  const tag = record["_tag"]
  if (tag === "joggle/WorkspaceError") {
    const cause = record["cause"]
    const detail = cause instanceof Error ? cause.message : String(cause ?? "")
    return String(record["operation"]) + ": " + detail
  }
  // Git and tsgo already carry the one sentence that matters: the command and
  // what it said. A stack trace here buries it.
  if (tag === "joggle/GitError" || tag === "joggle/TsgoError") {
    return String(record["operation"]) + ": " + String(record["detail"] ?? "")
  }
  // Any other typed failure -- AiError, ConfigError -- has a message, and that
  // sentence is what a person needs. The stack is for a defect.
  if (Predicate.isString(record["message"]) && record["message"] !== "") {
    return record["message"]
  }
  return undefined
}

/**
 * One sentence for a typed failure, and the runtime owns the rest.
 *
 * `NodeRuntime.runMain` sets the exit code, handles Ctrl+C, and runs finalizers.
 * The teardown only has to say WHY, and to keep a success's own exit code -- the
 * lint gate writes one into `process.exitCode`.
 */
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isSuccess(exit)) {
    onExit(Predicate.isNumber(process.exitCode) ? process.exitCode : 0)
    return
  }
  const failure = Cause.findErrorOption(exit.cause)
  const described = Option.isSome(failure) ? describeFailure(failure.value) : undefined
  process.stderr.write(described === undefined ? `${Cause.pretty(exit.cause)}\n` : `${described}\n`)
  onExit(1)
}

NodeRuntime.runMain(program, { disableErrorReporting: true, teardown })
