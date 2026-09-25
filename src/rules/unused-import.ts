import { Effect } from "effect"
import { locator, messages, reporter } from "../reporting.ts"
import { defineRule, outcome, type Scope } from "../rule.ts"
import type { Diagnostic } from "../schema.ts"
import type { Workspace } from "../workspace.ts"

const RULE_ID = "joggle/unused-import"

/**
 * A name imported and never mentioned again.
 *
 * From the reviews: an unused import reached `main` because oxlint had the rule
 * as a `warn`, the changed-files ratchet counted only the error ledger, no CI
 * step typechecked, and tests strip unused imports. "A missing gate rather than a
 * missing rule" (PR 1579) -- so the gate gets a deterministic rule that needs no
 * key and no trace.
 *
 * The fact is an occurrence count: the name appears ONCE in the file, in its own
 * import clause. Nothing classifies it -- no notion of what the name means, no
 * pattern for what an import looks like.
 *
 * It is deliberately conservative in one direction. A name mentioned in a comment
 * or a string counts as mentioned, so a genuinely-unused import that a comment
 * happens to name is missed rather than a used one reported. A gate that cries
 * wolf is a gate that gets switched off.
 */
const isWordCharacter = (code: number): boolean =>
  (code >= 97 && code <= 122) || // a-z
  (code >= 65 && code <= 90) || // A-Z
  (code >= 48 && code <= 57) || // 0-9
  code === 95 || // _
  code === 36 // $

/**
 * How many times a name occurs as a whole word.
 *
 * One argument rather than two adjacent strings: the linter's own
 * `no-swappable-primitive-params` would flag `(text, name)`.
 */
const occurrencesOf = (input: { readonly text: string; readonly name: string }): number => {
  const { text, name } = input
  let count = 0
  let index = text.indexOf(name)
  while (index !== -1) {
    const before = index === 0 ? 32 : (text.codePointAt(index - 1) ?? 32)
    const after = text.codePointAt(index + name.length) ?? 32
    if (!isWordCharacter(before) && !isWordCharacter(after)) count += 1
    index = text.indexOf(name, index + name.length)
  }
  return count
}

export const unusedImport = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "A name imported and never mentioned again.",
  judged: false,
  messages: messages({
    unused: '`{{name}}` is imported from "{{specifier}}" and never used.',
    unused_help:
      "Remove the import, or use it. An unused import is usually a rename that left the old name behind, or a function that moved.",
  }),
  run: Effect.fn("joggle/unused-import")(function* (workspace: Workspace, scope: Scope) {
    const report = reporter(unusedImport, locator(workspace))
    const diagnostics: Array<Diagnostic> = []
    for (const file of workspace.files) {
      if (scope.changed !== undefined && !scope.changed.has(file.path)) continue
      for (const parsed of file.imports) {
        for (const name of parsed.names) {
          // An aliased import is recorded under the imported name, not the local
          // one, so leave it alone rather than guess which is which.
          if (file.text.includes(name + " as ")) continue
          if (occurrencesOf({ text: file.text, name }) > 1) continue
          diagnostics.push(
            report({
              at: file,
              messageId: "unused",
              data: { name, specifier: parsed.specifier },
              helpId: "unused_help",
              identity: [RULE_ID, file.path, name].join("\u0000"),
            }),
          )
        }
      }
    }
    return outcome(diagnostics)
  }),
})
