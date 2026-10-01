/*
 * The TypeScript inside an `.astro` file, located so the parser can read it in place.
 *
 * An `.astro` file is frontmatter, a template, and `<script>` blocks. The
 * frontmatter and the scripts are TypeScript; the template needs Astro's own
 * compiler and is not read. Rather than cutting the TypeScript out and mapping
 * positions back, everything else is blanked: the copy has the same length and
 * the same line breaks, so an offset into it is an offset into the file.
 */

/** A span of the file, in UTF-16 code units, end exclusive. */
export interface Region {
  readonly start: number
  readonly end: number
}

const OPENING_FENCE = /^\s*---[ \t]*\r?\n/
const CLOSING_FENCE = /^---[ \t]*\r?$/m
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
const TYPE = /\btype\s*=\s*["']?([^"'\s>]+)/i
const READABLE_TYPES = new Set(["module", "text/javascript", "application/javascript"])

/** Whether a script's attributes say its content is code joggle should read. */
const readableScript = (attributes: string): boolean => {
  if (/\bset:(?:html|text)\b/.test(attributes)) return false
  const type = TYPE.exec(attributes)?.[1]
  return type === undefined || READABLE_TYPES.has(type.toLowerCase())
}

/**
 * The frontmatter's content, then each readable script's content.
 *
 * The frontmatter only counts at the top of the file, as Astro reads it, so a
 * `---` further down is template text. Scripts are searched for after the
 * frontmatter: a `<script>` string inside the frontmatter is TypeScript.
 */
export const astroRegions = (text: string): ReadonlyArray<Region> => {
  const regions: Array<Region> = []
  let templateStart = 0
  const opening = OPENING_FENCE.exec(text)
  if (opening !== null) {
    const start = opening[0].length
    const closing = CLOSING_FENCE.exec(text.slice(start))
    if (closing !== null) {
      regions.push({ start, end: start + closing.index })
      templateStart = start + closing.index + closing[0].length
    }
  }
  for (const match of text.slice(templateStart).matchAll(SCRIPT)) {
    const attributes = match[1] ?? ""
    const content = match[2] ?? ""
    if (!readableScript(attributes)) continue
    const start = templateStart + match.index + match[0].indexOf(">") + 1
    regions.push({ start, end: start + content.length })
  }
  return regions
}

/** The file with every character outside the regions a space, and every newline kept. */
export const blankOutside = (text: string, regions: ReadonlyArray<Region>): string => {
  const blank = (from: number, to: number): string => text.slice(from, to).replace(/[^\r\n]/g, " ")
  let out = ""
  let cursor = 0
  for (const region of regions) {
    out += blank(cursor, region.start) + text.slice(region.start, region.end)
    cursor = region.end
  }
  return out + blank(cursor, text.length)
}
