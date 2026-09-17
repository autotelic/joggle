import { Effect, FileSystem, Path } from "effect"
import { parseSync } from "oxc-parser"
import { policy } from "./policy.ts"
import { buildImportGraph, importsIn, type ImportGraph, type ParsedImport } from "./imports.ts"
import { shortHash } from "./state.ts"
import { shinglesOf } from "./similarity.ts"
import { WorkspaceError, type SourceLocation } from "./schema.ts"

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

export type UnitKind = "function" | "interface" | "type"

/**
 * One addressable declaration. This is the closest thing joggle has to an
 * occurrence: every rule either judges a `Unit` or a pair of them.
 */
export interface Unit {
  readonly kind: UnitKind
  readonly name: string
  readonly file: string
  readonly start: number
  readonly end: number
  readonly location: SourceLocation
  readonly exported: boolean
  /** The declaration exactly as written. */
  readonly text: string
  /** The declaration with every identifier replaced by `_`. */
  readonly shape: string
  readonly tokens: ReadonlyArray<string>
  /**
   * Token-bigram set, computed once. Rebuilding it inside `similarity` meant two
   * thrown-away Set allocations and a string concatenation per bigram on every
   * pair comparison -- millions of allocations to answer a question the unit
   * already knew the answer to.
   */
  readonly shingles: ReadonlySet<string>
  readonly shapeHash: string
  /** Type-position names this declaration mentions, before resolution. */
  readonly typeRefs: ReadonlyArray<string>
  /**
   * The same names after following this file's imports to where each is
   * declared. Two declarations whose shape matches but whose resolved types
   * differ are not the same thing, however alike they read.
   *
   * Filled in a second pass, once the whole file set is known: a type name only
   * means something when we know where it came from.
   */
  typeSignature: string
  /** The comment directly above the declaration, if there is one. */
  readonly doc: string | undefined
}

export interface SourceFile {
  readonly path: string
  readonly text: string
  readonly units: ReadonlyArray<Unit>
  /** Raw import/re-export statements, before resolution. */
  readonly imports: ReadonlyArray<ParsedImport>
}

/**
 * The deterministic substrate. Its only job is to make candidate generation
 * cheap and high-recall; it makes no judgements.
 */
export interface Workspace {
  readonly root: string
  readonly files: ReadonlyArray<SourceFile>
  readonly units: ReadonlyArray<Unit>
  readonly byName: ReadonlyMap<string, ReadonlyArray<Unit>>
  /**
   * Who imports what, resolved against the files actually analysed. This is
   * pillar two of the four in docs/new-passes.md and it was the missing one:
   * without it, "keep X and import it here" was advice we had never checked, and
   * there was no way to know what a deletion would break.
   */
  readonly imports: ImportGraph
}

/* -------------------------------------------------------------------------- */
/* Source helpers                                                              */
/* -------------------------------------------------------------------------- */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

interface IdentifierSite {
  readonly start: number
  readonly end: number
  readonly name: string
  /**
   * Property keys, member-access properties and type references are part of what
   * a declaration *means*; local binding names are not. Keeping the former and
   * erasing the latter is the difference between "the same shape" and "the same
   * thing".
   */
  readonly kind: "binding" | "property" | "type"
}

/**
 * Node kinds that name a *type*. In a type position the identifier is the whole
 * meaning: `z.infer<typeof CompanyTypeSchema>` and `z.infer<typeof schema>` are
 * different types, and `FastifyRequest<{ Params: { id: string } }>` is a
 * different endpoint in every route that declares one. Erasing these made the
 * shape matcher claim those pairs were identical, which cost 308 of 525
 * verification calls on one codebase answering "keep both".
 */
const TYPE_REFERENCE_ROOT = new Set([
  "TSClassImplements",
  "TSInterfaceHeritage",
  "TSTypeQuery",
  "TSTypeReference",
])

/**
 * Node kinds whose `key` or `property` names the shape rather than the reader:
 * `user.name`, `{ name: string }`, `{ name }`, class fields, enum members.
 */
const PROPERTY_BEARING = new Set([
  "AccessorProperty",
  "ClassProperty",
  "MemberExpression",
  "MethodDefinition",
  "ObjectProperty",
  "Property",
  "PropertyDefinition",
  "TSEnumMember",
  "TSMethodSignature",
  "TSPropertySignature",
])

/** Every `Identifier` in a subtree, as start offsets. */
const identifierOffsets = (root: unknown): ReadonlyArray<number> => {
  const offsets: Array<number> = []
  const stack: Array<unknown> = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child)
      continue
    }
    if (!isRecord(node)) continue
    if (node["type"] === "Identifier" && typeof node["start"] === "number") {
      offsets.push(node["start"])
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === "object") stack.push(value)
    }
  }
  return offsets
}

/**
 * Collect every `Identifier` node in the file, marking the ones that are shape.
 *
 * Three things survive normalisation: property names, type references, and
 * generic type-parameter *declarations* (which are local bindings, so `f<T>`
 * and `g<U>` still compare equal). Everything else is a local name.
 */
const collectIdentifiers = (root: unknown): ReadonlyArray<IdentifierSite> => {
  const found: Array<{ start: number; end: number; name: string }> = []
  const properties = new Set<number>()
  const types = new Set<number>()
  const typeRoots: Array<unknown> = []
  const typeParameters = new Set<string>()
  const stack: Array<unknown> = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child)
      continue
    }
    if (!isRecord(node)) continue
    const kind = node["type"]
    if (typeof kind === "string") {
      if (PROPERTY_BEARING.has(kind)) {
        for (const field of ["key", "property", "id"]) {
          const child = node[field]
          if (isRecord(child) && child["type"] === "Identifier" && typeof child["start"] === "number") {
            properties.add(child["start"])
          }
        }
      }
      if (TYPE_REFERENCE_ROOT.has(kind)) typeRoots.push(node)
      if (kind === "TSTypeParameter") {
        const name = node["name"]
        if (isRecord(name) && typeof name["name"] === "string") typeParameters.add(name["name"])
      }
    }
    if (
      kind === "Identifier" &&
      typeof node["name"] === "string" &&
      typeof node["start"] === "number" &&
      typeof node["end"] === "number"
    ) {
      found.push({ start: node["start"], end: node["end"], name: node["name"] })
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === "object") stack.push(value)
    }
  }

  for (const typeRoot of typeRoots) {
    for (const offset of identifierOffsets(typeRoot)) {
      const site = found.find((candidate) => candidate.start === offset)
      if (site === undefined || typeParameters.has(site.name)) continue
      types.add(offset)
    }
  }

  return found.map((site) => ({
    ...site,
    kind: properties.has(site.start) ? "property" : types.has(site.start) ? "type" : "binding",
  }))
}

interface Span {
  readonly start: number
  readonly end: number
}

/**
 * Replace identifier names (and comments) with `_` / whitespace so that two
 * declarations with the same structure but different vocabulary compare equal.
 *
 * Only the leading identifier characters are replaced, so a parameter's type
 * annotation is preserved: `a: number` becomes `_: number`.
 */
const normalize = (
  text: string,
  span: Span,
  identifiers: ReadonlyArray<IdentifierSite>,
  comments: ReadonlyArray<Span>,
): string => {
  interface Edit {
    readonly start: number
    readonly end: number
    readonly text: string
  }
  const edits: Array<Edit> = []
  for (const comment of comments) {
    if (comment.start >= span.start && comment.end <= span.end) {
      edits.push({ start: comment.start, end: comment.end, text: " " })
    }
  }
  for (const identifier of identifiers) {
    if (identifier.kind !== "binding") continue
    if (identifier.start < span.start) continue
    if (identifier.start + identifier.name.length > span.end) continue
    if (text.slice(identifier.start, identifier.start + identifier.name.length) !== identifier.name) continue
    edits.push({ start: identifier.start, end: identifier.start + identifier.name.length, text: "_" })
  }
  edits.sort((a, b) => b.start - a.start)
  let out = text.slice(span.start, span.end)
  for (const edit of edits) {
    const from = edit.start - span.start
    const to = edit.end - span.start
    out = out.slice(0, from) + edit.text + out.slice(to)
  }
  return out.replace(/\s+/g, " ").trim()
}

const TOKEN_PATTERN = /[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g

export const tokenize = (shape: string): ReadonlyArray<string> => {
  const tokens: Array<string> = []
  for (const match of shape.matchAll(TOKEN_PATTERN)) tokens.push(match[0])
  return tokens
}



const lineStartsOf = (text: string): ReadonlyArray<number> => {
  const bytes = Buffer.from(text, "utf8")
  const starts: Array<number> = [0]
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) starts.push(index + 1)
  }
  return starts
}

const locate = (starts: ReadonlyArray<number>, offset: number): { line: number; column: number } => {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const value = starts[mid]
    if (value !== undefined && value <= offset) low = mid
    else high = mid - 1
  }
  const start = starts[low]
  return { line: low + 1, column: start === undefined ? 1 : offset - start + 1 }
}

/* -------------------------------------------------------------------------- */
/* Extraction                                                                  */
/* -------------------------------------------------------------------------- */

const looksLikeSource = (file: string): boolean => {
  if (file.endsWith(".d.ts") || file.endsWith(".d.mts") || file.endsWith(".d.cts")) return false
  return file.endsWith(".ts") || file.endsWith(".tsx") || file.endsWith(".mts") || file.endsWith(".cts")
}

const langOf = (file: string): "ts" | "tsx" => (file.endsWith(".tsx") ? "tsx" : "ts")

interface DeclarationSite extends Span {
  readonly kind: UnitKind
  readonly name: string
  readonly exported: boolean
}

const sitesIn = (program: Record<string, unknown>): ReadonlyArray<DeclarationSite> => {
  const body = program["body"]
  if (!Array.isArray(body)) return []
  const sites: Array<DeclarationSite> = []

  const push = (node: unknown, kind: UnitKind, name: unknown, exported: boolean): void => {
    if (!isRecord(node)) return
    if (typeof name !== "string") return
    const start = node["start"]
    const end = node["end"]
    if (typeof start !== "number" || typeof end !== "number") return
    sites.push({ kind, name, start, end, exported })
  }

  const fromDeclaration = (declaration: unknown, exported: boolean): void => {
    if (!isRecord(declaration)) return
    switch (declaration["type"]) {
      case "FunctionDeclaration": {
        const id = declaration["id"]
        push(declaration, "function", isRecord(id) ? id["name"] : undefined, exported)
        return
      }
      case "TSInterfaceDeclaration": {
        const id = declaration["id"]
        push(declaration, "interface", isRecord(id) ? id["name"] : undefined, exported)
        return
      }
      case "TSTypeAliasDeclaration": {
        const id = declaration["id"]
        push(declaration, "type", isRecord(id) ? id["name"] : undefined, exported)
        return
      }
      case "VariableDeclaration": {
        const declarators = declaration["declarations"]
        if (!Array.isArray(declarators)) return
        for (const declarator of declarators) {
          if (!isRecord(declarator)) continue
          const id = declarator["id"]
          const init = declarator["init"]
          if (!isRecord(init)) continue
          const initType = init["type"]
          if (initType === "ObjectExpression") {
            fromDeclaration(init, exported)
            continue
          }
          if (initType !== "ArrowFunctionExpression" && initType !== "FunctionExpression") continue
          push(init, "function", isRecord(id) ? id["name"] : undefined, exported)
        }
        return
      }
      // Class methods and object-literal methods were invisible: only top-level
      // declarations became units, so a helper copied between two classes or two
      // API objects was never a candidate. They are named Owner.member so a
      // reader can tell which one the report means.
      case "ClassDeclaration":
      case "ClassExpression": {
        const classId = declaration["id"]
        const className =
          isRecord(classId) && typeof classId["name"] === "string" ? classId["name"] : undefined
        const body = declaration["body"]
        if (!isRecord(body)) return
        const members = body["body"]
        if (!Array.isArray(members)) return
        for (const member of members) {
          if (!isRecord(member)) continue
          const key = member["key"]
          const keyName = isRecord(key) && typeof key["name"] === "string" ? key["name"] : undefined
          if (keyName === undefined) continue
          const name = className === undefined ? keyName : `${className}.${keyName}`
          const value = member["value"]
          if (isRecord(value) && typeof value["start"] === "number" && typeof value["end"] === "number") {
            sites.push({ kind: "function", name, start: value["start"], end: value["end"], exported })
          } else {
            push(member, "function", name, exported)
          }
        }
        return
      }
      case "ObjectExpression": {
        const properties = declaration["properties"]
        if (!Array.isArray(properties)) return
        for (const property of properties) {
          if (!isRecord(property) || property["type"] !== "Property") continue
          const key = property["key"]
          const keyName = isRecord(key) && typeof key["name"] === "string" ? key["name"] : undefined
          if (keyName === undefined) continue
          const value = property["value"]
          if (!isRecord(value)) continue
          const valueType = value["type"]
          if (valueType !== "ArrowFunctionExpression" && valueType !== "FunctionExpression") continue
          push(value, "function", keyName, exported)
        }
        return
      }
      default:
        return
    }
  }

  for (const statement of body) {
    if (!isRecord(statement)) continue
    switch (statement["type"]) {
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
        fromDeclaration(statement["declaration"], true)
        continue
      case "FunctionDeclaration":
      case "TSInterfaceDeclaration":
      case "TSTypeAliasDeclaration":
      case "VariableDeclaration":
        fromDeclaration(statement, false)
        continue
      default:
        continue
    }
  }

  return sites
}

const parseSourceFile = (file: string, text: string): SourceFile => {
  const parsed = parseSync(file, text, { sourceType: "module", lang: langOf(file) })
  const program: unknown = parsed.program
  const identifiers = collectIdentifiers(program)
  const comments = parsed.comments.map((comment) => ({
    start: comment.start,
    end: comment.end,
    value: comment.value,
  }))
  // The comment immediately above a declaration: docs/names.md argues it is the
  // single spot an agent is guaranteed to read, so which copy carries one is
  // evidence about which copy to keep.
  const docFor = (from: number): string | undefined => {
    let best: { start: number; end: number; value: string } | undefined
    for (const comment of comments) {
      if (comment.end > from) continue
      if (text.slice(comment.end, from).trim() !== "") continue
      if (best === undefined || comment.end > best.end) best = comment
    }
    return best?.value.replace(/^\s*\*+\s?/gm, "").trim() || undefined
  }
  const starts = lineStartsOf(text)

  const units: Array<Unit> = []
  if (isRecord(program)) {
    for (const site of sitesIn(program)) {
      const shape = normalize(text, site, identifiers, comments)
      const tokens = tokenize(shape)
      const from = locate(starts, site.start)
      const to = locate(starts, site.end)
      units.push({
        kind: site.kind,
        name: site.name,
        file,
        start: site.start,
        end: site.end,
        location: { file, line: from.line, column: from.column, endLine: to.line, endColumn: to.column },
        exported: site.exported,
        text: text.slice(site.start, site.end),
        shape,
        tokens,
        shingles: shinglesOf(tokens),
        shapeHash: shortHash(shape),
        typeRefs: [
          ...new Set(
            identifiers
              .filter(
                (identifier) =>
                  identifier.kind === "type" &&
                  identifier.start >= site.start &&
                  identifier.end <= site.end,
              )
              .map((identifier) => identifier.name),
          ),
        ],
        typeSignature: "",
        doc: docFor(site.start),
      })
    }
  }
  const imports = isRecord(program) ? importsIn(program) : []
  return { path: file, text, units, imports }
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

const ignored = new Set<string>(policy.ignoredDirectories)

/** Insurance against symlink cycles and pathological trees. */
const walkLimits = { directories: 5000, files: 20000 }

const walk = (
  dir: string,
): Effect.Effect<ReadonlyArray<string>, WorkspaceError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const found: Array<string> = []
    const stack: Array<string> = []
    const seen = new Set<string>()

    // The path the caller named must be readable; anything discovered below it
    // is best effort. One odd entry must not fail the whole run.
    const rootEntries = yield* fs.readDirectory(dir).pipe(
      Effect.mapError(
        (cause) => new WorkspaceError({ path: dir, operation: "readDirectory", cause }),
      ),
    )
    seen.add(dir)
    for (const entry of rootEntries) {
      if (!ignored.has(entry)) stack.push(path.join(dir, entry))
    }

    while (stack.length > 0 && seen.size < walkLimits.directories && found.length < walkLimits.files) {
      const current = stack.pop()
      if (current === undefined) break
      // stat, not the name: a zero-byte file called "tsx" is not a directory.
      const info = yield* Effect.orElseSucceed(fs.stat(current), () => undefined)
      if (info === undefined) continue
      if (info.type === "File") {
        if (looksLikeSource(current)) found.push(current)
        continue
      }
      if (info.type !== "Directory") continue
      if (seen.has(current)) continue
      seen.add(current)
      const entries = yield* Effect.orElseSucceed(
        fs.readDirectory(current),
        () => [] as ReadonlyArray<string>,
      )
      for (const entry of entries) {
        if (!ignored.has(entry)) stack.push(path.join(current, entry))
      }
    }
    return found.sort()
  })

const resolveInputs = (
  root: string,
  inputs: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, WorkspaceError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const files: Array<string> = []
    for (const input of inputs) {
      const absolute = path.isAbsolute(input) ? input : path.join(root, input)
      if (looksLikeSource(absolute)) files.push(absolute)
      else {
        const nested = yield* walk(absolute)
        for (const file of nested) files.push(file)
      }
    }
    return files
  })

/**
 * The files this run will look at, before any of them are read.
 *
 * Separated from `loadWorkspace` so a caller can hash the inputs and decide
 * whether the analysis is worth doing at all: an unchanged repository should
 * cost a read, not a parse.
 */
export const discoverFiles = (
  root: string,
  inputs: ReadonlyArray<string>,
  discovered?: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, WorkspaceError, FileSystem.FileSystem | Path.Path> =>
  discovered !== undefined
    ? Effect.succeed(discovered)
    : resolveInputs(root, inputs.length > 0 ? inputs : ["."])

export const loadWorkspace = (
  root: string,
  inputs: ReadonlyArray<string>,
  discovered?: ReadonlyArray<string>,
  /** Source text already read by the caller, keyed by absolute path. */
  contents?: ReadonlyMap<string, string>,
): Effect.Effect<Workspace, WorkspaceError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const files =
      discovered ?? (yield* resolveInputs(root, inputs.length > 0 ? inputs : ["."]))
    const parsed: Array<SourceFile> = []
    for (const absolute of files) {
      const preloaded = contents?.get(absolute)
      const text =
        preloaded ??
        (yield* fs.readFileString(absolute).pipe(
          Effect.mapError(
            (cause) => new WorkspaceError({ path: absolute, operation: "readFileString", cause }),
          ),
        ))
      // Diagnostics carry paths relative to the root, so output is stable and
      // hosts such as GitHub Actions can annotate the right file.
      parsed.push(parseSourceFile(path.relative(root, absolute), text))
    }
    const graph = buildImportGraph(parsed, path)
    // Resolution happens here, not at parse time, because it needs the whole
    // file set: a type name only means something once we know where it came from.
    const resolveRef = (file: string, name: string): string => {
      for (const edge of graph.importersOf.get(file) ?? []) {
        if (edge.from === file && edge.names.includes(name)) return `${edge.to}#${name}`
      }
      for (const edge of graph.edges) {
        if (edge.from === file && edge.resolved && edge.names.includes(name)) return `${edge.to}#${name}`
      }
      return `${file}#${name}`
    }
    parsed.forEach((file) => {
      file.units.forEach((unit) => {
        unit.typeSignature = unit.typeRefs
          .map((name) => resolveRef(file.path, name))
          .sort()
          .join("|")
      })
    })
    const units = parsed.flatMap((file) => file.units)
    const byName = new Map<string, Array<Unit>>()
    for (const unit of units) {
      const existing = byName.get(unit.name)
      if (existing === undefined) byName.set(unit.name, [unit])
      else existing.push(unit)
    }
    return { root, files: parsed, units, byName, imports: graph }
  })
