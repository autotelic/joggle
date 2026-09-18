import { Cause, Config, Effect, Exit, Layer, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { NodeServices } from "@effect/platform-node"
import { runCheck } from "./check.ts"
import { layer as judgeLayer } from "./judge.ts"
import { runCacheDirFor } from "./state.ts"
import { loadConfig } from "./config.ts"
import { loadPlugins } from "./plugins.ts"
import { policy } from "./policy.ts"
import { exitCodeFor, render } from "./report.ts"
import { allRules } from "./rules/index.ts"
import { layerFromConfig as tsgoLayer } from "./tsgo.ts"

const write = (text: string): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`)
  })

const check = Command.make(
  "check",
  {
    paths: Argument.String("paths").pipe(Argument.variadic()),
    rule: Flag.String("rule").pipe(Flag.optional),
    format: Flag.Literals("format", ["text", "stylish", "unix", "json", "github"]).pipe(
      Flag.withDefault("text"),
    ),
    maxWarnings: Flag.Int("max-warnings").pipe(Flag.withDefault(-1)),
    typecheck: Flag.Boolean("typecheck").pipe(Flag.withDefault(false)),
    offline: Flag.Boolean("offline").pipe(Flag.withDefault(false)),
    noTsgo: Flag.Boolean("no-tsgo").pipe(Flag.withDefault(false)),
    noReplay: Flag.Boolean("no-replay").pipe(Flag.withDefault(false)),
    changed: Flag.Boolean("changed").pipe(Flag.withDefault(false)),
    baseline: Flag.String("baseline").pipe(Flag.optional),
    updateBaseline: Flag.String("update-baseline").pipe(Flag.optional),
    cacheDir: Flag.String("cache-dir").pipe(Flag.optional),
    cwd: Flag.String("cwd").pipe(Flag.optional),
    config: Flag.String("config").pipe(Flag.optional),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const cwd = Option.getOrUndefined(config.cwd) ?? process.cwd()
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
      const settings = yield* loadConfig(
        path.resolve(
          cwd,
          Option.getOrUndefined(config.config) ?? "joggle.config.json",
        ),
      )

      const loaded = yield* loadPlugins(settings.plugins ?? [], cwd)

      const report = yield* runCheck({
        config: settings,
        plugins: loaded,
        cwd,
        paths: config.paths,
        rules,
        typecheck: config.typecheck,
        useTsgo: !config.noTsgo,
        cacheDirExplicit: Option.isSome(config.cacheDir),
        cacheDir,
        // The run cache is machine-local on purpose: it is a performance
        // artifact, and a run should not write a report into a repository it is
        // only visiting.
        runCacheDir: runCacheDirFor(cwd),
        replayUnchanged: !config.noReplay,
        changed: config.changed,
        baselinePath: Option.getOrUndefined(config.baseline),
        updateBaselinePath: Option.getOrUndefined(config.updateBaseline),
      }).pipe(
        Effect.provide(
          judgeLayer({
            cacheDir,
            offline: config.offline,
            apiKey,
            evidenceContext: settings.evidence?.repository,
          }),
        ),
        Effect.provide(tsgoLayer(cwd)),
      )

      yield* write(render(report, config.format, { color: process.stdout.isTTY === true }))
      yield* Effect.sync(() => {
        process.exitCode = exitCodeFor(report, config.maxWarnings)
      })
    }),
).pipe(Command.withDescription("Report cross-file duplication and naming drift."))

const rules = Command.make(
  "rules",
  {},
  () =>
    Effect.gen(function* () {
      const width = allRules.reduce((max, rule) => Math.max(max, rule.id.length), 0)
      const lines = allRules.map(
        (rule) =>
          `${rule.id.padEnd(width)}  ${rule.severity.padEnd(5)}  ${rule.judged ? "judged" : "static"}  ${rule.description}`,
      )
      yield* write(lines.join("\n"))
    }),
).pipe(Command.withDescription("List the rules and what each one enforces."))

const cli = Command.make("joggle").pipe(
  Command.withDescription(
    "Cross-file patterns and idioms for TypeScript, enforced like a linter: deterministic where it can prove, System One where it has to judge.",
  ),
  Command.withSubcommands([check, rules]),
)

const services = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)

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
  if (tag === "joggle/JudgeUnavailable") return "judgement unavailable: " + String(record["reason"])
  if (tag === "joggle/JudgeRejected") {
    return "the judge refused the request: " + String(record["detail"])
  }
  return undefined
}

Effect.runPromiseExit(program).then((exit) => {
  if (Exit.isSuccess(exit)) return
  const failure = Cause.findErrorOption(exit.cause)
  const described = Option.isSome(failure) ? describeFailure(failure.value) : undefined
  process.stderr.write(described === undefined ? `${Cause.pretty(exit.cause)}\n` : `${described}\n`)
  process.exitCode = 1
})
