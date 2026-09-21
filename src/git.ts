import { Context, Effect, Layer, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { GitError } from "./schema.ts"

/**
 * The git base a scoped run is measured against.
 *
 * Two spellings of one idea: `since` is any revision the caller already knows
 * (`origin/main`, a tag, a SHA), and `pr` is a pull request whose base branch
 * git resolves through `gh`. The second is sugar over the first -- the report
 * is always built from the files on disk, never from the remote.
 */
export interface ChangedOptions {
  readonly since?: string | undefined
  /**
   * A pull request number or URL. The empty string is the current branch's
   * pull request, which is the common case and not a value the lexer can
   * express as "present but empty".
   */
  readonly pr?: string | undefined
}

export interface Interface {
  /**
   * Root-relative paths that differ from the base, including uncommitted work.
   *
   * The union of the branch diff and the working tree is deliberate: a person
   * cuts a PR and then iterates on it, and the second pass must see the edit
   * they just made, not only what they have committed.
   */
  readonly changedFiles: (
    cwd: string,
    options: ChangedOptions,
  ) => Effect.Effect<ReadonlyArray<string>, GitError, ChildProcessSpawner>
}

export class Service extends Context.Service<Service, Interface>()("@joggle/Git") {}

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
/* -------------------------------------------------------------------------- */

const lines = (text: string): ReadonlyArray<string> =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

/**
 * One subprocess, stdout or a typed failure.
 *
 * A non-zero exit is the failure the caller cares about, and its own stderr is
 * the message -- "fatal: not a git repository" is more useful than anything this
 * could invent. The binary being absent is the same shape of failure.
 */
const command = (
  binary: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<string, GitError, ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(binary, [...args], { cwd })
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      )
      if (Number(exitCode) !== 0) {
        return yield* Effect.fail(
          new GitError({
            operation: `${binary} ${args.join(" ")}`,
            detail: stderr.trim() === "" ? `exited with code ${Number(exitCode)}` : stderr.trim(),
          }),
        )
      }
      return stdout
    }),
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof GitError
        ? cause
        : new GitError({
            operation: `${binary} ${args.join(" ")}`,
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
    ),
  )

/** Whether a ref exists, without the failure of a missing one. */
const resolves = (input: {
  readonly cwd: string
  readonly ref: string
}): Effect.Effect<boolean, GitError, ChildProcessSpawner> =>
  command("git", ["rev-parse", "--verify", "--quiet", input.ref], input.cwd).pipe(
    Effect.map(() => true),
    Effect.orElseSucceed(() => false),
  )

/**
 * The ref a pull request forked from.
 *
 * `gh` answers which branch the PR targets; git answers whether that branch is
 * already a local remote-tracking ref. Fetching is the last resort, so a PR run
 * on an up-to-date checkout costs no network.
 */
const prRef = (
  cwd: string,
  pr: string | undefined,
): Effect.Effect<string, GitError, ChildProcessSpawner> =>
  Effect.gen(function* () {
    const args =
      pr === undefined
        ? ["pr", "view", "--json", "baseRefName", "--jq", ".baseRefName"]
        : ["pr", "view", pr, "--json", "baseRefName", "--jq", ".baseRefName"]
    const base = (yield* command("gh", args, cwd)).trim()
    if (base === "") {
      return yield* Effect.fail(
        new GitError({ operation: "gh pr view", detail: "the pull request has no base branch" }),
      )
    }
    const origin = `origin/${base}`
    if (yield* resolves({ cwd, ref: origin })) return origin
    if (yield* resolves({ cwd, ref: base })) return base
    yield* command("git", ["fetch", "origin", base], cwd)
    return "FETCH_HEAD"
  })

const changedFiles = Effect.fn("Git.changedFiles")(function* (
  cwd: string,
  options: ChangedOptions,
) {
  const base =
    options.pr !== undefined
      ? yield* prRef(cwd, options.pr === "" ? undefined : options.pr)
      : options.since
  if (base === undefined) return []

  // Three dots by hand: the merge base is where the branch forked, so the diff
  // is the PR's own work rather than every commit main has gained since. A ref
  // with no common history (a fresh shallow clone, a squashed import) falls back
  // to itself, which is the best answer git can give.
  const mergeBase = yield* command("git", ["merge-base", base, "HEAD"], cwd).pipe(
    Effect.map((output) => lines(output)[0] ?? base),
    Effect.orElseSucceed(() => base),
  )

  const tracked = yield* command(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", "--relative", mergeBase],
    cwd,
  )
  // A file the work just created is untracked, and a new duplicate most often
  // arrives in one. `--exclude-standard` keeps .gitignore's word.
  const untracked = yield* command("git", ["ls-files", "--others", "--exclude-standard"], cwd)
  return [...new Set([...lines(tracked), ...lines(untracked)])].sort((left, right) =>
    left.localeCompare(right),
  )
})

const make = (): Interface => ({ changedFiles })

export const layer: Layer.Layer<Service> = Layer.succeed(Service, make())
