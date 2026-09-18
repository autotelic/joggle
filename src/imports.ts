import type { Path } from "effect"
import type { SourceFile } from "./workspace.ts"

/** One import or re-export statement, before resolution. */
export interface ParsedImport {
  readonly specifier: string
  /** Names taken from the target. Empty for a side-effect import. */
  readonly names: ReadonlyArray<string>
  /**
   * `import type` and `export type` are erased at build time.
   *
   * Worth recording because it is the difference between a cycle that cannot
   * exist at runtime and one that can: a type-only edge leaves no module
   * initialisation behind, so a loop through it has no load-order consequence.
   * Reporting both at the same volume is how a linter trains people to ignore it.
   */
  readonly typeOnly: boolean
}

/**
 * One resolved import: everything the statement said, plus where it went.
 *
 * Composed rather than re-listed, which is what `joggle/compose-types` reported
 * against this file. The three fields it shares with `ParsedImport` are the same
 * three with the same declarations, so repeating them is a second place to change
 * `typeOnly` and a second chance to disagree about it.
 */
export interface ImportEdge extends ParsedImport {
  /** Importing file, workspace-relative. */
  readonly from: string
  /** Resolved workspace-relative path, or the raw specifier when unresolved. */
  readonly to: string
  readonly resolved: boolean
}

export interface ImportGraph {
  readonly edges: ReadonlyArray<ImportEdge>
  /** workspace-relative path -> the files that import it. */
  readonly importersOf: ReadonlyMap<string, ReadonlyArray<ImportEdge>>
  /** Importers that name a specific export of a file. */
  readonly importersOfName: (file: string, name: string) => ReadonlyArray<ImportEdge>
  /** How many edge specifiers could not be resolved. Reported, never hidden. */
  readonly unresolved: number
}

const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", "/index.ts", "/index.tsx"]

/**
 * Resolve a specifier against the files we actually analysed.
 *
 * Relative specifiers resolve exactly. Anything else is treated as a bundler
 * root alias and resolved by walking up from the importing file, which is how
 * `~/utils` behaves in this codebase and needs no tsconfig, no plugin config and
 * no extra filesystem calls. A package specifier fails to resolve, which is
 * correct: we cannot fix a file we did not analyse.
 */
export const resolveSpecifier = (
  from: string,
  specifier: string,
  known: ReadonlySet<string>,
  path: Path.Path,
): string | undefined => {
  const bases: Array<string> = []
  if (specifier.startsWith(".")) {
    bases.push(path.join(path.dirname(from), specifier))
  } else if (!specifier.startsWith("/")) {
    // `~/x` and `@/x` mean "from the project root"; strip the sigil and let the
    // walk-up find which ancestor directory it is rooted at.
    const trimmed =
      specifier.startsWith("~/") || specifier.startsWith("@/")
        ? specifier.slice(2)
        : specifier
    let directory = path.dirname(from)
    for (let depth = 0; depth < 8; depth += 1) {
      bases.push(path.join(directory, trimmed))
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  for (const base of bases) {
    for (const extension of EXTENSIONS) {
      const candidate = base + extension
      if (known.has(candidate)) return candidate
    }
  }
  return undefined
}

export const buildImportGraph = (
  files: ReadonlyArray<SourceFile>,
  path: Path.Path,
): ImportGraph => {
  const known = new Set(files.map((file) => file.path))
  const edges: Array<ImportEdge> = []
  let unresolved = 0

  for (const file of files) {
    for (const statement of file.imports) {
      const target = resolveSpecifier(file.path, statement.specifier, known, path)
      if (target === undefined) unresolved += 1
      edges.push({
        from: file.path,
        specifier: statement.specifier,
        to: target ?? statement.specifier,
        resolved: target !== undefined,
        names: statement.names,
        typeOnly: statement.typeOnly,
      })
    }
  }

  const importersOf = new Map<string, Array<ImportEdge>>()
  for (const edge of edges) {
    if (!edge.resolved) continue
    const existing = importersOf.get(edge.to)
    if (existing === undefined) importersOf.set(edge.to, [edge])
    else existing.push(edge)
  }

  return {
    edges,
    importersOf,
    importersOfName: (file, name) =>
      (importersOf.get(file) ?? []).filter((edge) => edge.names.includes(name)),
    unresolved,
  }
}

/** Statements that introduce or forward a module binding. */
export const importsIn = (program: Record<string, unknown>): ReadonlyArray<ParsedImport> => {
  const body = program["body"]
  if (!Array.isArray(body)) return []
  const found: Array<ParsedImport> = []
  for (const statement of body) {
    if (typeof statement !== "object" || statement === null) continue
    const node = statement as Record<string, unknown>
    const kind = node["type"]
    if (kind !== "ImportDeclaration" && kind !== "ExportNamedDeclaration" && kind !== "ExportAllDeclaration") {
      continue
    }
    const source = node["source"]
    if (typeof source !== "object" || source === null) continue
    const value = (source as Record<string, unknown>)["value"]
    if (typeof value !== "string") continue

    const names: Array<string> = []
    const specifiers = node["specifiers"]
    if (Array.isArray(specifiers)) {
      for (const specifier of specifiers) {
        if (typeof specifier !== "object" || specifier === null) continue
        const record = specifier as Record<string, unknown>
        const imported = record["imported"]
        const exported = record["exported"]
        const name =
          typeof imported === "object" && imported !== null && typeof (imported as Record<string, unknown>)["name"] === "string"
            ? ((imported as Record<string, unknown>)["name"] as string)
            : typeof exported === "object" && exported !== null && typeof (exported as Record<string, unknown>)["name"] === "string"
              ? ((exported as Record<string, unknown>)["name"] as string)
              : undefined
        if (name !== undefined) names.push(name)
      }
    }
    // A statement is erased when it says so at the declaration, or when every
    // name it takes is taken as a type. Mixed imports (`import { type A, b }`) are
    // NOT erased: the runtime edge is real and so is any cycle through it.
    let typeOnly = node["importKind"] === "type" || node["exportKind"] === "type"
    if (!typeOnly && Array.isArray(specifiers) && specifiers.length > 0) {
      typeOnly = specifiers.every((specifier) => {
        if (typeof specifier !== "object" || specifier === null) return false
        return (specifier as Record<string, unknown>)["importKind"] === "type"
      })
    }
    found.push({ specifier: value, names, typeOnly })
  }
  return found
}
