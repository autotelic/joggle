import { Effect } from "effect"
import { policy } from "../policy.ts"
import { Service as Judge } from "../judge.ts"
import {
  choiceOf,
  declined,
  defineRule,
  finding,
  inScope,
  marginOf,
  noulOf,
  outcome,
  qualityOf,
  type Scope,
} from "../rule.ts"
import type { Diagnostic, Drop, DropStage } from "../schema.ts"
import { pageQuestions, pageVerdictByRole } from "../vocabulary.ts"
import { baseOf, dirOf } from "../bundles.ts"
import type { Result } from "./cluster-verdict.ts"
import type { SourceFile, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/page-needs-composition"

/**
 * Does a page's own state and markup belong in a composition bundle?
 *
 * This is the CONSUMER half of the pattern, and the only half that needs a
 * judgement. The producer half is structural and is checked by bundle-conformance
 * with no model at all.
 *
 * The trigger matters more than the question. The first version asked about every
 * file under `routes/`: 1,216 candidates against Shakti's 280 real route and
 * modal files, 392 flagged, and 237 of those scored under 0.3 by the model -- it
 * was being asked whether pages follow a pattern that pages with no shared state
 * have no reason to follow. Now the rule only asks when a page carries enough
 * local state and inline markup that a bundle would pay for itself.
 */

/** A page is a route, a page, or a modal -- not merely something under routes/. */
const isPage = (file: string): boolean => /^(route|page)\.tsx?$/.test(baseOf(file)) || /modal/i.test(baseOf(file))

interface Page {
  readonly file: SourceFile
  readonly localState: number
  readonly inlineElements: number
  readonly lines: number
  readonly importsBundles: number
  readonly rendersProvider: boolean
}

const candidatesIn = (workspace: Workspace): ReadonlyArray<Page> => {
  const bundleDirs = new Set<string>()
  for (const file of workspace.files) {
    if (
      file.facts.callSites.some(
        (site) => site.name === "createContext" || site.name.endsWith(".createContext"),
      )
    ) {
      bundleDirs.add(dirOf(file.path))
    }
  }

  const { minLocalState, minInlineElements } = policy.pageNeedsComposition
  const pages: Array<Page> = []
  for (const file of workspace.files) {
    if (!isPage(file.path)) continue
    // Call SITES, not distinct names. This was counting a deduplicated set, so a
    // file with thirty-four useState calls reported one and the gate below --
    // which wants three -- could never be satisfied. The rule had never fired.
    const localState = file.facts.callSites.filter(
      (site) => site.name === "useState" || site.name.endsWith(".useState"),
    ).length
    const inlineElements = file.facts.jsx.length
    if (localState < minLocalState || inlineElements < minInlineElements) continue
    pages.push({
      file,
      localState,
      inlineElements,
      lines: file.text.split("\n").length,
      importsBundles: workspace.imports.edges.filter(
        (edge) => edge.from === file.path && edge.resolved && bundleDirs.has(dirOf(edge.to)),
      ).length,
      rendersProvider: file.facts.jsx.some((element) => element.endsWith(".Provider")),
    })
  }
  return pages
}

const gaps = (page: Page): ReadonlyArray<string> => {
  const found: Array<string> = []
  if (!page.rendersProvider) found.push("no provider as the composition root")
  if (page.importsBundles === 0) found.push("no blocks from a composition bundle")
  if (page.localState >= policy.pageNeedsComposition.minLocalState + 2) {
    found.push(`${page.localState} useState calls that a provider would own`)
  }
  return found
}

const findingFor = (
  page: Page,
  answers: Readonly<Record<string, import("../schema.ts").Answer>>,
): Result => {
  const dropOf = (stage: DropStage, reason: string): Result => ({
    drop: { ruleId: RULE_ID, subject: page.file.path, stage, reason },
  })
  const verdict = choiceOf(answers, "verdict")
  if (verdict === undefined) return dropOf("unreadable", "no verdict came back")
  if (declined(verdict.choice)) {
    return dropOf("declined", "the state is this page's own")
  }
  // The yes/no question is a verdict, not a ranking: when it says the extraction
  // is not worth a reviewer's time, there is no finding, however loudly the
  // Choice said `extract_to_bundle`.
  const quality = qualityOf({
    score: noulOf(answers, "worth_fixing") ?? verdict.confidence,
    margin: marginOf(answers, "verdict"),
  })
  if (!quality.usable) return dropOf("gated", quality.reason)
  const gap = choiceOf(answers, "primary_gap")
  const missing = gaps(page)
  return {
    diagnostic: finding({
    ruleId: RULE_ID,
    severity: "warn",
    message: `${page.file.path} carries ${page.localState} useState call(s) and ${page.inlineElements} inline element(s) that may belong in a composition bundle.`,
    help:
      missing.length === 0
        ? "See the composition pattern guide: a provider owns `{ state, actions, meta }` and blocks are exported by dot notation."
        : `Gaps: ${missing.join("; ")}.${gap === undefined || declined(gap.choice) ? "" : ` Start with: ${gap.choice.replace(/_/g, " ")}.`}`,
    location: { file: page.file.path, line: 1, column: 1 },
    identity: [RULE_ID, page.file.path].join("\u0000"),
    confidence: verdict.confidence,
    score: noulOf(answers, "worth_fixing") ?? verdict.confidence,
    judged: true,
    }),
  }
}

export const pageNeedsComposition = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "Pages whose own state and markup belong in a composition bundle.",
  judged: true,
  run: Effect.fn("joggle/page-needs-composition")(function* (workspace: Workspace, scope: Scope) {
    const pages = candidatesIn(workspace).filter((page) => inScope(scope, page.file.path))
    if (pages.length === 0) {
      return outcome([], [
        "no file looks like a page under state pressure: the trigger is " +
          policy.pageNeedsComposition.minLocalState +
          " or more useState calls and " +
          policy.pageNeedsComposition.minInlineElements +
          " or more inline elements",
      ])
    }

    const budget = policy.pageNeedsComposition.maxPages
    const judged = pages.slice(0, budget)
    const evidenceFor = (page: Page) => ({
      page: {
        path: page.file.path,
        lines: page.lines,
        local_state_calls: page.localState,
        inline_elements: page.inlineElements,
        imports_from_pattern_bundles: page.importsBundles,
        renders_a_provider: page.rendersProvider,
      },
      gaps: gaps(page),
    })

    const judge = yield* Judge

    // ROUND ONE: what is this file?
    //
    // Cheaper and more useful than asking the real question directly, because the
    // answer decides which real question to ask. The first version of this rule
    // asked every file under routes/ whether it should be a bundle, produced
    // 1,216 candidates, and got 237 shrugs -- a model asked a question that does
    // not apply to the thing in front of it does not say so, it says 0.2.
    const classified = yield* judge.askMany(
      judged.map((page) => ({
        evidence: evidenceFor(page),
        questions: { role: pageQuestions.role },
      })),
    )

    const roles: Array<{ page: Page; role: string }> = []
    const drops: Array<Drop> = pages.slice(budget).map((page) => ({
      ruleId: RULE_ID,
      subject: page.file.path,
      stage: "budget" as const,
      reason: `the run judged ${budget} page(s) and this one was past the budget`,
    }))

    judged.forEach((page, index) => {
      const answer = classified[index]?.answers ?? {}
      const role = choiceOf(answer, "role")
      if (role === undefined) {
        drops.push({
          ruleId: RULE_ID,
          subject: page.file.path,
          stage: "unreadable",
          reason: "the response did not classify this file",
        })
        return
      }
      if (declined(role.choice)) {
        drops.push({
          ruleId: RULE_ID,
          subject: page.file.path,
          stage: "declined",
          reason: "the model classified it as not a page, modal or layout",
        })
        return
      }
      roles.push({ page, role: role.choice })
    })

    if (roles.length === 0) {
      return outcome(
        [],
        ["every candidate was classified as something other than a page, modal or layout"],
        drops,
      )
    }

    // ROUND TWO: the question the classification selected, with the vocabulary
    // that kind of file is judged by.
    const results = yield* judge.askMany(
      roles.map(({ page, role }) => ({
        evidence: { ...evidenceFor(page), role },
        questions: {
          verdict: {
            ...pageQuestions.verdict,
            criteria: pageVerdictByRole[role] ?? pageQuestions.verdict.criteria,
          },
          primary_gap: pageQuestions.primary_gap,
          worth_fixing: pageQuestions.worth_fixing,
        },
      })),
    )

    const diagnostics: Array<Diagnostic> = []
    // Only the files that survived classification are read here, and the index
    // is into THAT list: round two asked about a different, shorter set.
    roles.forEach(({ page }, index) => {
      const result = results[index]
      if (result === undefined) {
        drops.push({
          ruleId: RULE_ID,
          subject: page.file.path,
          stage: "unreadable",
          reason: "the response contained nothing for this candidate",
        })
        return
      }
      const decided = findingFor(page, result.answers)
      if (decided.diagnostic !== undefined) diagnostics.push(decided.diagnostic)
      if (decided.drop !== undefined) drops.push(decided.drop)
    })

    return outcome(diagnostics, [], drops)
  }),
})
