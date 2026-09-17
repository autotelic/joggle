import { Cause, Config, Effect, Exit, Layer, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { NodeServices } from "@effect/platform-node"
import { runCheck } from "./check.ts"
import { layer as judgeLayer } from "./judge.ts"
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
    format: Flag.Literals("format", ["text", "json", "github"]).pipe(Flag.withDefault("text")),
    maxWarnings: Flag.Int("max-warnings").pipe(Flag.withDefault(-1)),
    typecheck: Flag.Boolean("typecheck").pipe(Flag.withDefault(false)),
    offline: Flag.Boolean("offline").pipe(Flag.withDefault(false)),
    noTsgo: Flag.Boolean("no-tsgo").pipe(Flag.withDefault(false)),
    cacheDir: Flag.String("cache-dir").pipe(Flag.optional),
    cwd: Flag.String("cwd").pipe(Flag.optional),
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

      const report = yield* runCheck({
        cwd,
        paths: config.paths,
        rules,
        typecheck: config.typecheck,
        useTsgo: !config.noTsgo,
        cacheDirExplicit: Option.isSome(config.cacheDir),
      }).pipe(
        Effect.provide(judgeLayer({ cacheDir, offline: config.offline, apiKey })),
        Effect.provide(tsgoLayer(cwd)),
      )

      yield* write(render(report, config.format))
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
Effect.runPromiseExit(program).then((exit) => {
  if (Exit.isSuccess(exit)) return
  process.stderr.write(`${Cause.pretty(exit.cause)}\n`)
  process.exitCode = 1
})
