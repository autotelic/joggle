import { test } from "vitest"
import { Option, Schema } from "effect"
import { writeFileSync } from "node:fs"

const AstNode = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
])
const decodeNode = Schema.decodeUnknownOption(AstNode)

const node = { type: "Identifier", start: 1, end: 2, name: "x", extra: [1, 2, 3] }
const N = 1_000_000

test("probe", () => {
  let sink = 0
  const t0 = performance.now()
  for (let i = 0; i < N; i += 1) {
    const value = node as unknown
    if (typeof value === "object" && value !== null && !Array.isArray(value)) sink += 1
  }
  const typeofNs = performance.now() - t0

  const t1 = performance.now()
  for (let i = 0; i < N; i += 1) {
    const value = node as unknown
    if (Option.isSome(decodeNode(value))) sink += 1
  }
  const schemaNs = performance.now() - t1

  writeFileSync(
    "/tmp/probe.txt",
    "typeof check: " + (typeofNs / N * 1e6).toFixed(0) + " ns/op\n" +
      "schema decode: " + (schemaNs / N * 1e6).toFixed(0) + " ns/op\n" +
      "ratio: " + (schemaNs / typeofNs).toFixed(1) + "x\n" +
      "sink " + sink + "\n",
  )
})
