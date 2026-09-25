import { Effect } from "effect"
import { Decision } from "effect/unstable/ai"
import { Atoms } from "../atoms.ts"
import { policy } from "../policy.ts"
import { verdictsOf, type Plan } from "../plans.ts"
import { verdictOf } from "../verdict.ts"
import {
  budgetNote,
  finding,
  outcome,
  qualityOf,
  type DecisionAnswers,
  type PlannedRule,
  type Scope,
} from "../rule.ts"
import { canCompose } from "./compose-types.ts"
import type { Diagnostic, Drop, SourceLocation } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/field-type-drift"

// One field name declared with two incompatible types.
//
// A field name is a promise about meaning. When `projectId` is a `string` in one
// declaration and a `number` in another, code that moves between them compiles
// against whichever it imported and fails against the other.
//
// What is deterministic is the detection. Field types are compared after the
// index's own resolution (indexed access, local alias, union), a nullability
// difference counts, raw mirrors are skipped, and only declarations that can
// reach each other are related. What is a JUDGEMENT is what the disagreement
// means: one concept declared twice, two concepts sharing a name, or a deliberate
// difference that breaks nothing.
//
// That judgement is the one this rule used to make for the reader, and it is the
// reason the migration is cautious: an earlier experiment asking a concept
// question here produced MORE findings, not fewer (the model answered "one
// concept" about 85% of the time), so the question is worded to let it decline
// (`compatible`) and a non-decisive answer is flagged rather than printed. See
// `docs/type-resolution.md`.

/**
 * Whether a type admits `null`, which is a value rather than absent.
 *
 * `undefined` is deliberately NOT counted: `T | undefined` and `T?` are the same
 * optionality.
 */
const admitsNull = (text: string): boolean => /\bnull\b/.test(text)

const related = (
  left: Declaration,
  right: Declaration,
  workspace: Workspace,
  reachable: ReadonlySet<string>,
  isTest: (file: string) => boolean,
): boolean => {
  if (left.file === right.file) return true
  if (isTest(left.file) !== isTest(right.file)) return false
  if (reachable.has(left.file + "\u0000" + right.file)) return true
  if (reachable.has(right.file + "\u0000" + left.file)) return true
  const packageOf = (file: string): string => {
    const cut = file.lastIndexOf("/")
    return workspace.manifests.get(cut === -1 ? "." : file.slice(0, cut))?.name ?? ""
  }
  const leftPackage = packageOf(left.file)
  return leftPackage !== "" && leftPackage === packageOf(right.file)
}

/** The words a name is built from: `supervisorRate` is two, `files` is one. */
const wordsOf = (name: string): ReadonlyArray<string> =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")

/** Whether a declaration's name marks it as a raw mirror of something else. */
const isRawName = (name: string): boolean =>
  policy.fieldTypeDrift.rawPrefixes.some((prefix) => name.startsWith(prefix)) ||
  policy.fieldTypeDrift.rawSuffixes.some((suffix) => name.endsWith(suffix))

const normalizeType = (text: string): string =>
  text.replace(/^\s*:\s*/, "").replace(/\s+/g, " ").trim()

/** An indexed access, `T['k']`, which reads a field's type out of `T`. */
const indexedPattern = /^([A-Za-z_$][\w$]*)\s*\[\s*['"]([^'"]+)['"]\s*\]$/

const barePattern = /^[A-Za-z_$][\w$]*$/

const aliasTargetOf = (text: string): string => {
  const match = /^\s*(?:export\s+)?(?:declare\s+)?type\s+\w+(?:\s*<[^>]*>)?\s*=\s*([\s\S]*)$/.exec(
    text,
  )
  const rhs = match?.[1]
  return rhs === undefined ? "" : rhs.replace(/;\s*$/, "").trim()
}

/** Split on a top-level `|`, respecting nesting so `Array<A | B>` stays whole. */
const unionParts = (text: string): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? ""
    if (character === "<" || character === "(" || character === "[" || character === "{") depth += 1
    else if ((character === ">" || character === ")" || character === "]" || character === "}") && depth > 0) {
      depth -= 1
    } else if (depth === 0 && character === "|") {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part !== "")
}

const resolveType = (
  text: string,
  byName: ReadonlyMap<string, Unit>,
  seen: Set<string>,
  depth = 0,
): string => {
  const current = normalizeType(text)
  if (depth >= 6 || seen.has(current)) return current
  seen.add(current)

  if (current.includes("|")) {
    const parts = unionParts(current)
    if (parts.length > 1) {
      return parts.map((part) => resolveType(part, byName, new Set(seen), depth + 1)).join(" | ")
    }
  }

  const indexed = indexedPattern.exec(current)
  if (indexed !== null) {
    const target = indexed[1] === undefined ? undefined : byName.get(indexed[1])
    const annotation =
      target === undefined || indexed[2] === undefined ? undefined : target.fieldTypes.get(indexed[2])
    return annotation === undefined ? current : resolveType(annotation, byName, seen, depth + 1)
  }

  if (barePattern.test(current)) {
    const target = byName.get(current)
    const rhs = target === undefined ? "" : aliasTargetOf(target.text)
    if (rhs !== "" && rhs !== current) return resolveType(rhs, byName, seen, depth + 1)
  }
  return current
}

/** True when a type is computed by the type system rather than written down. */
const isDerivedType = (text: string): boolean =>
  /\btypeof\b|\bkeyof\b|z\.infer|Schema\.Schema\.(Type|Encoded)/.test(text)

/** True when a type is an indexed access the index could not follow. */
const isUnresolvedIndexed = (text: string): boolean => indexedPattern.test(normalizeType(text))

interface Declaration {
  readonly type: string
  readonly unit: string
  readonly file: string
  readonly line: number
}

/** One field whose two declarations disagree. */
interface Drift {
  readonly field: string
  readonly left: Declaration
  readonly right: Declaration
}

export const fieldTypeDrift: PlannedRule = {
  id: RULE_ID,
  severity: "warn",
  description: "One field name declared with different, incompatible types.",
  judged: true,
  onUnavailable: "report",
  plan: Effect.fn("joggle/field-type-drift")(function* (workspace: Workspace, scope: Scope) {
    const byField = new Map<string, Map<string, Array<Declaration>>>()
    for (const unit of workspace.units) {
      if (unit.kind !== "interface" && unit.kind !== "type") continue
      for (const [field, annotation] of unit.fieldTypes) {
        const type = annotation.trim()
        if (type === "" || type === field) continue
        const types = byField.get(field) ?? new Map<string, Array<Declaration>>()
        const declarations = types.get(type) ?? []
        declarations.push({ type, unit: unit.name, file: unit.file, line: unit.location.line })
        types.set(type, declarations)
        byField.set(field, types)
      }
    }

    if (byField.size === 0) {
      return {
        plans: [],
        read: () =>
          outcome([], ["no interface or type alias declared a field with a type to compare"]),
      }
    }

    const byName = new Map<string, Unit>()
    for (const unit of workspace.units) {
      if (unit.kind !== "interface" && unit.kind !== "type") continue
      if (!byName.has(unit.name)) byName.set(unit.name, unit)
    }
    const reachable = new Set<string>()
    for (const edge of workspace.imports.edges) {
      if (edge.resolved) reachable.add(edge.from + "\u0000" + edge.to)
    }
    const isTest = (file: string): boolean => policy.testFiles.test(file)

    // Group by the declaration the finding is anchored to: a type with five
    // drifting fields is one thing a reader has to decide, not five.
    const groups = new Map<string, { file: string; line: number; unit: string; drifts: Array<Drift> }>()
    let unrelated = 0
    let drifted = 0
    for (const [field, types] of byField) {
      if (types.size < 2) continue
      if (wordsOf(field).length < policy.fieldTypeDrift.minWords) continue
      const entries = [...types.entries()]
      let pair: readonly [string, string] | undefined
      for (let left = 0; left < entries.length && pair === undefined; left += 1) {
        for (let right = left + 1; right < entries.length; right += 1) {
          const one = entries[left]
          const two = entries[right]
          if (one === undefined || two === undefined) continue
          const oneType = resolveType(one[0], byName, new Set())
          const twoType = resolveType(two[0], byName, new Set())
          if (isUnresolvedIndexed(oneType) || isUnresolvedIndexed(twoType)) continue
          if (isDerivedType(oneType) && isDerivedType(twoType)) continue
          if (admitsNull(oneType) !== admitsNull(twoType) || !canCompose(oneType, twoType)) {
            pair = [one[0], two[0]]
            break
          }
        }
      }
      if (pair === undefined) continue
      const byType = new Map(entries)
      const left = byType.get(pair[0])?.[0]
      const right = byType.get(pair[1])?.[0]
      if (left === undefined || right === undefined) continue
      if (left.file === right.file && left.unit === right.unit) continue
      if (isRawName(left.unit) || isRawName(right.unit)) continue
      if (!related(left, right, workspace, reachable, isTest)) {
        unrelated += 1
        continue
      }
      if (scope.changed !== undefined && !(scope.changed.has(left.file) || scope.changed.has(right.file))) {
        continue
      }
      drifted += 1
      const key = left.file + "\u0000" + String(left.line)
      const group = groups.get(key) ?? { file: left.file, line: left.line, unit: left.unit, drifts: [] }
      group.drifts.push({ field, left, right })
      groups.set(key, group)
    }

    if (groups.size === 0) {
      return {
        plans: [],
        read: () =>
          outcome([], [
            byField.size + " field name(s) across the type declarations; none with incompatible types" +
              (unrelated > 0
                ? ", " + unrelated + " skipped because the declarations cannot reach each other"
                : ""),
          ]),
      }
    }

    const candidates = [...groups.values()]
    const judged = candidates.slice(0, policy.fieldTypeDrift.maxFindings)
    const overBudget: ReadonlyArray<Drop> = candidates
      .slice(policy.fieldTypeDrift.maxFindings)
      .map((group) => ({
        ruleId: RULE_ID,
        subject: group.unit + " (" + group.file + ":" + String(group.line) + ")",
        stage: "budget" as const,
        reason: "past the budget of " + String(policy.fieldTypeDrift.maxFindings) + " declarations",
      }))

    const atoms = yield* Atoms
    const planned = yield* Effect.forEach(judged, (group) =>
      Effect.gen(function* () {
        // The state is the drifts themselves, bounded, each with the two
        // declarations and the resolved types, which is what the question needs.
        const drifts = group.drifts.slice(0, 5).map((drift) => ({
          field: drift.field,
          left: { unit: drift.left.unit, file: drift.left.file, line: drift.left.line, type: drift.left.type },
          right: { unit: drift.right.unit, file: drift.right.file, line: drift.right.line, type: drift.right.type },
        }))
        const id = yield* atoms.add({ declaration: { unit: group.unit, file: group.file, line: group.line }, drifts })
        const plan: Plan<DecisionAnswers> = {
          ruleId: RULE_ID,
          subject: group.unit + " (" + group.file + ":" + String(group.line) + ")",
          concerns: [...new Set(group.drifts.flatMap((drift) => [drift.left.file, drift.right.file]))],
          atoms: [id],
          decisions: {
            verdict: Decision.classify({
              instructions: [
                `\`atoms[${id}].drifts\` lists field(s) declared with two different types in two declarations that can reach each other.`,
                "What does each disagreement mean?",
                "Answer `drift` when the same concept is written with two incompatible types, so code that moves between the declarations breaks.",
                "Answer `two_concepts` when one name has been reused for two different things, so one of them should be renamed.",
                "Answer `compatible` when the difference is deliberate and nothing breaks -- a raw or unparsed mirror, a wider or partial variant, a type that only reads differently.",
              ].join("\n"),
              criteria: {
                drift: "One concept, two incompatible types. Share one declaration of it.",
                two_concepts: "One name, two different things. Rename one.",
                compatible: "A deliberate difference. Nothing breaks.",
              },
            }),
          },
          read: (answers) => answers,
        }
        return { group, id, plan }
      }),
      { concurrency: "unbounded" },
    )

    return {
      plans: planned.map((value) => value.plan),
      read: (answers) => {
        const verdicts = verdictsOf<DecisionAnswers>(answers)
        const diagnostics: Array<Diagnostic> = []
        const drops: Array<Drop> = [...overBudget]
        planned.forEach((value, index) => {
          const { group } = value
          const subject = group.unit + " (" + group.file + ":" + String(group.line) + ")"
          const answer = verdicts[index]
          const verdict = verdictOf(answer?.["verdict"], ["drift", "two_concepts"])
          if (verdict === undefined) {
            diagnostics.push(findingFor(group, undefined, "no judgement was available"))
            return
          }
          if (verdict.label !== "drift" && verdict.label !== "two_concepts") {
            drops.push({
              ruleId: RULE_ID,
              subject,
              stage: "declined",
              reason: "the difference is deliberate and nothing breaks",
            })
            return
          }
          const quality = qualityOf({
            score: verdict.probability,
            margin: verdict.margin,
            confidence: verdict.confidence,
          })
          if (quality.quality !== "act") {
            drops.push({
              ruleId: RULE_ID,
              subject,
              stage: "gated",
              reason: quality.quality === "review" ? "flagged: " + quality.reason : quality.reason,
            })
            return
          }
          const renamed = verdict.label === "two_concepts"
          diagnostics.push(findingFor(group, verdict.confidence, undefined, renamed))
        })
        return outcome(
          diagnostics,
          [
            byField.size + " field name(s) across the type declarations; " + drifted + " with incompatible types",
            ...(unrelated > 0
              ? [
                  unrelated +
                    " were skipped: the two declarations are in different packages and neither imports the other",
                ]
              : []),
            ...budgetNote(
              "declarations",
              policy.fieldTypeDrift.maxFindings,
              candidates.length,
              candidates
                .slice(policy.fieldTypeDrift.maxFindings)
                .map((group) => group.unit),
            ),
          ],
          drops,
        )
      },
    }
  }),
}

const findingFor = (
  group: { readonly file: string; readonly line: number; readonly unit: string; readonly drifts: ReadonlyArray<Drift> },
  confidence: number | undefined,
  unverifiedReason: string | undefined,
  renamed = false,
): Diagnostic => {
  const first = group.drifts[0]
  if (first === undefined) {
    return finding({
      ruleId: RULE_ID,
      severity: "warn",
      message: group.unit + " has a field declared with two incompatible types.",
      location: { file: group.file, line: group.line, column: 1 },
      judged: false,
    })
  }
  const message =
    group.drifts.length === 1
      ? "`" +
        first.field +
        "` is `" +
        first.left.type +
        "` in " +
        first.left.unit +
        " and `" +
        first.right.type +
        "` in " +
        first.right.unit +
        "."
      : group.drifts.length +
        " field(s) of " +
        group.unit +
        " disagree with another declaration: " +
        group.drifts
          .slice(0, 3)
          .map((drift) => "`" + drift.field + "` (`" + drift.left.type + "` vs `" + drift.right.type + "`)")
          .join(", ") +
        (group.drifts.length > 3 ? ", and " + String(group.drifts.length - 3) + " more" : "") +
        "."
  const where = group.drifts
    .map(
      (drift) =>
        drift.field +
        ": " +
        drift.left.file +
        ":" +
        String(drift.left.line) +
        " and " +
        drift.right.file +
        ":" +
        String(drift.right.line),
    )
    .join("; ")
  const location: SourceLocation = { file: group.file, line: group.line, column: 1 }
  const input: Parameters<typeof finding>[0] = {
    ruleId: RULE_ID,
    severity: "warn",
    message,
    help:
      (renamed
        ? "One name, two different things. Rename one of them so each field name means one thing. "
        : "One field name, two incompatible types. If they are one concept, share one declaration of it; if they are two concepts, give them two names. ") +
      where +
      "." +
      (unverifiedReason === undefined ? "" : " Not verified: " + unverifiedReason + "."),
    location,
    identity: [
      RULE_ID,
      group.file,
      String(group.line),
      ...group.drifts.map((drift) => drift.field).sort((left, right) => left.localeCompare(right)),
    ].join("\u0000"),
    judged: unverifiedReason === undefined,
  }
  return confidence === undefined ? finding(input) : finding({ ...input, confidence })
}