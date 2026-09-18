import { Effect, FileSystem, Path } from "effect"
import { parseSync } from "oxc-parser"
import { policy } from "./policy.ts"
import { buildImportGraph, importsIn, type ImportGraph, type ParsedImport } from "./imports.ts"
import { isIgnored, orderRules, rulesAt, type IgnoreRule } from "./gitignore.ts"
import { safeJson, shortHash } from "./state.ts"
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
   * Whether the declaration referenced any type at all.
   *
   * False for every declaration in a `.js` file, and for unannotated ones in
   * `.ts`. It is what lets a rule say "the shape was the only signal here"
   * instead of presenting a shape match with the authority of a typed one.
   */
  readonly typed: boolean
  /**
   * The property names a type declaration lists, in order.
   *
   * Empty for everything that is not an interface or a type literal. This is the
   * material for asking whether one type is another type plus something, which is
   * what "composed of smaller canonical things" reduces to once it stops being a
   * principle and becomes a set comparison.
   */
  readonly fields: ReadonlyArray<string>
  /**
   * Whether this declaration came from a test file.
   *
   * Kept on the unit rather than used to exclude it, because the two cases are
   * not the same: a helper duplicated between two spec files is a factory doing
   * its job, while a helper duplicated between a spec and the code it tests means
   * the spec is asserting against its own copy. The first should be silence; the
   * second is one of the more valuable things this tool can say, and excluding
   * test files wholesale threw it away.
   */
  readonly test: boolean
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

/**
 * Structure a JSX codebase reveals through names rather than shapes.
 *
 * A composition pattern is a convention about how components are organised --
 * a context, a provider, blocks, and a dot-notation export -- and every part of
 * that convention is spelled somewhere in the source. These three lists are
 * enough to check it without a renderer, a bundler or a runtime.
 */
export interface StructureFacts {
  /** Callee names, dotted for member calls: `createContext`, `React.useState`. */
  readonly calls: ReadonlyArray<string>
  /** Element names as written, dotted for member JSX: `Button`, `Counter.Provider`. */
  readonly jsx: ReadonlyArray<string>
  /** Key names of every object literal, one entry per literal. */
  readonly objects: ReadonlyArray<ReadonlyArray<string>>
}

export interface SourceFile {
  readonly path: string
  readonly text: string
  readonly units: ReadonlyArray<Unit>
  /** Raw import/re-export statements, before resolution. */
  readonly imports: ReadonlyArray<ParsedImport>
  /** Names the file spells: what it calls, what it renders, what it declares. */
  readonly facts: StructureFacts
}

/**
 * The deterministic substrate. Its only job is to make candidate generation
 * cheap and high-recall; it makes no judgements.
 */
/** A file that was read and could not be parsed, with the parser's own words. */
/**
 * What a package says about itself.
 *
 * A package's own manifest is the material a question about its dependencies
 * needs. `packages/fasdentify` importing fastify is either a violation or the
 * package's entire purpose, and only one field decides which:
 *
 *   "description": "A Fastify plugin for sending mail"
 *
 * The docs call state "the material you would present to a panel of experts". I
 * asked the panel whether a package should import a framework without telling it
 * what the package was, and it gave the only answer available from that material.
 */
export interface PackageManifest {
  readonly name: string
  readonly description: string | undefined
  /**
   * What the package declares that it depends on.
   *
   * The field that cannot be vacuous, and the reason `description` was not
   * enough. `"fasdentify core package"` says nothing; `"dependencies": {
   * "fastify": "^4" }` says everything. A package that declares a dependency has
   * already answered whether importing it is intended, so the question never
   * needs asking -- a fact, not a judgement.
   */
  readonly declares: ReadonlyArray<string>
}

export interface UnparsedFile {
  readonly path: string
  readonly reason: string
}

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
  /**
   * Files that were read and could not be parsed.
   *
   * Recorded rather than dropped: a file the parser rejected is a hole in every
   * rule's view of the repository, and until this existed the parse result's
   * `errors` array was never read at all.
   */
  readonly unparsed: ReadonlyArray<UnparsedFile>
  /**
   * The nearest manifest above each analysed directory, keyed by that directory.
   *
   * Derived from the filesystem rather than declared, so it cannot go stale: move
   * a package and its description travels with it.
   */
  readonly manifests: ReadonlyMap<string, PackageManifest>
  /**
   * Declarations that came from a test file.
   *
   * They are analysed, but only against each other: a factory repeated in two
   * spec files is doing its job, while a helper repeated between a spec and the
   * code it tests means the spec asserts against its own copy.
   */
  readonly testDeclarations: number
  /**
   * Declarations not analysed because a transpiler emitted them.
   *
   * TypeScript and Babel emit a helper into every file that needs one, so
   * `__classPrivateFieldGet` appears once per file BY CONSTRUCTION. Reporting
   * those as duplication is reporting the compiler.
   */
  readonly excludedHelpers: number
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

/**
 * What counts as source.
 *
 * This used to be TypeScript only, and it was never a decision: the extension
 * list arrived with the first rebuild and nobody revisited it. On one real
 * repository that meant 1,457 JavaScript files -- an entire API and an entire
 * admin UI -- were never read, while the report said "287 files" with no hint
 * that four fifths of the tree was missing. A partial analysis that looks
 * complete is the worst output this program can produce.
 *
 * Declarations stay out: a `.d.ts` describes a build's output rather than a
 * source file, and analysing one reports on code nobody wrote.
 */
const looksLikeSource = (file: string): boolean => {
  if (file.endsWith(".d.ts") || file.endsWith(".d.mts") || file.endsWith(".d.cts")) return false
  return /\.(?:[cm]?[jt]sx?)$/.test(file)
}

type Lang = "js" | "jsx" | "ts" | "tsx"

/**
 * The language of a file, from its extension.
 *
 * `.js` is the interesting one. JSX in a `.js` file is legal under the configs
 * most React applications use, and oxc parses `lang: "js"` strictly enough to
 * reject it. So the extension gives a first guess and the parser gets the last
 * word -- see `parseSourceFile`, which gives a `.js` file a second reading as
 * JSX when the first one reports errors, rather than guessing from the contents.
 */
const langOf = (file: string): Lang => {
  if (file.endsWith(".tsx")) return "tsx"
  if (file.endsWith(".jsx")) return "jsx"
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) return "ts"
  return "js"
}

interface DeclarationSite extends Span {
  readonly kind: UnitKind
  readonly name: string
  readonly exported: boolean
  readonly fields: ReadonlyArray<string>
}

/**
 * The property names a type declaration lists.
 *
 * An interface keeps them in `body.body`; a type alias keeps them in the members
 * of its annotation when that annotation is a literal. A union or an intersection
 * has no single field set and returns nothing -- `A & B` states its composition
 * already, which is the thing this is looking for.
 */
const fieldsOf = (node: Record<string, unknown>): ReadonlyArray<string> => {
  const members =
    node["type"] === "TSInterfaceDeclaration"
      ? isRecord(node["body"])
        ? (node["body"] as Record<string, unknown>)["body"]
        : undefined
      : node["type"] === "TSTypeAliasDeclaration" && isRecord(node["typeAnnotation"])
        ? (node["typeAnnotation"] as Record<string, unknown>)["members"]
        : undefined
  if (!Array.isArray(members)) return []
  const names: Array<string> = []
  for (const member of members) {
    if (!isRecord(member)) continue
    const key = member["key"]
    if (!isRecord(key)) continue
    if (typeof key["name"] === "string") names.push(key["name"])
    else if (typeof key["value"] === "string") names.push(key["value"])
  }
  return [...new Set(names)]
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
    sites.push({ kind, name, start, end, exported, fields: fieldsOf(node) })
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
            sites.push({
              kind: "function",
              name,
              start: value["start"],
              end: value["end"],
              exported,
              fields: [],
            })
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

/**
 * Collect the names a file spells.
 *
 * One generic walk, three lists. A composition pattern is checkable from them
 * because every part of the convention is literally written down: a call to
 * `createContext`, a render of `Counter.Provider`, an object literal with
 * `state`, `actions` and `meta` among its keys.
 */
const structureIn = (root: unknown): StructureFacts => {
  const calls = new Set<string>()
  const jsx = new Set<string>()
  const objects: Array<ReadonlyArray<string>> = []

  const nameOf = (node: unknown): string | undefined => {
    if (!isRecord(node)) return undefined
    if (node["type"] === "Identifier" && typeof node["name"] === "string") return node["name"]
    if (node["type"] === "StaticMemberExpression") {
      const object = nameOf(node["object"])
      const property = node["property"]
      const key =
        isRecord(property) && typeof property["name"] === "string" ? property["name"] : undefined
      return object !== undefined && key !== undefined ? object + "." + key : undefined
    }
    if (node["type"] === "JSXIdentifier" && typeof node["name"] === "string") return node["name"]
    if (node["type"] === "JSXMemberExpression") {
      const object = nameOf(node["object"])
      const property = nameOf(node["property"])
      return object !== undefined && property !== undefined ? object + "." + property : undefined
    }
    return undefined
  }

  const stack: Array<unknown> = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child)
      continue
    }
    if (!isRecord(node)) continue
    switch (node["type"]) {
      case "CallExpression": {
        const called = nameOf(node["callee"])
        if (called !== undefined) calls.add(called)
        break
      }
      case "JSXOpeningElement":
      case "JSXSelfClosingElement": {
        const element = nameOf(node["name"])
        if (element !== undefined) jsx.add(element)
        break
      }
      case "ObjectExpression": {
        const properties = node["properties"]
        if (Array.isArray(properties)) {
          const keys: Array<string> = []
          for (const property of properties) {
            if (!isRecord(property)) continue
            const key = property["key"]
            if (isRecord(key) && typeof key["name"] === "string") keys.push(key["name"])
            else if (isRecord(key) && typeof key["value"] === "string") keys.push(key["value"])
          }
          objects.push(keys)
        }
        break
      }
      default:
        break
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === "object") stack.push(value)
    }
  }
  return { calls: [...calls], jsx: [...jsx], objects }
}

/** A parse result, whichever language produced it. */
type ParsedSource = ReturnType<typeof parseSync>

const describeParseErrors = (errors: ReadonlyArray<unknown>): string => {
  const first = errors[0]
  const message =
    typeof first === "object" &&
    first !== null &&
    typeof (first as Record<string, unknown>)["message"] === "string"
      ? ((first as Record<string, unknown>)["message"] as string)
      : "the parser rejected this file"
  return errors.length > 1 ? message + " (and " + (errors.length - 1) + " more)" : message
}

const sourceFileFrom = (file: string, text: string, parsed: ParsedSource): SourceFile => {
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
      // Whether this declaration said anything about its types. In a `.js` file,
      // and in unannotated `.ts`, the answer is never. Recorded rather than
      // inferred later: "no types written" and "types written and empty" look the
      // same from outside and are not the same fact.
      const typeRefs = [
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
      ]
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
        typeRefs,
        typed: typeRefs.length > 0,
        fields: site.fields,
        test: policy.testFiles.test(file),
        typeSignature: "",
        doc: docFor(site.start),
      })
    }
  }
  const imports = isRecord(program) ? importsIn(program) : []
  return { path: file, text, units, imports, facts: structureIn(program) }
}

/** A file we read, and either parsed or could not. */
export type ParseOutcome =
  | { readonly ok: true; readonly file: SourceFile }
  | { readonly ok: false; readonly reason: string }

/**
 * Parse a file, giving `.js` a second reading as JSX.
 *
 * One retry, and then the file is REPORTED as unparsed rather than silently
 * contributing nothing. The `errors` array was never read here, so a file the
 * parser rejected looked exactly like a file with no declarations in it -- and
 * every rule's view of the repository had a hole nobody could see.
 */
const parseSourceFile = (file: string, text: string): ParseOutcome => {
  const lang = langOf(file)
  const first = parseSync(file, text, { sourceType: "module", lang })
  if (first.errors.length === 0) return { ok: true, file: sourceFileFrom(file, text, first) }

  if (lang === "js") {
    const retry = parseSync(file, text, { sourceType: "module", lang: "jsx" })
    if (retry.errors.length === 0) return { ok: true, file: sourceFileFrom(file, text, retry) }
  }
  return { ok: false, reason: describeParseErrors(first.errors) }
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

const ignored = new Set<string>(policy.ignoredDirectories)

/** Insurance against symlink cycles and pathological trees. */
/** What discovery saw, and what it declined to look at. */
export interface Discovery {
  readonly files: ReadonlyArray<string>
  /**
   * Files the walk saw and did not treat as source, by extension.
   *
   * A bound nobody can see is indistinguishable from a bug, and this was the one
   * bound in the program with no report at all. Non-source files were dropped
   * inside the walk loop, so "287 files" read as the repository rather than as a
   * fifth of it, and an entire API written in JavaScript was invisible for as
   * long as the extension list stayed the way it was.
   */
  readonly skipped: ReadonlyArray<SkippedExtension>
  /** True when the walk stopped at its own limit rather than at the end. */
  readonly truncated: boolean
  /** Files skipped because a .gitignore says so. */
  readonly ignored: number
  /**
   * Directories skipped because a .gitignore says so.
   *
   * Counted separately because an ignored directory hides an unknown number of
   * files: `.wrangler/` is one line in a .gitignore and ten generated files on
   * disk, and reporting only the file count would have made the largest source
   * of noise in one real report look like a rounding error.
   */
  readonly ignoredDirectories: number
}

export interface SkippedExtension {
  readonly extension: string
  readonly count: number
}

/**
 * Whether a name is one a transpiler emits rather than one a person wrote.
 *
 * The lists are explicit rather than "starts with `__`", because a person is
 * allowed to write `__proto__`-adjacent names and a filter that guesses at them
 * is a filter that will one day drop real code. Every entry here is a helper
 * TypeScript or Babel puts in a file by itself.
 */
const COMPILER_HELPERS = new Set([
  "__awaiter", "__generator", "__rest", "__spread", "__spreadArray", "__spreadArrays",
  "__values", "__read", "__readInt", "__assign", "__extends", "__decorate", "__metadata",
  "__param", "__createBinding", "__setFunctionName", "__toPrimitive", "__toPropertyKey",
  "__importDefault", "__importStar", "__export", "__exportStar", "__classPrivateFieldGet",
  "__classPrivateFieldSet", "__classPrivateFieldIn", "__addDisposableResource",
  "__disposeResources", "__esDecorate", "__runInitializers", "__propKey",
  "_interopRequireDefault", "_interopRequireWildcard", "_classCallCheck", "_defineProperty",
  "_toConsumableArray", "_typeof", "_extends", "_objectSpread", "_objectSpread2",
  "_slicedToArray", "_asyncToGenerator", "_createClass", "_getPrototypeOf", "_inherits",
])

const isCompilerHelper = (name: string): boolean => COMPILER_HELPERS.has(name)

/**
 * The package.json in one directory, if it names the package.
 *
 * Read from the filesystem rather than declared, for the same reason .gitignore
 * is: it is already current, because whoever made the package wrote it. A name
 * and a description are the two fields that say what a package IS.
 */
const manifestAt = (
  directory: string,
): Effect.Effect<PackageManifest | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(directory, "package.json")
    const exists = yield* Effect.orElseSucceed(fs.exists(file), () => false)
    if (!exists) return undefined
    const text = yield* Effect.orElseSucceed(fs.readFileString(file), () => "")
    const decoded = safeJson(text)
    if (!isRecord(decoded)) return undefined
    const name = decoded["name"]
    if (typeof name !== "string" || name.length === 0) return undefined
    const description = decoded["description"]
    // Every kind of dependency, because the question this answers is "has the
    // package declared it?" and a devDependency is a declaration. Restricting
    // this to runtime dependencies flagged `chai` and `@faker-js/faker` as
    // undeclared imports, which they are not -- the distinction between runtime
    // and development belongs to the judgement about whether an import FITS, and
    // that is the model's question, not this one's.
    const declares: Array<string> = []
    for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
      const block = decoded[field]
      if (isRecord(block)) declares.push(...Object.keys(block))
    }
    return {
      name,
      description: typeof description === "string" ? description : undefined,
      declares,
    }
  })

const extensionOf = (file: string): string => {
  const cut = file.lastIndexOf(".")
  return cut === -1 ? "(no extension)" : file.slice(cut)
}

const summarise = (counts: ReadonlyMap<string, number>): ReadonlyArray<SkippedExtension> =>
  [...counts.entries()]
    .map(([extension, count]) => ({ extension, count }))
    .sort(
      (left, right) => right.count - left.count || left.extension.localeCompare(right.extension),
    )

const walkLimits = { directories: 5000, files: 20000 }

const depthOf = (root: string, dir: string, path: Path.Path): number =>
  path.relative(root, dir).split(path.sep).filter((segment) => segment !== "" && segment !== ".")
    .length

/**
 * Walk a directory, honouring .gitignore as it goes.
 *
 * Rules accumulate as directories are entered. A rule only speaks for its own
 * directory and below it -- `isIgnored` returns early when the path is not under
 * the rule's base -- so a sibling's rules are inert rather than wrong, which is
 * what lets one list serve the whole walk.
 */
const walk = (
  dir: string,
  root: string,
  inherited: ReadonlyArray<IgnoreRule> = [],
): Effect.Effect<Discovery, WorkspaceError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const found: Array<string> = []
    const skipped = new Map<string, number>()
    let rules: ReadonlyArray<IgnoreRule> = inherited
    let ignoredCount = 0
    let ignoredDirs = 0
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
      // Ignored first: a generated .js file is both non-source and ignored, and
      // "we were told not to look" is the more useful of the two reasons.
      if (rules.length > 0 && isIgnored(rules, current, path)) {
        if (info.type === "File") ignoredCount += 1
        else ignoredDirs += 1
        continue
      }
      if (info.type === "File") {
        if (looksLikeSource(current)) {
          found.push(current)
        } else {
          const extension = extensionOf(current)
          skipped.set(extension, (skipped.get(extension) ?? 0) + 1)
        }
        continue
      }
      if (info.type !== "Directory") continue
      if (seen.has(current)) continue
      seen.add(current)
      // A directory's own .gitignore applies to what is inside it, so it is
      // read before its children are pushed.
      const here = yield* rulesAt(current, depthOf(root, current, path))
      if (here.length > 0) rules = orderRules([...rules, ...here])

      const entries = yield* Effect.orElseSucceed(
        fs.readDirectory(current),
        () => [] as ReadonlyArray<string>,
      )
      for (const entry of entries) {
        if (!ignored.has(entry)) stack.push(path.join(current, entry))
      }
    }
    // Both limits are reported, not silently obeyed: reaching one means the run
    // analysed part of the tree and said nothing about the rest.
    return {
      files: found.sort(),
      skipped: summarise(skipped),
      truncated: found.length >= walkLimits.files || seen.size >= walkLimits.directories,
      ignored: ignoredCount,
      ignoredDirectories: ignoredDirs,
    }
  })

const resolveInputs = (
  root: string,
  inputs: ReadonlyArray<string>,
): Effect.Effect<Discovery, WorkspaceError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const files: Array<string> = []
    const skipped = new Map<string, number>()
    let truncated = false
    let ignored = 0
    let ignoredDirectories = 0
    for (const input of inputs) {
      const absolute = path.isAbsolute(input) ? input : path.join(root, input)
      if (looksLikeSource(absolute)) {
        files.push(absolute)
        continue
      }
      // A .gitignore above the walked directory still applies to it, so the
      // chain from the root down to (but not including) the input is loaded
      // first.
      const chain: Array<IgnoreRule> = [...(yield* rulesAt(root, 0))]
      const segments = path
        .relative(root, absolute)
        .split(path.sep)
        .filter((segment) => segment !== "" && segment !== ".")
      let cursor = root
      for (const segment of segments.slice(0, -1)) {
        cursor = path.join(cursor, segment)
        chain.push(
          ...(yield* rulesAt(cursor, path.relative(root, cursor).split(path.sep).length)),
        )
      }
      const nested = yield* walk(absolute, root, orderRules(chain))
      for (const file of nested.files) files.push(file)
      truncated = truncated || nested.truncated
      ignored += nested.ignored
      ignoredDirectories += nested.ignoredDirectories
      for (const entry of nested.skipped) {
        skipped.set(entry.extension, (skipped.get(entry.extension) ?? 0) + entry.count)
      }
    }
    return { files, skipped: summarise(skipped), truncated, ignored, ignoredDirectories }
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
): Effect.Effect<Discovery, WorkspaceError, FileSystem.FileSystem | Path.Path> =>
  discovered !== undefined
    ? Effect.succeed({
        files: discovered,
        skipped: [],
        truncated: false,
        ignored: 0,
        ignoredDirectories: 0,
      })
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
      discovered ?? (yield* resolveInputs(root, inputs.length > 0 ? inputs : ["."])).files
    const parsed: Array<SourceFile> = []
    const unparsed: Array<UnparsedFile> = []
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
      const relative = path.relative(root, absolute)
      const outcome = parseSourceFile(relative, text)
      if (outcome.ok) parsed.push(outcome.file)
      else unparsed.push({ path: relative, reason: outcome.reason })
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
    // Declarations from test files and from transpiler helpers are excluded
    // before any rule sees them, and counted, because a rule that silently
    // receives fewer candidates is a rule nobody can debug.
    // The nearest package.json above each directory an analysed file sits in.
    // Bounded to a few levels and cached per directory, so this is a handful of
    // reads rather than one per file.
    const manifests = new Map<string, PackageManifest>()
    const directories = [
      ...new Set(
        parsed.map((file) => {
          const cut = file.path.lastIndexOf("/")
          return cut === -1 ? "." : file.path.slice(0, cut)
        }),
      ),
    ]
    for (const directory of directories) {
      let cursor = directory
      // Bounded by the path itself rather than by a constant. Six levels is
      // nothing in a monorepo: a file eight directories deep sits above its own
      // manifest, and was grouped under a different name than its siblings.
      for (let depth = 0; depth <= directory.split("/").length + 1; depth += 1) {
        // The root has a manifest too, and it is the one that governs a file
        // sitting at the top of the repository. Breaking before reading it made
        // every dependency of `app.ts` and `index.ts` look undeclared.
        const manifest = yield* manifestAt(cursor === "." ? root : path.join(root, cursor))
        if (manifest !== undefined) {
          manifests.set(directory, manifest)
          break
        }
        const parent = cursor.includes("/") ? cursor.slice(0, cursor.lastIndexOf("/")) : "."
        if (parent === cursor || cursor === ".") break
        cursor = parent
      }
    }

    const allUnits = parsed.flatMap((file) => file.units)
    // Helpers go; test declarations stay and are marked, because whether they
    // should be compared depends on what they are compared AGAINST.
    const units = allUnits.filter((unit) => !isCompilerHelper(unit.name))
    const testDeclarations = units.filter((unit) => unit.test).length
    const excludedHelpers = allUnits.filter((unit) => isCompilerHelper(unit.name)).length
    const byName = new Map<string, Array<Unit>>()
    for (const unit of units) {
      const existing = byName.get(unit.name)
      if (existing === undefined) byName.set(unit.name, [unit])
      else existing.push(unit)
    }
    return {
      root,
      files: parsed,
      units,
      byName,
      imports: graph,
      unparsed,
      manifests,
      testDeclarations,
      excludedHelpers,
    }
  })
