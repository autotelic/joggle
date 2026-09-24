import { Effect } from "effect"
import { parseSync } from "oxc-parser"
import { Decision } from "effect/unstable/ai"
import { Atoms } from "../atoms.ts"
import { policy } from "../policy.ts"
import { verdictsOf, type Plan } from "../plans.ts"
import {
  budgetNote,
  finding,
  marginOfAnswer,
  outcome,
  qualityOf,
  type DecisionAnswers,
  type PlannedRule,
  type Scope,
} from "../rule.ts"
import { dataErrorVocabulary } from "../vocabulary.ts"
import type { Diagnostic, Drop } from "../schema.ts"
import type { Workspace } from "../workspace.ts"

const RULE_ID = "joggle/data-error-as-outage"

// 
// A 5xx for a row that is simply not there.
// 
// The amplifier the nullability work cannot see. A missing row is a normal
// outcome -- somebody deleted it, or the id is wrong -- and answering "the server
// is broken" turns one bad request into an outage signal: pagers, error budgets,
// retries against a request that will never succeed. The endpoint is confidently
// answering the wrong question.
// 
// Deterministic CANDIDATE: a branch guarded by a lookup's absence whose body
// emits a 5xx. All three are syntax. The JUDGEMENT is whether an absent row here
// is a normal outcome or a broken invariant, which is meaning, and it is exactly
// what Jev is for. State is the handler's source, the guarded declaration and the
// status; the answer is one Choice; code keeps control of what it does with it.
// 
// Generic by construction: nothing here knows Fastify, Express or a schema
// library. It reads a nullish guard on a call whose name says it reads a row, and
// a numeric status. A repository that names things otherwise teaches the rule by
// adding to the lists in policy.

/** The method names that emit an HTTP status. */
const STATUS_METHODS = new Set(["code", "status", "statusCode"])

/** The node kinds that make a scope for the lookup bindings. */
const FUNCTION_KINDS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The name a call names, bare or dotted: `getComments` -> `getComments`,
 * `reply.code` -> `code`.
 *
 * Both matter. A read is as often a bare `getComments(...)` or
 * `parsePersonPayrollRecord(...)` as it is `db.findById(...)`, and reading only
 * the property of a member call sees neither bare form.
 */
const calleeName = (callee: unknown): string | undefined => {
  if (!isRecord(callee)) return undefined
  if (callee["type"] === "Identifier" && typeof callee["name"] === "string") return callee["name"]
  if (callee["type"] !== "MemberExpression") return undefined
  const property = callee["property"]
  return isRecord(property) && typeof property["name"] === "string" ? property["name"] : undefined
}

const isLookupMethod = (method: string | undefined): boolean =>
  method !== undefined &&
  (policy.dataError.lookupPrefixes.some((prefix) => method.startsWith(prefix)) ||
    policy.dataError.lookupNames.some((name) => name === method))

/**
 * The call names that DECODE a row: `Schema.decodeUnknownResult`, `parsePerson`.
 *
 * A `catch` around a decode is the shape that amplified the payroll bug: a null
 * in a row made the decode throw, and the throw became a 500. So a decode counts
 * as reading a row even when no lookup is named.
 */
const isDecodeMethod = (method: string | undefined): boolean =>
  method !== undefined && (method.startsWith("decode") || method.startsWith("parse"))

/**
 * Visit every node under `root` that is NOT inside a nested function.
 *
 * The lookup bindings, the guard and the status have to belong to the SAME
 * handler. A walk that descends into nested functions attributes an inner
 * callback's status to an outer handler, which is a candidate that never existed.
 */
const eachOwn = (root: unknown, visit: (node: Record<string, unknown>) => void): void => {
  const stack: Array<unknown> = []
  const pushChildren = (node: Record<string, unknown>): void => {
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === "object") stack.push(value)
    }
  }
  if (!isRecord(root)) return
  pushChildren(root)
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child)
      continue
    }
    if (!isRecord(node)) continue
    // A nested function is a new scope: do not read its body as this one's.
    if (FUNCTION_KINDS.has(String(node["type"]))) continue
    visit(node)
    pushChildren(node)
  }
}

/** The variable a nullish guard tests: `!row`, `row == null`, `row === undefined`. */
const guardedVariable = (test: unknown): string | undefined => {
  if (!isRecord(test)) return undefined
  if (test["type"] === "UnaryExpression" && test["operator"] === "!" && isRecord(test["argument"])) {
    const argument = test["argument"]
    return argument["type"] === "Identifier" && typeof argument["name"] === "string"
      ? argument["name"]
      : undefined
  }
  if (test["type"] === "BinaryExpression") {
    const operator = test["operator"]
    if (operator !== "==" && operator !== "===" && operator !== "!=" && operator !== "!==") return undefined
    const sides = [test["left"], test["right"]]
    const identifier = sides.find(
      (side): side is Record<string, unknown> => isRecord(side) && side["type"] === "Identifier",
    )
    const nullish = sides.some((side) => {
      if (!isRecord(side)) return false
      if (side["type"] === "Literal") {
        const value = side["value"]
        const raw = side["raw"]
        return value === null || raw === "null" || raw === "undefined"
      }
      return side["type"] === "Identifier" && side["name"] === "undefined"
    })
    return nullish && identifier !== undefined && typeof identifier["name"] === "string"
      ? identifier["name"]
      : undefined
  }
  return undefined
}

/** The 5xx emitted in this subtree: `.code(500)` or `x.statusCode = 503`. */
const outageIn = (root: unknown): number | undefined => {
  let found: number | undefined
  eachOwn(root, (node) => {
    if (found !== undefined) return
    if (node["type"] === "CallExpression" && STATUS_METHODS.has(calleeName(node["callee"]) ?? "")) {
      const args = node["arguments"]
      const first = Array.isArray(args) ? args[0] : undefined
      if (isRecord(first) && first["type"] === "Literal" && typeof first["value"] === "number") {
        const code = first["value"]
        if (code >= 500 && code <= 599) found = code
      }
    }
    if (node["type"] === "AssignmentExpression" && isRecord(node["left"]) && isRecord(node["right"])) {
      const left = node["left"]
      const right = node["right"]
      if (
        isRecord(left["property"]) &&
        left["property"]["name"] === "statusCode" &&
        right["type"] === "Literal" &&
        typeof right["value"] === "number" &&
        right["value"] >= 500 &&
        right["value"] <= 599
      ) {
        found = right["value"]
      }
    }
  })
  return found
}

export interface Outage {
  readonly file: string
  readonly line: number
  readonly handler: string
  /** How the 5xx is reached: a nullish guard, or a catch around a row read. */
  readonly reached: "guard" | "catch"
  /** The guarded binding (`row`), or the read (`findById`) a catch wraps. */
  readonly trigger: string
  readonly code: number
  /** The handler's source, bounded, which is the state the question reads. */
  readonly source: string
}

/**
 * The first call in this subtree that reads or decodes a row, or "".
 *
 * A DEEP walk, unlike `eachOwn`: the read is often inside a callback the try
 * hands to a helper -- `profiler.timeStep('Query comments', () => getComments(...))`
 * -- and skipping nested functions there would see no read at all. Attribution
 * matters for the 5xx (it must be the handler's), not for the read (any read the
 * try performs is one the catch will answer for).
 */
const rowReadIn = (root: unknown): string => {
  let method = ""
  const stack: Array<unknown> = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child)
      continue
    }
    if (!isRecord(node)) continue
    if (method === "" && node["type"] === "CallExpression") {
      const name = calleeName(node["callee"])
      if (isLookupMethod(name) || isDecodeMethod(name)) method = name ?? ""
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === "object") stack.push(value)
    }
  }
  return method
}

/**
 * One candidate per handler: a lookup's result guarded for absence, and a 5xx
 * inside that guard.
 *
 * A file is parsed a second time only after the facts already indexed say it
 * could hold a candidate, so the extra parse is paid on the handful of files
 * that emit statuses and read rows rather than on every file.
 */
const candidatesIn = (workspace: Workspace, scope: Scope): ReadonlyArray<Outage> => {
  const found: Array<Outage> = []
  for (const file of workspace.files) {
    if (scope.changed !== undefined && !scope.changed.has(file.path)) continue
    const names = file.facts.callSites.map((site) => site.name.split(".").at(-1) ?? "")
    if (!names.some((name) => STATUS_METHODS.has(name)) && !file.text.includes("statusCode")) continue
    if (!names.some((name) => isLookupMethod(name))) continue

    const parsed = parseSync(file.path, file.text)
    if (parsed.errors.length > 0) continue

    // Each function WITH its parent, so an anonymous handler can be named from
    // the call it was handed to -- `fastify.decorate('getComments', async ...)` is
    // `getComments`, and `fastify.get('/api/x', async ...)` names the route.
    const functions: Array<{
      readonly node: Record<string, unknown>
      readonly parent: Record<string, unknown> | undefined
    }> = []
    const collect = (root: unknown): void => {
      const stack: Array<readonly [unknown, Record<string, unknown> | undefined]> = [[root, undefined]]
      while (stack.length > 0) {
        const [node, parent] = stack.pop() as readonly [unknown, Record<string, unknown> | undefined]
        if (Array.isArray(node)) {
          for (const child of node) stack.push([child, parent])
          continue
        }
        if (!isRecord(node)) continue
        if (FUNCTION_KINDS.has(String(node["type"]))) functions.push({ node, parent })
        for (const value of Object.values(node)) {
          if (value !== null && typeof value === "object") stack.push([value, node])
        }
      }
    }
    collect(parsed.program)

    /** A name for an anonymous handler, from the call it was handed to. */
    const nameFromCaller = (parent: Record<string, unknown> | undefined): string | undefined => {
      if (!isRecord(parent) || parent["type"] !== "CallExpression") return undefined
      const args = parent["arguments"]
      if (Array.isArray(args)) {
        for (const arg of args) {
          if (isRecord(arg) && typeof arg["value"] === "string" && arg["value"] !== "") return arg["value"]
        }
      }
      return calleeName(parent["callee"])
    }

    for (const { node: handler, parent: handlerParent } of functions) {
      const start = handler["start"]
      if (typeof start !== "number") continue
      const body = handler["body"]
      if (body === undefined) continue

      const lookups = new Set<string>()
      eachOwn(body, (node) => {
        if (node["type"] !== "VariableDeclarator" || !isRecord(node["id"])) return
        const id = node["id"]
        if (id["type"] !== "Identifier" || typeof id["name"] !== "string") return
        let init: unknown = node["init"]
        if (isRecord(init) && init["type"] === "AwaitExpression") init = init["argument"]
        if (isRecord(init) && init["type"] === "CallExpression" && isLookupMethod(calleeName(init["callee"]))) {
          lookups.add(id["name"])
        }
      })
      const line = file.text.slice(0, start).split("\n").length
      const handlerName =
        isRecord(handler["id"]) && typeof handler["id"]["name"] === "string"
          ? handler["id"]["name"]
          : (nameFromCaller(handlerParent) ?? "handler")
      const source = file.text.slice(
        start,
        Math.min(file.text.length, start + policy.evidence.maxSourceChars),
      )
      let candidate: Outage | undefined
      // Narrower first: a guard on a lookup's own result.
      if (lookups.size > 0) {
        eachOwn(body, (node) => {
          if (candidate !== undefined || node["type"] !== "IfStatement") return
          const guarded = guardedVariable(node["test"])
          if (guarded === undefined || !lookups.has(guarded)) return
          const code = outageIn(node["consequent"])
          if (code === undefined) return
          candidate = {
            file: file.path,
            line,
            handler: handlerName,
            reached: "guard",
            trigger: guarded,
            code,
            source,
          }
        })
      }
      // Wider: a catch whose try reads or decodes a row, and whose body answers a
      // 5xx. This is the shape that amplified the payroll bug -- a null in a row
      // threw in the decode and the throw became a 500.
      if (candidate === undefined) {
        eachOwn(body, (node) => {
          if (candidate !== undefined || node["type"] !== "TryStatement") return
          const block = node["block"]
          const handlerNode = node["handler"]
          if (!isRecord(handlerNode)) return
          const read = rowReadIn(block)
          if (read === "") return
          const code = outageIn(handlerNode["body"])
          if (code === undefined) return
          candidate = {
            file: file.path,
            line,
            handler: handlerName,
            reached: "catch",
            trigger: read,
            code,
            source,
          }
        })
      }
      if (candidate !== undefined) found.push(candidate)
    }
  }
  // Two handlers can share a start line once nested functions are in play; the
  // identity is the file and the line, so one candidate is kept.
  const seen = new Set<string>()
  return found.filter((entry) => {
    const key = entry.file + "\u0000" + String(entry.line)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const labelOf = (outage: Outage): string => outage.handler + " (" + outage.file + ":" + String(outage.line) + ")"

/** How the 5xx is reached, in the reader's terms. */
const describe = (outage: Outage): string =>
  outage.reached === "guard"
    ? "when `" + outage.trigger + "` is empty"
    : "when its row read (`" + outage.trigger + "`) fails"

const findingFor = (outage: Outage, unverified: string | undefined): Diagnostic =>
  finding({
    ruleId: RULE_ID,
    severity: "warn",
    message:
      "`" +
      outage.handler +
      "` answers " +
      String(outage.code) +
      " " +
      describe(outage) +
      ", so a fact about a row reads as a server outage.",
    help:
      "A lookup that finds nothing is usually a normal outcome: a 404, an empty list, or a 4xx the caller caused. If the absence really is a broken invariant, say so here; otherwise answer the request. " +
      (unverified === undefined
        ? "Pin a deliberate 5xx in .joggle/answers.json so the question is not asked again."
        : "Not verified: " + unverified + "."),
    location: { file: outage.file, line: outage.line, column: 1 },
    identity: [RULE_ID, outage.file, outage.handler, String(outage.code)].join("\u0000"),
    judged: unverified === undefined,
  })

export const dataErrorAsOutage: PlannedRule = {
  id: RULE_ID,
  severity: "warn",
  description: "A 5xx answer to a row that is simply not there.",
  judged: true,
  onUnavailable: "report",
  plan: Effect.fn("joggle/data-error-as-outage")(function* (
    workspace: Workspace,
    scope: Scope,
  ) {
    const all = candidatesIn(workspace, scope)
    if (all.length === 0) {
      return {
        plans: [],
        read: () =>
          outcome([], [
            "no handler answers a 5xx for a guarded lookup: the guard and the status did not meet",
          ]),
      }
    }

    const budget = policy.dataError.maxHandlers
    const judged = all.slice(0, budget)
    const overBudget: ReadonlyArray<Drop> = all.slice(budget).map((outage) => ({
      ruleId: RULE_ID,
      subject: labelOf(outage),
      stage: "budget" as const,
      reason: "past the budget of " + String(budget) + " handlers",
    }))

    const atoms = yield* Atoms
    const planned: Array<{ readonly outage: Outage; readonly plan: Plan<DecisionAnswers> }> = []
    for (const outage of judged) {
      const id = yield* atoms.add({
        handler: outage.handler,
        reached: outage.reached,
        status: outage.code,
        trigger: outage.trigger,
        source: outage.source,
      })
      const reading =
        outage.reached === "guard"
          ? `It reads a row (the result is bound to \`atoms[${id}].trigger\`) and answers \`atoms[${id}].status\` when that row is empty.`
          : `It reads or decodes a row (\`atoms[${id}].trigger\`) inside a \`try\`, and answers \`atoms[${id}].status\` in the \`catch\`.`
      planned.push({
        outage,
        plan: {
          ruleId: RULE_ID,
          subject: labelOf(outage),
          concerns: [outage.file],
          atoms: [id],
          decisions: {
            verdict: Decision.classify({
              instructions: [
                `\`atoms[${id}].source\` is an HTTP handler. ${reading}`,
                "Is the row's absence a normal outcome, or a broken invariant?",
                "Answer `row_absence_is_normal` when the request can legitimately name a row that is not there -- a wrong id, a deleted record, an empty result set -- or when the caught failure is the data being absent or undecodable rather than the server being down.",
                "Answer `row_absence_is_an_error` when an empty row here means data that must exist does not, or when the caught failure is a genuine server fault, so a 5xx is honest.",
                "Answer `not_applicable` when the branch is not about a row's absence.",
              ].join("\n"),
              criteria: dataErrorVocabulary,
            }),
          },
          read: (answers) => answers,
        },
      })
    }

    return {
      plans: planned.map((entry) => entry.plan),
      read: (answers) => {
        const verdicts = verdictsOf<DecisionAnswers>(answers)
        const diagnostics: Array<Diagnostic> = []
        const drops: Array<Drop> = [...overBudget]
        planned.forEach((entry, index) => {
          const outage = entry.outage
          const answer = verdicts[index]
          const verdict = answer === undefined ? undefined : answer["verdict"]
          if (verdict === undefined || !("label" in verdict)) {
            diagnostics.push(findingFor(outage, "no judgement was available"))
            return
          }
          if (verdict.label !== "row_absence_is_normal") {
            drops.push({
              ruleId: RULE_ID,
              subject: labelOf(outage),
              stage: "declined",
              reason:
                verdict.label === "not_applicable"
                  ? "the model read the branch as not about a row's absence"
                  : "the model read the absence as a broken invariant, so a 5xx is honest",
            })
            return
          }
          const score = verdict.probabilities[verdict.label] ?? 0
          const quality = qualityOf({
            score,
            margin: marginOfAnswer(verdict),
            confidence: verdict.confidence,
          })
          if (quality.quality === "drop") {
            drops.push({ ruleId: RULE_ID, subject: labelOf(outage), stage: "gated", reason: quality.reason })
            return
          }
          diagnostics.push(
            findingFor(outage, quality.quality === "act" ? undefined : quality.reason),
          )
        })
        return outcome(
          diagnostics,
          budgetNote(
            "handlers",
            budget,
            all.length,
            all.slice(budget).map(labelOf),
          ),
          drops,
        )
      },
    }
  }),
}
