import { Effect } from "effect"
import { policy } from "../policy.ts"
import { Service as Judge, type JudgeRequest } from "../judge.ts"
import {
  budgetNote,
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
import type { Diagnostic, Question } from "../schema.ts"
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

const baseOf = (file: string): string => {
  const cut = file.lastIndexOf("/")
  return cut === -1 ? file : file.slice(cut + 1)
}

/** A page is a route, a page, or a modal -- not merely something under routes/. */
const isPage = (file: string): boolean => /^(route|page)\.tsx?$/.test(baseOf(file)) || /modal/i.test(baseOf(file))

const dirOf = (file: string): string => {
  const cut = file.lastIndexOf("/")
  return cut === -1 ? "." : file.slice(0, cut)
}

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
    if (file.facts.calls.some((call) => call === "createContext" || call.endsWith(".createContext"))) {
      bundleDirs.add(dirOf(file.path))
    }
  }

  const { minLocalState, minInlineElements } = policy.pageNeedsComposition
  const pages: Array<Page> = []
  for (const file of workspace.files) {
    if (!isPage(file.path)) continue
    const localState = file.facts.calls.filter(
      (call) => call === "useState" || call.endsWith(".useState"),
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

const questions = {
  verdict: {
    type: "choice",
    instructions: {
      question: "Should this page's state and markup live in a composition bundle instead?",
      inspect: "`page`",
      fallback: "Choose \`no_issue\` when the state is this page's own and nothing is shared.",
      focus:
        "The pattern earns its keep when several blocks share state that this file currently threads itself. A page with its own state and no sharing between pieces does not need it.",
      note: "Judge whether a bundle would remove real duplication of state, not whether this file is long.",
    },
    criteria: {
      extract_to_bundle:
        "Its state and its pieces belong in a bundle with `{ state, actions, meta }`, exported by dot notation.",
      extract_some:
        "Part of it does, such as a repeated block or a group of elements that always travel together.",
      no_issue:
        "No. The state is genuinely this page's own and a provider would be ceremony.",
    },
  },
  primary_gap: {
    type: "choice",
    instructions: {
      question: "What is the single most useful thing to change about `page.path`?",
      focus: "Name the gap a reviewer would fix first, or `none` when there is nothing to fix.",
    },
    criteria: {
      state_belongs_in_provider: "State threaded here belongs in a provider the pieces read directly.",
      markup_belongs_in_blocks: "Markup inlined here belongs in named blocks, one per file.",
      no_provider_root: "It needs the bundle's provider at its composition root.",
      no_issue: "Nothing; leave this page as it is.",
    },
  },
  worth_fixing: {
    type: "noul",
    instructions: {
      question: "Is extracting a bundle from this page worth a reviewer's time?",
      focus: "A page that works and shares nothing is not worth restructuring for its own sake.",
    },
    criteria: {
      true: "A reviewer should look at this.",
      false: "Leave it alone.",
    },
  },
} satisfies Record<string, Question>

const findingFor = (
  page: Page,
  answers: Readonly<Record<string, import("../schema.ts").Answer>>,
): Diagnostic | undefined => {
  const verdict = choiceOf(answers, "verdict")
  if (verdict === undefined || declined(verdict.choice)) return undefined
  // The yes/no question is a verdict, not a ranking: when it says the extraction
  // is not worth a reviewer's time, there is no finding, however loudly the
  // Choice said `extract_to_bundle`.
  const quality = qualityOf({
    score: noulOf(answers, "worth_fixing") ?? verdict.confidence,
    margin: marginOf(answers, "verdict"),
  })
  if (!quality.usable) return undefined
  const gap = choiceOf(answers, "primary_gap")
  const missing = gaps(page)
  return finding({
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
  })
}

export const pageNeedsComposition = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "Pages whose own state and markup belong in a composition bundle.",
  judged: true,
  run: Effect.fn("joggle/page-needs-composition")(function* (workspace: Workspace, scope: Scope) {
    const pages = candidatesIn(workspace).filter((page) => inScope(scope, page.file.path))
    if (pages.length === 0) return outcome([])

    const budget = policy.pageNeedsComposition.maxPages
    const judged = pages.slice(0, budget)
    const requests: Array<JudgeRequest> = judged.map((page) => ({
      evidence: {
        page: {
          path: page.file.path,
          lines: page.lines,
          local_state_calls: page.localState,
          inline_elements: page.inlineElements,
          imports_from_pattern_bundles: page.importsBundles,
          renders_a_provider: page.rendersProvider,
        },
        gaps: gaps(page),
      },
      questions,
    }))

    const judge = yield* Judge
    // A verdict here is a guess, so without a judgement the rule is silent and
    // the engine records it as skipped.
    const results = yield* judge.askMany(requests)

    const diagnostics: Array<Diagnostic> = []
    judged.forEach((page, index) => {
      const result = results[index]
      if (result === undefined) return
      const diagnostic = findingFor(page, result.answers)
      if (diagnostic !== undefined) diagnostics.push(diagnostic)
    })

    return outcome(diagnostics, [
      `${pages.length - diagnostics.length} of ${pages.length} page(s) under state pressure need no bundle`,
      ...budgetNote("pages", budget, pages.length, pages.slice(budget).map((page) => page.file.path)),
    ])
  }),
})
