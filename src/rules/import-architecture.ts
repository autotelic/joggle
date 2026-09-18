import { Effect } from "effect"
import {
  cyclesIn,
  directionViolations,
  layerOf,
  layersFrom,
  purityViolations,
} from "../architecture.ts"
import { defineRule, finding, outcome, type Rule, type RunContext, type Scope } from "../rule.ts"
import type { Diagnostic } from "../schema.ts"
import type { ImportEdge } from "../imports.ts"
import type { SourceFile, Workspace } from "../workspace.ts"

const LAYER_RULE = "joggle/layer-direction"
const CYCLE_RULE = "joggle/import-cycle"
const PURITY_RULE = "joggle/layer-purity"

/**
 * The line an import statement sits on.
 *
 * The import graph carries specifiers but not positions, and a finding with no
 * position is a finding a reader has to go looking for. The specifier is unique
 * enough to find in the file that contains it, so the position is recovered
 * rather than threaded through the parser.
 */
const lineOf = (files: ReadonlyMap<string, SourceFile>, edge: ImportEdge): { line: number; column: number } => {
  const file = files.get(edge.from)
  if (file === undefined) return { line: 1, column: 1 }
  for (const quote of ['"', "'"]) {
    const needle = quote + edge.specifier + quote
    const index = file.text.indexOf(needle)
    if (index === -1) continue
    const before = file.text.slice(0, index)
    return {
      line: before.split("\n").length,
      column: index - before.lastIndexOf("\n"),
    }
  }
  return { line: 1, column: 1 }
}

const filesByPath = (workspace: Workspace): ReadonlyMap<string, SourceFile> =>
  new Map(workspace.files.map((file) => [file.path, file]))

/**
 * Dependencies point one way.
 *
 * Decidable from the import graph, so it needs no model, no key and no budget:
 * it runs on every repository that declares its layers, and every time.
 */
export const layerDirection = defineRule({
  id: LAYER_RULE,
  severity: "warn",
  description: "A module imports from a layer that sits above it.",
  judged: false,
  run: Effect.fn("joggle/layer-direction")(function* (
    workspace: Workspace,
    _scope: Scope,
    context: RunContext,
  ) {
    const layers = layersFrom(context.config)
    if (layers.length === 0) return outcome([])

    const violations = directionViolations(workspace.imports, layers)
    const files = filesByPath(workspace)
    const edgeAt = new Map(
      workspace.imports.edges.map((edge) => [edge.from + "\u0000" + edge.to, edge]),
    )

    const diagnostics = violations.flatMap((violation): ReadonlyArray<Diagnostic> => {
      const edge = edgeAt.get(violation.from + "\u0000" + violation.to)
      if (edge === undefined) return []
      return [
        finding({
          ruleId: LAYER_RULE,
          severity: "warn",
          message: `${violation.from} imports ${violation.to}, which sits in ${violation.toLayer} -- a layer above ${violation.fromLayer}.`,
          help: `joggle.config.json declares the layers bottom-up, so ${violation.fromLayer} may not depend on ${violation.toLayer}. Move the shared piece down, or invert the dependency by passing it in.`,
          location: { file: violation.from, ...lineOf(files, edge) },
          identity: [LAYER_RULE, violation.from, violation.to].join("\u0000"),
          judged: false,
        }),
      ]
    })

    // A file in no declared layer is not part of the architecture anyone
    // described, so it is counted rather than guessed at.
    const unranked = workspace.files.filter((file) => layerOf(layers, file.path) === undefined).length
    const ranked = workspace.files.length - unranked

    // The counts are in the note on purpose. "0 problems" is only falsifiable if
    // it says what it looked at: a layering where nothing matched looks exactly
    // like a layering where everything obeyed.
    return outcome(diagnostics, [
      `${violations.length} upward import(s) among ${ranked} ranked file(s) in ${layers.length} declared layer(s); ${unranked} file(s) in no layer`,
    ])
  }),
})

/**
 * No module cycles.
 *
 * Also decidable, and also free. A cycle is not a style opinion: it means two
 * modules cannot be understood, tested or loaded independently, which is the
 * one thing a layering exists to prevent.
 */
export const importCycle = defineRule({
  id: CYCLE_RULE,
  severity: "warn",
  description: "A module imports, directly or indirectly, from itself.",
  judged: false,
  run: Effect.fn("joggle/import-cycle")(function* (workspace: Workspace, _scope: Scope) {
    const cycles = cyclesIn(workspace.imports)
    // A loop made entirely of `import type` is erased at build time, so it cannot
    // cause the load-order problem this rule exists to catch. Named in the note
    // rather than dropped: it is still a wart, just not one that can break.
    const runtime = cycles.filter((cycle) => cycle.runtime)
    const named = cycles.filter((cycle) => !cycle.runtime)
    const erasedEntirely = named.filter((cycle) => cycle.typeOnly).length
    const partlyErased = named.length - erasedEntirely

    const diagnostics = runtime.map((cycle): Diagnostic => {
      const first = cycle.files[0] ?? ""
      return finding({
        ruleId: CYCLE_RULE,
        severity: "warn",
        message: `Import cycle: ${[...cycle.files, first].join(" -> ")}.`,
        help: "Break the loop by moving the shared piece below both modules, or by passing the dependency in.",
        location: { file: first, line: 1, column: 1 },
        identity: [CYCLE_RULE, ...[...cycle.files].sort()].join("\u0000"),
        judged: false,
      })
    })

    return outcome(diagnostics, [
      `${runtime.length} runtime cycle(s), ${erasedEntirely} type-only, ${partlyErased} partly erased, in ${workspace.imports.edges.length} import edge(s)`,
      ...named.map((cycle) =>
        cycle.typeOnly
          ? `type-only cycle, erased entirely at build time: ${cycle.files.join(" -> ")}`
          : `cycle with an erased edge, so broken before it loads: ${cycle.files.join(" -> ")}`,
      ),
    ])
  }),
})

export const layerPurity = defineRule({
  id: PURITY_RULE,
  severity: "warn",
  description: "A module imports something its layer forbids.",
  judged: false,
  run: Effect.fn("joggle/layer-purity")(function* (
    workspace: Workspace,
    _scope: Scope,
    context: RunContext,
  ) {
    const layers = layersFrom(context.config)
    const constrained = layers.filter((layer) => layer.forbid.length > 0)
    if (constrained.length === 0) return outcome([])

    const violations = purityViolations(workspace.imports, layers)
    const files = filesByPath(workspace)
    const edgeAt = new Map(
      workspace.imports.edges.map((edge) => [edge.from + "\u0000" + edge.specifier, edge]),
    )

    const diagnostics = violations.flatMap((violation): ReadonlyArray<Diagnostic> => {
      const edge = edgeAt.get(violation.from + "\u0000" + violation.specifier)
      if (edge === undefined) return []
      return [
        finding({
          ruleId: PURITY_RULE,
          severity: "warn",
          message:
            violation.from +
            " imports " +
            violation.specifier +
            ", which the " +
            violation.layer +
            " layer forbids.",
          help:
            "The " +
            violation.layer +
            " layer declares " +
            violation.pattern +
            " forbidden in joggle.config.json, so nothing inside it may reach for " +
            violation.specifier +
            ". Take what this needs as an argument, or move the file out of the layer.",
          location: { file: violation.from, ...lineOf(files, edge) },
          identity: [PURITY_RULE, violation.from, violation.specifier].join("\u0000"),
          judged: false,
        }),
      ]
    })

    return outcome(diagnostics, [
      violations.length +
        " forbidden import(s) across " +
        constrained.length +
        " constrained layer(s)",
    ])
  }),
})

export const importArchitectureRules: ReadonlyArray<Rule> = [
  layerDirection,
  layerPurity,
  importCycle,
]
