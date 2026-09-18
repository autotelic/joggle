import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { decline, declineNames, declined } from "../src/rule.ts"

const RULES = [
  "src/rules/cluster-verdict.ts",
  "src/rules/naming-drift.ts",
  "src/rules/page-needs-composition.ts",
]

const sourceOf = (file: string): string => readFileSync(new URL("../" + file, import.meta.url), "utf8")

describe("the decline vocabulary", () => {
  test("a decline is an answer, and reads as one", () => {
    expect(declined(decline.noIssue)).toBe(true)
    expect(declined(decline.notApplicable)).toBe(true)
    expect(declined("collapse")).toBe(false)
  })

  test("silence is not a decline", () => {
    // The distinction matters downstream: a decline is "looked, found nothing",
    // while an absent choice is "never got an answer". The first is a result and
    // the second is a skipped rule.
    expect(declined(undefined)).toBe(false)
  })

  test("no rule invents a fifth name for the same idea", () => {
    const legacy = ["not_duplication", "distinct\":", "keep_local"]
    for (const file of RULES) {
      const source = sourceOf(file)
      for (const name of legacy) {
        expect(source.includes(name), file + " still uses " + name).toBe(false)
      }
    }
  })

  test("every rule that can decline names one of the two", () => {
    for (const file of RULES) {
      const source = sourceOf(file)
      const offers = declineNames.some(
        (name) => source.includes(name + ":") || source.includes('"' + name + '"'),
      )
      expect(offers, file + " has no decline option").toBe(true)
    }
  })

  test("a question that offers a decline documents it", () => {
    // The cookbook states the escape hatch in the question: "Select noMatch when
    // no hunk provides sufficient evidence". Inferred from the option list is
    // not the same as stated.
    for (const file of RULES) {
      expect(sourceOf(file).includes("fallback"), file + " does not state its fallback").toBe(true)
    }
  })
})
