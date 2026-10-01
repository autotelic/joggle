import { describe, expect, test } from "vitest"
import { astroRegions, blankOutside } from "../src/astro.ts"

const read = (text: string): ReadonlyArray<string> =>
  astroRegions(text).map((region) => text.slice(region.start, region.end))

describe("astroRegions", () => {
  test("the frontmatter is read, without its fences", () => {
    expect(read("---\nconst a = 1\n---\n<p>{a}</p>\n")).toEqual(["const a = 1\n"])
  })

  test("a file with no frontmatter has none", () => {
    expect(read("<p>hello</p>\n")).toEqual([])
  })

  test("a --- in the template is not a fence", () => {
    expect(read("<p>a</p>\n---\nconst b = 2\n---\n")).toEqual([])
  })

  test("script blocks are read after the frontmatter, in order", () => {
    const text = "---\nconst a = 1\n---\n<script>\nconst b = 2\n</script>\n<script type=\"module\">const c = 3</script>\n"
    expect(read(text)).toEqual(["const a = 1\n", "\nconst b = 2\n", "const c = 3"])
  })

  test("a script that is data or injected HTML is not read", () => {
    const text =
      "<script type=\"application/ld+json\">{\"a\":1}</script>\n<script set:html={x}></script>\n<script is:inline>const d = 4</script>\n"
    expect(read(text)).toEqual(["const d = 4"])
  })
})

describe("blankOutside", () => {
  test("keeps length, newlines and the regions, and blanks the rest", () => {
    const text = "---\nconst a = 1\n---\n<p>—</p>\n"
    const blanked = blankOutside(text, astroRegions(text))
    expect(blanked.length).toBe(text.length)
    expect(blanked).toBe("   \nconst a = 1\n   \n        \n")
  })
})
