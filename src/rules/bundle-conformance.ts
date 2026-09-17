import { Effect } from "effect"
import {
  blocksIn,
  findBundles,
  orphanBlocks,
  TRIPARTITE,
  unexportedBlocks,
  type Bundle,
} from "../bundles.ts"
import { bundleNote, defineRule, finding, inScope, outcome, type Scope } from "../rule.ts"
import type { Diagnostic, Severity } from "../schema.ts"
import type { Workspace } from "../workspace.ts"

/**
 * The composition pattern's PRODUCER rules: is a bundle well formed?
 *
 * These four are provable from structure alone -- a call, an element name, the
 * keys of an object literal, the files in a directory -- so they run with no
 * model, no tokens and no budget, and they can be exhaustive. Shakti has 21
 * bundles; checking all of them costs milliseconds.
 *
 * They are separate rules rather than one because the units and the severities
 * differ: an index promising a block no file declares is a defect, while a
 * bundle whose context value carries an extra key is a nit. Collapsing them into
 * one question would hide six judgments behind one answer.
 */

interface Spec {
  readonly id: string
  readonly severity: Severity
  readonly description: string
  /** What is wrong with this bundle, if anything. */
  readonly problems: (bundle: Bundle) => ReadonlyArray<string>
  /** How to describe the bundle in the message. */
  readonly subject: (bundle: Bundle) => string
}

const ruleFor = (spec: Spec) =>
  defineRule({
    id: spec.id,
    severity: spec.severity,
    description: spec.description,
    judged: false,
    run: Effect.fn(`joggle/${spec.id}`)(function* (workspace: Workspace, scope: Scope) {
      const bundles = findBundles(workspace).filter((bundle) => inScope(scope, bundle.dir))
      const diagnostics: Array<Diagnostic> = []
      for (const bundle of bundles) {
        const problems = spec.problems(bundle)
        if (problems.length === 0) continue
        diagnostics.push(
          finding({
            ruleId: spec.id,
            severity: spec.severity,
            message: `${spec.subject(bundle)}: ${problems.length} problem(s) with the composition pattern.`,
            help: problems.join("; "),
            location: { file: bundle.indexFile?.path ?? bundle.dir, line: 1, column: 1 },
            identity: [spec.id, bundle.dir].join("\u0000"),
            judged: false,
          }),
        )
      }
      return outcome(diagnostics, bundleNote(bundles.length, diagnostics.length))
    }),
  })

const blockFiles = (bundle: Bundle): ReadonlyArray<string> =>
  bundle.blocks.map((file) => file.path)

/** 1. The index must export the blocks under one name, by dot notation. */
export const dotNotationExport = ruleFor({
  id: "joggle/bundle-dot-notation",
  severity: "warn",
  description: "A composition bundle whose index does not export its blocks by dot notation.",
  subject: (bundle) => `${bundle.name} (${bundle.dir})`,
  problems: (bundle) => {
    if (bundle.indexFile === undefined) {
      return [`no index file, so there is no \`${bundle.name}.Block\` to import`]
    }
    if (bundle.dotExportKeys.length === 0) {
      return [
        `index exports named symbols instead of one object; the pattern wants \`export const ${bundle.name} = { Provider, ... }\``,
      ]
    }
    const missing = unexportedBlocks(bundle)
    const orphans = orphanBlocks(bundle)
    const problems: Array<string> = []
    if (missing.length > 0) problems.push(`index exports ${missing.join(", ")} but no block declares them`)
    if (orphans.length > 0) problems.push(`blocks not exported by the index: ${orphans.join(", ")}`)
    return problems
  },
})

/** 2. The provider's context value must be exactly state / actions / meta. */
export const tripartiteValue = ruleFor({
  id: "joggle/bundle-tripartite-value",
  severity: "warn",
  description: "A composition bundle whose context value is not { state, actions, meta }.",
  subject: (bundle) => `${bundle.name} (${bundle.dir})`,
  problems: (bundle) => {
    if (bundle.providerFile === undefined) {
      return ["no file renders a Provider, so the blocks have no composition root"]
    }
    const keys = bundle.providerValueKeys
    if (keys === undefined) {
      return [`${bundle.providerFile.path} passes no object with \`state\` and \`actions\` as the context value`]
    }
    const present = TRIPARTITE.filter((key) => keys.includes(key))
    const extra = keys.filter((key) => !TRIPARTITE.includes(key))
    const problems: Array<string> = []
    if (present.length < TRIPARTITE.length) {
      const missing = TRIPARTITE.filter((key) => !keys.includes(key))
      problems.push(`context value is missing ${missing.join(", ")}`)
    }
    if (extra.length > 0) problems.push(`context value carries ${extra.join(", ")}, which belongs inside state, actions or meta`)
    return problems
  },
})

/** 3. One file per block, and no orphans in either direction. */
export const oneFilePerBlock = ruleFor({
  id: "joggle/bundle-one-file-per-block",
  severity: "warn",
  description: "A composition bundle that does not keep one block per file.",
  subject: (bundle) => `${bundle.name} (${bundle.dir})`,
  problems: (bundle) => {
    const problems: Array<string> = []
    for (const file of bundle.blocks) {
      const names = blocksIn(file)
      if (names.length > 1) {
        problems.push(`${file.path} declares ${names.length} exported blocks (${names.join(", ")}); the pattern is one per file`)
      }
    }
    if (bundle.blocks.length === 0) problems.push("no block files: a bundle needs at least one")
    if (problems.length === 0 && blockFiles(bundle).length > 0 && bundle.dotExportKeys.length === 0) {
      problems.push("blocks exist but the index exports nothing")
    }
    return problems
  },
})

/** 4. The bundle's hook must read the context and refuse to work outside it. */
export const contextHook = ruleFor({
  id: "joggle/bundle-context-hook",
  severity: "warn",
  description: "A composition bundle with no hook, or a hook that does not read the context.",
  subject: (bundle) => `${bundle.name} (${bundle.dir})`,
  problems: (bundle) => {
    if (bundle.hookNames.length === 0) {
      return [`no \`use${bundle.name}\` hook, so blocks cannot read the context without importing it directly`]
    }
    const readsContext = bundle.hookFiles.some((file) =>
      file.facts.calls.some((call) => call === "useContext" || call.endsWith(".useContext")),
    )
    if (!readsContext) {
      return [`${bundle.hookNames.join(", ")} does not call \`useContext\`, so it is not the bundle's context hook`]
    }
    return []
  },
})

export const bundleRules = [dotNotationExport, tripartiteValue, oneFilePerBlock, contextHook]
