import { expect, test } from "vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { loadWorkspace } from "../src/workspace.ts"

const fixtures = "tests/fixtures/javascript"

const workspace = () =>
  Effect.runPromise(loadWorkspace(fixtures, ["."]).pipe(Effect.provide(NodeServices.layer)))

test("a `.js` file with JSX and a `.jsx` file both parse", async () => {
  const loaded = await workspace()
  const paths = loaded.files.map((file) => file.path).sort()
  // The `.js` one is the point: JSX in it is legal under the configs most React
  // apps use, and the first reading as plain JS is rejected by the parser.
  expect(paths).toContain("with-jsx.js")
  expect(paths).toContain("component.jsx")
  expect(paths).not.toContain("broken.js")
})

test("a declaration in JavaScript carries no type signal", async () => {
  const loaded = await workspace()
  const card = loaded.units.find((unit) => unit.name === "Card")
  expect(card).toBeDefined()
  // This is what makes a shape match in a JS codebase weaker evidence, and the
  // finding now says so rather than presenting it as typed evidence.
  expect(card?.typed).toBe(false)
  expect(card?.typeRefs).toEqual([])
})

test("a file the parser rejects is reported, not silently empty", async () => {
  const loaded = await workspace()
  // Before this, the parse result's `errors` array was never read: a file the
  // parser rejected looked exactly like a file with nothing in it, and every
  // rule's view of the repository had a hole nobody could see.
  expect(loaded.unparsed.length).toBe(1)
  expect(loaded.unparsed[0]?.path).toBe("broken.js")
  expect(loaded.unparsed[0]?.reason.length).toBeGreaterThan(0)
})

test("the rejection and the files it rejected are counted together", async () => {
  const loaded = await workspace()
  expect(loaded.files.length + loaded.unparsed.length).toBe(3)
})
