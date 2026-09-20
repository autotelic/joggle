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
export const machineCacheRoot = (): string => {
  const home = process.env["HOME"] ?? "."
  const xdg = process.env["XDG_CACHE_HOME"]
  if (xdg !== undefined && xdg !== "") return xdg
  return process.platform === "darwin" ? `${home}/Library/Caches` : `${home}/.cache`
}

/** A machine-local directory for one analysed root. */
export const runCacheDirFor = (root: string): string =>
  `${machineCacheRoot()}/joggle/${shortHash(root)}`
