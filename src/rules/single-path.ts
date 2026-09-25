import { Effect } from "effect"
import { Decision } from "effect/unstable/ai"
import { Atoms } from "../atoms.ts"
import { policy } from "../policy.ts"
import { verdictsOf, type Plan } from "../plans.ts"
import { locator, messages, reporter, type Report } from "../reporting.ts"
import {
  budgetNote,
  inScope,
  outcome,
  qualityOf,
  type DecisionAnswers,
  type PlannedRule,
  type Scope,
} from "../rule.ts"
import { verdictOf } from "../verdict.ts"
import type { Diagnostic, Drop } from "../schema.ts"
import type { Unit, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/single-path"

// A derived value written out longhand beside the helper that already derives it.
//
// The review case: a PR claimed "every table that prints money goes through
// `formatDollar`", and the reviewer found three screens that build the string
// themselves. A claimed single path that nothing enforces is a path that will
// drift -- the second formatter rounds differently, or keeps the sign on a zero,
// or uses a different locale -- and the divergence is invisible until somebody
// compares two screens.
//
// The deterministic half finds the two ends: the helpers that exist (a name that
// says money/percent/date, and a body that formats) and the sites that derive the
// same kind of value inline. The judgement is whether the site is that helper
// written out, or a local case the helper genuinely does not cover.
type Domain = "money" | "percent" | "date"

const DOMAINS: ReadonlyArray<Domain> = ["money", "percent", "date"]

/** A unit whose name says which kind of derived value it produces. */
const HELPER_NAME = {
  money: /^(format|shown|signed|display|render)?(Money|Dollar|Currency|Amount|Price|Cost)/i,
  percent: /^(format|shown|signed|display|render)?(Percent|Percentage|Rate|Ratio)/i,
  date: /^(format|shown|display|render)?(Date|DateTime|Day|When)/i,
} satisfies Record<Domain, RegExp>

/** A unit whose body actually formats that kind of value. */
const HELPER_BODY = {
  money: /Intl\.NumberFormat|currency\.format|toFixed\(|toLocaleString\(/,
  percent: /toFixed\(|%\s*[`"']|Intl\.NumberFormat/,
  date: /toLocaleDateString|toLocaleString\(|Intl\.DateTimeFormat/,
} satisfies Record<Domain, RegExp>

/**
 * A derived value written out at a call site.
 *
 * Deliberately literal: `$${`, `toFixed(2)`, `Intl.NumberFormat`, a `%` in the
 * same template. These are the shapes a formatter has, found in a place that is
 * not the formatter.
 */
const INLINE = {
  money: /\$\$\{|toFixed\(\s*2\s*\)|Intl\.NumberFormat|currency\.format/g,
  percent: /toFixed\(\s*[01]\s*\)\s*\+?\s*[`"']?%|`[^`\n]*\$\{[^}]+\}%/g,
  date: /toLocaleDateString\(|Intl\.DateTimeFormat/g,
} satisfies Record<Domain, RegExp>

interface Site {
  readonly unit: Unit
  readonly domain: Domain
  readonly start: number
  readonly snippet: string
}

const sitesIn = (unit: Unit): ReadonlyArray<Site> => {
  const found: Array<Site> = []
  for (const domain of DOMAINS) {
    // One site per unit and kind of value. A function with four hand-built money
    // strings has one problem -- it does not call the formatter -- not four.
    const pattern = INLINE[domain]
    pattern.lastIndex = 0
    const match = pattern.exec(unit.text)
    if (match === null) continue
    const start = match.index
    found.push({
      unit,
      domain,
      start,
      snippet: unit.text.slice(start, start + 90).split("\n")[0] ?? "",
    })
  }
  return found
}

export const singlePath: PlannedRule = {
  id: RULE_ID,
  severity: "warn",
  description: "A derived value written out beside the helper that already derives it.",
  judged: true,
  move: "contract",
  onUnavailable: "report",
  messages: messages({
    inline_derivation:
      "{{unit}} derives {{domain}} inline (`{{snippet}}`) though `{{helper}}` already does.",
    inline_derivation_help:
      "Call `{{helper}}` instead of building the string here. Two formatters drift: the second one rounds differently, keeps a sign on a zero, or uses another locale, and the difference is invisible until two screens are compared.{{unverified}}",
  }),
  plan: Effect.fn("joggle/single-path")(function* (workspace: Workspace, scope: Scope) {
    const report = reporter(singlePath, locator(workspace))

    // The helpers that exist, by the kind of value their name promises and their
    // body demonstrates.
    const helpers = new Map<Domain, Array<Unit>>()
    for (const unit of workspace.units) {
      if (unit.text.length > policy.evidence.maxSourceChars) continue
      for (const domain of DOMAINS) {
        if (!HELPER_NAME[domain].test(unit.name)) continue
        if (!HELPER_BODY[domain].test(unit.text)) continue
        const found = helpers.get(domain) ?? []
        found.push(unit)
        helpers.set(domain, found)
      }
    }

    const candidates: Array<{ site: Site; helpers: ReadonlyArray<Unit> }> = []
    for (const unit of workspace.units) {
      if (unit.kind !== "function") continue
      if (unit.text.length > policy.evidence.maxSourceChars) continue
      if (scope.changed !== undefined && !inScope(scope, unit.file)) continue
      for (const site of sitesIn(unit)) {
        // If the unit IS the helper, this is the one place it belongs.
        if (helpers.get(site.domain)?.some((helper) => helper === unit) === true) continue
        const available = (helpers.get(site.domain) ?? []).slice(0, policy.evidence.maxMembers)
        // A single path only exists when the path exists. No helper, no finding.
        if (available.length === 0) continue
        candidates.push({ site, helpers: available })
      }
    }

    if (candidates.length === 0) {
      return {
        plans: [],
        read: () =>
          outcome([], [
            "no unit derives money, a percent or a date inline where a helper of the same kind exists",
          ]),
      }
    }

    const budget = policy.evidence.maxMembers * 16
    const judged = candidates.slice(0, budget)
    const overBudget: ReadonlyArray<Drop> = candidates.slice(budget).map((candidate) => ({
      ruleId: RULE_ID,
      subject: candidate.site.unit.name,
      stage: "budget" as const,
      reason: "past the budget of " + String(budget) + " inline derivations",
    }))

    const atoms = yield* Atoms
    const planned = yield* Effect.forEach(
      judged,
      (candidate) =>
        Effect.gen(function* () {
          const { site, helpers: available } = candidate
          const listed = available.map((helper) => ({
            name: helper.name,
            file: helper.file,
            body: helper.text.slice(0, 240),
          }))
          const id = yield* atoms.add({
            site: { unit: site.unit.name, file: site.unit.file, domain: site.domain, snippet: site.snippet },
            helpers: listed,
          })
          const plan: Plan<DecisionAnswers> = {
            ruleId: RULE_ID,
            subject: site.unit.name + " (" + site.domain + ")",
            concerns: [site.unit.file, ...available.map((helper) => helper.file)],
            atoms: [id],
            violations: { verdict: ["reimplements"] },
            decisions: {
              verdict: Decision.classify({
                instructions: [
                  `\`atoms[${id}].site.snippet\` derives a ${site.domain} value inline, in \`atoms[${id}].site.unit\` (\`atoms[${id}].site.file\`).`,
                  `These helpers already derive ${site.domain}: \`atoms[${id}].helpers\` lists each with its body.`,
                  "Does the inline derivation re-implement one of them?",
                  "Answer `reimplements` when a listed helper produces the same value and the site should call it -- the rounding, the sign, the locale or the zero are the same question asked twice.",
                  "Answer `legitimate_local` when the helper genuinely does not cover this case: a different unit or locale, a value the helper would format wrongly, or a format the helper does not offer.",
                  "Answer `not_a_derivation` when the match is not a derived display value at all.",
                ].join("\n"),
                criteria: {
                  reimplements: "One of the helpers does this. Call it.",
                  legitimate_local: "The helper does not cover this case.",
                  not_a_derivation: "Not a derived display value.",
                },
              }),
            },
            read: (answers) => answers,
          }
          return { plan, site, available }
        }),
      { concurrency: "unbounded" },
    )

    return {
      plans: planned.map((entry) => entry.plan),
      read: (answers) => {
        const verdicts = verdictsOf<DecisionAnswers>(answers)
        const diagnostics: Array<Diagnostic> = []
        const drops: Array<Drop> = [...overBudget]
        planned.forEach((entry, index) => {
          const { site } = entry
          const subject = site.unit.name + " (" + site.domain + ")"
          const verdict = verdictOf(verdicts[index]?.["verdict"], ["reimplements"])
          if (verdict === undefined) {
            diagnostics.push(findingFor(report, entry, undefined, "no judgement was available"))
            return
          }
          if (verdict.label !== "reimplements") {
            drops.push({
              ruleId: RULE_ID,
              subject,
              stage: "declined",
              reason:
                verdict.label === "legitimate_local"
                  ? "the helper does not cover this case"
                  : "not a derived display value",
            })
            return
          }
          const quality = qualityOf({
            score: verdict.probability,
            margin: verdict.margin,
            confidence: verdict.confidence,
          })
          if (quality.quality === "drop") {
            drops.push({ ruleId: RULE_ID, subject, stage: "gated", reason: quality.reason })
            return
          }
          const review = quality.quality === "review"
          diagnostics.push(findingFor(report, entry, verdict.confidence, undefined, review))
        })
        return outcome(
          diagnostics,
          budgetNote(
            "inline derivations",
            budget,
            candidates.length,
            candidates.slice(budget).map((candidate) => candidate.site.unit.name),
          ),
          drops,
        )
      },
    }
  }),
}

const findingFor = (
  report: Report,
  entry: { readonly site: Site; readonly available: ReadonlyArray<Unit> },
  confidence: number | undefined,
  unverifiedReason: string | undefined,
  review = false,
): Diagnostic =>
  report({
    at: { file: entry.site.unit.file, start: entry.site.start },
    messageId: "inline_derivation",
    data: {
      unit: entry.site.unit.name,
      domain: entry.site.domain,
      snippet: entry.site.snippet,
      helper: entry.available[0]?.name ?? "the helper",
      unverified: unverifiedReason === undefined ? "" : " Not verified: " + unverifiedReason + ".",
    },
    helpId: "inline_derivation_help",
    identity: [RULE_ID, entry.site.unit.file, entry.site.unit.name, entry.site.domain].join("\u0000"),
    judged: unverifiedReason === undefined,
    confidence,
    severity: review ? "info" : "warn",
  })
