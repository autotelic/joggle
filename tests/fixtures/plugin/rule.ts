import { Effect } from "effect"
import type { Rule } from "../../../src/rule.ts"

/**
 * A rule that lives in the repository rather than in the tool.
 *
 * This is the whole point of the registry: an opinion of your own is a value in
 * a module, not a fork. It gets the same treatment as a built-in rule --
 * selectable by id, configurable, severable, ignorable -- because nothing
 * downstream can tell where a rule came from.
 */
export const rules: ReadonlyArray<Rule> = [
  {
    id: "example/one-thing",
    severity: "warn",
    description: "An opinion that ships with the repository, not with joggle.",
    judged: false,
    run: () =>
      Effect.succeed({
        diagnostics: [],
        notes: ["example/one-thing ran from a plugin"],
        drops: [],
      }),
  },
]
