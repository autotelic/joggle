import { Effect, FileSystem, Path } from "effect"
import { safeJson, shortHash } from "./state.ts"
import { shinglesOf } from "./similarity.ts"
import { tokenize, type Parses, type SourceFile, type StructureFacts, type Unit } from "./workspace.ts"
import type { ParsedImport } from "./imports.ts"

/**
 * Parsing, as a cached unit of work keyed by its inputs.
 *
 * The idea is from a talk about Turbopack's incremental engine (docs/turbo.md):
 * every expensive operation becomes a cached unit whose key is derived from what
 * it reads, because "I don't really trust developers to write correct cache keys
 * or track inputs by hand".
 *
 * The measurement that justifies it: on one repository the whole-run fingerprint
 * meant any change at all re-parsed 2,456 files, and `read+parse` was 2.3 of the
 * 2.4 seconds the workspace took. A one-line edit cost 2.3 seconds to answer a
 * question about one file.
 *
 * A parse reads exactly two things -- the text of the file and the parser -- so
 * the key is exactly those two. The text comes from the call site, which already
 * has it; the parser is the tool's own fingerprint, checked when the cache is
 * opened. There is no third thing a parse could depend on.
 *
 * WHAT IS STORED, AND WHAT IS NOT. Only the ANALYSIS: the units, their imports
 * and the file's structural facts. Not the file's text, which the caller already
 * has in memory; not a unit's text, which is a slice of it; not a unit's tokens,
 * which are a function of its shape; and not its shingles, which are a function
 * of its tokens. The first version stored all of it and produced a 67 megabyte
 * cache for 2,456 files -- most of it the same bytes said four different ways.
 *
 * WHAT THIS DOES NOT DO. It is not a reactive graph. Turbopack tracks which cell
 * read which and propagates invalidation upward with early cutoff; this is one
 * layer of that idea, at the point where 96% of the time is. A dependency graph
 * over eight thousand units would cost more to maintain than it saves at this
 * size, and the talk is honest about the overheads -- memory, and "global
 * algorithms harm incrementality" -- that such a system brings with it.
 */
export const CACHE_VERSION = "1"

/** One parse's key: which file, and what it said. */
export const keyOf = (file: string, text: string): string =>
  file + "\u0000" + shortHash(text)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A unit minus everything derivable from the file's text. */
const encodeUnit = (unit: Unit): unknown => ({
  kind: unit.kind,
  name: unit.name,
  start: unit.start,
  end: unit.end,
  location: unit.location,
  exported: unit.exported,
  shape: unit.shape,
  shapeHash: unit.shapeHash,
  typeRefs: unit.typeRefs,
  typed: unit.typed,
  fields: unit.fields,
  fieldTypes: Object.fromEntries(unit.fieldTypes),
  test: unit.test,
  ...(unit.doc === undefined ? {} : { doc: unit.doc }),
})

/** What a cache entry holds: the analysis, with nothing the text could give back. */
interface Encoded {
  readonly units: ReadonlyArray<unknown>
  readonly imports: ReadonlyArray<ParsedImport>
  readonly facts: StructureFacts
}

const encodeSourceFile = (file: SourceFile): Encoded => ({
  units: file.units.map(encodeUnit),
  imports: file.imports,
  facts: file.facts,
})

/**
 * A cache entry that does not decode is ignored, not repaired.
 *
 * The cache is an optimisation, so a miss costs time and a WRONG hit costs
 * correctness. Every field a rule reads is checked, and anything unexpected means
 * the file is parsed again.
 */
const decodeUnit = (raw: unknown, file: string, text: string): Unit | undefined => {
  if (!isRecord(raw)) return undefined
  for (const field of ["kind", "name", "shape", "shapeHash"]) {
    if (typeof raw[field] !== "string") return undefined
  }
  for (const field of ["start", "end"]) if (typeof raw[field] !== "number") return undefined
  for (const field of ["exported", "typed", "test"]) {
    if (typeof raw[field] !== "boolean") return undefined
  }
  if (!isRecord(raw["location"])) return undefined
  for (const field of ["typeRefs", "fields"]) if (!Array.isArray(raw[field])) return undefined
  if (!isRecord(raw["fieldTypes"])) return undefined

  const start = raw["start"] as number
  const end = raw["end"] as number
  if (start < 0 || start > end || end > text.length) return undefined

  // Rebuilt, not stored: the text is a slice of the file, and the tokens and
  // shingles are functions of the shape.
  const shape = raw["shape"] as string
  const tokens = tokenize(shape)
  return {
    kind: raw["kind"] as Unit["kind"],
    name: raw["name"] as string,
    file,
    start,
    end,
    location: raw["location"] as Unit["location"],
    exported: raw["exported"] as boolean,
    text: text.slice(start, end),
    shape,
    tokens,
    shingles: shinglesOf(tokens),
    shapeHash: raw["shapeHash"] as string,
    typeRefs: raw["typeRefs"] as ReadonlyArray<string>,
    typed: raw["typed"] as boolean,
    fields: raw["fields"] as ReadonlyArray<string>,
    fieldTypes: new Map(
      Object.entries(raw["fieldTypes"] as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    test: raw["test"] as boolean,
    // Resolved after every file is parsed, so a cached value is always rewritten.
    typeSignature: "",
    doc: typeof raw["doc"] === "string" ? raw["doc"] : undefined,
  }
}

const decodeSourceFile = (raw: unknown, file: string, text: string): SourceFile | undefined => {
  if (!isRecord(raw)) return undefined
  if (!Array.isArray(raw["units"]) || !Array.isArray(raw["imports"])) return undefined
  if (!isRecord(raw["facts"])) return undefined
  const units: Array<Unit> = []
  for (const entry of raw["units"]) {
    const unit = decodeUnit(entry, file, text)
    if (unit === undefined) return undefined
    units.push(unit)
  }
  return {
    path: file,
    text,
    units,
    imports: raw["imports"] as ReadonlyArray<ParsedImport>,
    facts: raw["facts"] as unknown as StructureFacts,
  }
}

export interface ParseCache {
  readonly parses: Parses
  readonly save: Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>
}

/**
 * The cache on disk, discarded whole when the tool's own source has changed.
 *
 * The parser is part of the tool, so an entry produced by a different parser is
 * not a cache hit -- it is a wrong answer. That is the same reasoning as the run
 * manifest, applied to the operation that dominates the run.
 */
export const loadParses = (
  cacheDir: string,
  tool: string,
): Effect.Effect<ParseCache, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const store = path.join(cacheDir, "parses.json")

    // The map holds the ENCODED form, so saving serializes what is already there
    // rather than walking every unit a second time to write it out.
    const entries = new Map<string, Encoded>()
    const exists = yield* Effect.orElseSucceed(fs.exists(store), () => false)
    if (exists) {
      const body = yield* Effect.orElseSucceed(fs.readFileString(store), () => "")
      const decoded = safeJson(body)
      if (
        isRecord(decoded) &&
        decoded["version"] === CACHE_VERSION &&
        decoded["tool"] === tool &&
        isRecord(decoded["entries"])
      ) {
        for (const [key, value] of Object.entries(decoded["entries"])) {
          if (isRecord(value) && Array.isArray(value["units"]) && Array.isArray(value["imports"])) {
            entries.set(key, value as unknown as Encoded)
          }
        }
      }
    }

    let hits = 0
    let misses = 0
    const parses: Parses = {
      get: (relative, text) => {
        const stored = entries.get(keyOf(relative, text))
        // Decoded against the text the CALLER has, which is the whole reason the
        // text is not in the cache: it is already here.
        const rebuilt = stored === undefined ? undefined : decodeSourceFile(stored, relative, text)
        if (rebuilt === undefined) {
          misses += 1
          return undefined
        }
        hits += 1
        return rebuilt
      },
      set: (relative, text, parsed) => {
        entries.set(keyOf(relative, text), encodeSourceFile(parsed))
      },
      hits: () => hits,
      misses: () => misses,
    }

    return {
      parses,
      // Only when something was parsed. A run that read twenty thousand entries
      // and wrote them all back is a run where the cache costs more than it saves.
      save: Effect.gen(function* () {
        if (misses === 0) return
        const body = JSON.stringify({
          version: CACHE_VERSION,
          tool,
          entries: Object.fromEntries(entries),
        })
        yield* Effect.orElseSucceed(fs.makeDirectory(cacheDir, { recursive: true }), () => undefined)
        yield* Effect.orElseSucceed(fs.writeFileString(store, body), () => undefined)
      }),
    }
  })
