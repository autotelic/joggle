import { Config, Effect, Option } from "effect"
import { createHash } from "node:crypto"

/**
 * Where joggle's state lives, and how it is read back.
 *
 * Three artifacts, three lifecycles:
 *
 *   <root>/.joggle/judgements.json   reviewed, committed, replayed by CI
 *   <root>/.joggle/baseline.json     reviewed, committed: the ratchet
 *   <machine cache>/joggle/<root>/   ephemeral, machine-local, never committed
 *
 * The first two belong to the repository, because they are decisions a person
 * should be able to read in a diff and because CI replays them with no API key.
 * The third is a performance artifact -- a manifest, the last report, and the
 * per-file facts -- and it belongs to the machine: it is the largest, it churns
 * on every edit, and writing it into a working tree means analysing someone
 * else's checkout leaves litter in it.
 *
 * One machine cache serves every repository, keyed by the analysed root, so
 * pointing joggle at any number of checkouts costs no per-repo setup and writes
 * nothing into them.
 */

/** A short content hash, used for cache keys and manifests. */
export const shortHash = (value: string): string =>
  createHash("sha1").update(value).digest("hex").slice(0, 16)

/** The per-machine cache root, following the platform's convention. */
export const machineCacheRoot: Effect.Effect<string> = Effect.gen(function* () {
  const home = yield* Config.String("HOME").pipe(Effect.orElseSucceed(() => "."))
  const xdg = yield* Config.option(Config.String("XDG_CACHE_HOME")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  )
  const root = Option.getOrUndefined(xdg)
  if (root !== undefined && root !== "") return root
  return process.platform === "darwin" ? `${home}/Library/Caches` : `${home}/.cache`
}).pipe(Effect.orElseSucceed(() => "."))

/** A machine-local directory for one analysed root. */
export const runCacheDirFor = (root: string): Effect.Effect<string> =>
  Effect.map(machineCacheRoot, (base) => `${base}/joggle/${shortHash(root)}`)
