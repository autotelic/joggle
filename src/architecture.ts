import { matchesGlob, type JoggleConfig } from "./config.ts"
import type { ImportGraph } from "./imports.ts"

/**
 * A codebase's architecture, where it is decidable.
 *
 * Most of what people call architecture is a judgement: should this be a
 * provider, is this abstraction earning its keep. One part of it is not. The
 * direction of dependencies is a property of the import graph, it is decidable
 * with certainty, and it costs nothing to check -- so it is checked here, on
 * every run, with no model and no key, rather than argued about in review.
 *
 * That is the line between this tool and plumb, drawn at the point where a
 * claim stops being provable: one file's imports are provable, so they belong to
 * the deterministic half.
 */
export interface Layer {
  readonly name: string
  readonly include: ReadonlyArray<string>
  /** Position in the declared order. Lower is more depended-upon. */
  readonly rank: number
}

/**
 * Layers in declaration order, which is dependency order.
 *
 * The declaration lists from most depended-upon to least, so a later layer may
 * import an earlier one and never the reverse. Writing it that way means the
 * bottom of the architecture is the first thing a reader sees.
 */
export const layersFrom = (config: JoggleConfig): ReadonlyArray<Layer> =>
  (config.architecture?.layers ?? []).map((layer, rank) => ({
    name: layer.name,
    include: layer.include,
    rank,
  }))

export const layerOf = (
  layers: ReadonlyArray<Layer>,
  file: string,
): Layer | undefined => layers.find((layer) => layer.include.some((glob) => matchesGlob(glob, file)))

export interface DirectionViolation {
  readonly from: string
  readonly to: string
  readonly fromLayer: string
  readonly toLayer: string
}

/**
 * Imports that point back up the stack.
 *
 * A file in no declared layer is skipped rather than guessed at: it is not part
 * of the architecture anyone described, and inventing a rank for it would report
 * a rule nobody wrote. Foreign imports cannot violate a layering either -- a
 * package is outside the graph being described.
 */
export const directionViolations = (
  imports: ImportGraph,
  layers: ReadonlyArray<Layer>,
): ReadonlyArray<DirectionViolation> => {
  const violations: Array<DirectionViolation> = []
  for (const edge of imports.edges) {
    if (!edge.resolved || edge.from === edge.to) continue
    const source = layerOf(layers, edge.from)
    const target = layerOf(layers, edge.to)
    if (source === undefined || target === undefined) continue
    if (target.rank > source.rank) {
      violations.push({
        from: edge.from,
        to: edge.to,
        fromLayer: source.name,
        toLayer: target.name,
      })
    }
  }
  return violations.sort(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  )
}

/**
 * A cycle is the same cycle wherever the walk entered it, so rotate each one to
 * its lexicographically smallest member before deciding it is new. Without this
 * one three-module loop is reported three times, once per entry point.
 */
const canonicalCycle = (cycle: ReadonlyArray<string>): string => {
  let best: string | undefined
  for (let index = 0; index < cycle.length; index += 1) {
    const key = [...cycle.slice(index), ...cycle.slice(0, index)].join("\u0000")
    if (best === undefined || key < best) best = key
  }
  return best ?? ""
}

export interface Cycle {
  /** The loop, in walk order, without repeating the entry point. */
  readonly files: ReadonlyArray<string>
  /**
   * True when EVERY edge of the loop is a runtime import.
   *
   * This, and not "contains a runtime edge", is the test for a runtime cycle. A
   * loop is only in the runtime graph if all of it is: remove any single edge and
   * there is no loop left to load in the wrong order. So a loop with one erased
   * edge and one real edge is not a runtime cycle -- the erased edge breaks it
   * before the real one can close it.
   */
  readonly runtime: boolean
  /**
   * True when every edge is `import type`.
   *
   * The complement of a runtime cycle among loops that cannot break: such a loop
   * is erased entirely, so it is a wart in the source rather than a hazard in the
   * build. Still named, at the volume of a note rather than of a finding.
   */
  readonly typeOnly: boolean
}

/** Module cycles. Reported once per loop, not once per entry point. */
export const cyclesIn = (imports: ImportGraph): ReadonlyArray<Cycle> => {
  const adjacency = new Map<string, Array<string>>()
  /** Whether EVERY edge from one file to another is erased. */
  const erased = new Map<string, boolean>()
  for (const edge of imports.edges) {
    if (!edge.resolved || edge.from === edge.to) continue
    const existing = adjacency.get(edge.from)
    if (existing === undefined) adjacency.set(edge.from, [edge.to])
    else if (!existing.includes(edge.to)) existing.push(edge.to)
    const key = edge.from + "\u0000" + edge.to
    erased.set(key, (erased.get(key) ?? true) && edge.typeOnly)
  }

  const isErased = (from: string, to: string): boolean => erased.get(from + "\u0000" + to) === true

  const found: Array<Cycle> = []
  const seen = new Set<string>()
  const state = new Map<string, "visiting" | "done">()
  const trail: Array<string> = []

  const visit = (file: string): void => {
    const status = state.get(file)
    if (status === "done") return
    if (status === "visiting") {
      const start = trail.indexOf(file)
      if (start === -1) return
      const cycle = trail.slice(start)
      const key = canonicalCycle(cycle)
      if (!seen.has(key)) {
        seen.add(key)
        let typeOnly = true
        let runtime = true
        for (let index = 0; index < cycle.length; index += 1) {
          const from = cycle[index]
          const to = cycle[(index + 1) % cycle.length]
          if (from === undefined || to === undefined) continue
          if (isErased(from, to)) runtime = false
          else typeOnly = false
        }
        found.push({ files: cycle, runtime, typeOnly })
      }
      return
    }
    state.set(file, "visiting")
    trail.push(file)
    for (const next of adjacency.get(file) ?? []) visit(next)
    trail.pop()
    state.set(file, "done")
  }

  for (const file of adjacency.keys()) visit(file)
  return found
}
