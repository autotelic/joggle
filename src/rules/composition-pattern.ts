import { Effect, Option } from "effect"
import { policy } from "../policy.ts"
import { Service as Judge, type JudgeRequest } from "../judge.ts"
import { budgetNote, choiceOf, defineRule, finding, inScope, noulOf, outcome, type Scope } from "../rule.ts"
import type { Diagnostic, JudgeError, Question } from "../schema.ts"
import type { Workspace } from "../workspace.ts"

const RULE_ID = "joggle/composition-pattern"

/**
 * Does a page follow the composition pattern?
 *
 * The pattern is Fernando Rojo's: a provider holding `{ state, actions, meta }`,
 * blocks exported by dot notation, and pages that assemble blocks instead of
 * inlining markup. The reference implementation is a page like
 * `<Counter.Provider><Counter.Display /><Counter.Increment /></Counter.Provider>`
 * with the bundle in `components/counter/`.
 *
 * The check is about a PAGE, not a declaration. A linter sees one file at a
 * time and a typechecker sees types; neither can say "this route assembles 40
 * raw elements and imports nothing from the design system". That is a question
 * about how files relate, which is the whole reason joggle exists. Pattern.md
 * is the specification.
 */

/* -------------------------------------------------------------------------- */
/* What a page is, and what it is made of                                      */
/* -------------------------------------------------------------------------- */

const dirOf = (file: string): string => {
  const cut = file.lastIndexOf("/")
  return cut === -1 ? "." : file.slice(0, cut)
}

const baseOf = (file: string): string => {
  const cut = file.lastIndexOf("/")
  return cut === -1 ? file : file.slice(cut + 1)
}

const isPage = (file: string): boolean =>
  file.includes("/routes/") ||
  /(^|\/)(route|page)\.tsx?$/.test(file) ||
  /modal/i.test(baseOf(file))

const DIRECTORIES: ReadonlyArray<{ pattern: RegExp; gap: string }> = [
  { pattern: /(^|\/)ui\//, gap: "design_system" },
]

interface Page {
  readonly file: string
  /** Modules it imports, resolved to paths we analysed. */
  readonly imports: ReadonlyArray<string>
  /** Directories it draws components from. */
  readonly drawsFrom: ReadonlyArray<string>
  readonly fromDesignSystem: number
  /** The design system is reached through a bundle the page composes. */
  readonly designSystemThroughBundle: boolean
  /** Modules imported from a directory that is itself a composition bundle. */
  readonly fromBundles: number
  readonly inlineElements: number
  readonly localState: number
  readonly rendersProvider: boolean
  readonly lines: number
}

const analyse = (workspace: Workspace): ReadonlyArray<Page> => {
  // A directory is a composition bundle when a file in it creates a context.
  // That is the pattern's signature: everything else follows from it.
  const bundleDirs = new Set<string>()
  for (const file of workspace.files) {
    if (file.facts.calls.some((call) => call === "createContext" || call.endsWith(".createContext"))) {
      bundleDirs.add(dirOf(file.path))
    }
  }

  // Whether a director's blocks build on the design system. A page reaches the
  // design system THROUGH its bundle: the pattern puts shadcn and base HTML in
  // the atomic blocks, so asking the page for a direct import is asking the
  // wrong file. The reference implementation failed this check until it was
  // made transitive, which is exactly what the acceptance test was for.
  const bundleUsesDesignSystem = new Set<string>()
  for (const file of workspace.files) {
    const dir = dirOf(file.path)
    if (!bundleDirs.has(dir)) continue
    const uses = workspace.imports.edges.some(
      (edge) => edge.from === file.path && edge.resolved && /(^|\/)ui\//.test(edge.to),
    )
    if (uses) bundleUsesDesignSystem.add(dir)
  }

  const pages: Array<Page> = []
  for (const file of workspace.files) {
    if (!isPage(file.path)) continue
    const imports = workspace.imports.edges
      .filter((edge) => edge.from === file.path && edge.resolved)
      .map((edge) => edge.to)
    const drawsFrom = [...new Set(imports.map(dirOf))]
    const calls = file.facts.calls
    pages.push({
      file: file.path,
      imports,
      drawsFrom,
      fromDesignSystem: imports.filter((target) => DIRECTORIES.some((d) => d.pattern.test(target))).length,
      fromBundles: imports.filter((target) => bundleDirs.has(dirOf(target))).length,
      designSystemThroughBundle: imports.some(
        (target) => bundleDirs.has(dirOf(target)) && bundleUsesDesignSystem.has(dirOf(target)),
      ),
      inlineElements: file.facts.jsx.length,
      localState: calls.filter((call) => call === "useState" || call.endsWith(".useState")).length,
      rendersProvider: file.facts.jsx.some((element) => element.endsWith(".Provider")),
      lines: file.text.split("\n").length,
    })
  }
  return pages
}

/** The gaps a page can have, in the words the pattern uses for them. */
const gaps = (page: Page): ReadonlyArray<string> => {
  const found: Array<string> = []
  if (page.fromBundles === 0) found.push("does not compose pattern blocks")
  if (page.fromDesignSystem === 0 && !page.designSystemThroughBundle) {
    found.push("does not use the design system")
  }
  if (!page.rendersProvider) found.push("no provider at the composition root")
  if (page.localState > 3) found.push(`${page.localState} useState calls that may belong in a provider`)
  return found
}

const evidenceOf = (page: Page) => ({
  page: {
    path: page.file,
    lines: page.lines,
    inline_elements: page.inlineElements,
    local_state_calls: page.localState,
    renders_a_provider: page.rendersProvider,
    imports_from_design_system: page.fromDesignSystem,
    imports_from_pattern_bundles: page.fromBundles,
    draws_from: page.drawsFrom.slice(0, policy.evidence.maxListedPaths * 3),
  },
  gaps: gaps(page),
})

const questions = {
  verdict: {
    type: "choice",
    instructions: {
      question: "Does this page follow the composition pattern?",
      inspect: "`page`",
      focus:
        "The pattern composes a page from atomic blocks exported by a bundle, built on the design system, under a provider that holds `{ state, actions, meta }`. A page that inlines raw markup and its own state instead does not follow it.",
      note: "Judge the shape of the page, not how many lines it has.",
    },
    criteria: {
      follows_the_pattern:
        "It assembles blocks from a pattern bundle, the bundle's provider is at the root, and it uses the design system rather than hand-rolled markup.",
      partially_follows:
        "Some of the pattern is present but a structural piece is missing, such as no provider at the root or blocks used without the bundle.",
      does_not_follow:
        "It inlines its own markup and state instead of composing atomic blocks, or bypasses the design system entirely.",
    },
  },
  primary_gap: {
    type: "choice",
    instructions: {
      question: "What is the single most useful thing to change about `page.path`?",
      focus: "Name the gap a reviewer would fix first, or `none` when the page is fine.",
    },
    criteria: {
      not_composed: "It should be assembled from pattern blocks instead of inline markup.",
      no_provider: "It needs the bundle's provider at its composition root.",
      bypasses_design_system: "It should build on the design system rather than raw elements or ad-hoc styles.",
      local_state: "State held in the page belongs in a pattern bundle's provider.",
      none: "Nothing; this page follows the pattern.",
    },
  },
  worth_fixing: {
    type: "noul",
    instructions: {
      question: "Is this page's deviation from the composition pattern worth a reviewer's time?",
      focus: "A page that works and is small is not worth restructuring for its own sake.",
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
): Option.Option<Diagnostic> => {
  const verdict = choiceOf(answers, "verdict")
  if (verdict === undefined || verdict.choice === "follows_the_pattern") {
    return Option.none<Diagnostic>()
  }
  const gap = choiceOf(answers, "primary_gap")
  const missing = gaps(page)
  return Option.some(
    finding({
      ruleId: RULE_ID,
      severity: "warn",
      message: `${page.file} does not follow the composition pattern: ${page.inlineElements} inline element(s), ${page.fromBundles} pattern block import(s), ${page.fromDesignSystem} design-system import(s).`,
      help:
        missing.length === 0
          ? "See the composition pattern guide: a page assembles blocks exported by a bundle under its provider."
          : `Gaps: ${missing.join("; ")}. ${gap === undefined ? "" : `Start with: ${gap.choice.replace(/_/g, " ")}.`}`.trim(),
      location: { file: page.file, line: 1, column: 1 },
      identity: [RULE_ID, page.file].join("\u0000"),
      confidence: verdict.confidence,
      score: noulOf(answers, "worth_fixing") ?? verdict.confidence,
      judged: true,
    }),
  )
}

export const compositionPattern = defineRule({
  id: RULE_ID,
  severity: "warn",
  description: "Pages and modals that do not follow the composition pattern.",
  judged: true,
  run: Effect.fn("joggle/composition-pattern")(function* (workspace, scope) {
    const pages = analyse(workspace).filter((page) => inScope(scope, page.file))
    if (pages.length === 0) return outcome([])

    const budget = policy.compositionPattern.maxPages
    const judged = pages.slice(0, budget)
    const requests: Array<JudgeRequest> = judged.map((page) => ({
      evidence: evidenceOf(page),
      questions,
    }))

    const judge = yield* Judge
    // A conformance verdict is a guess, not a fact: without a judgement the rule
    // stays silent and the engine records it as skipped, the same way
    // duplicate-meaning and naming-drift behave.
    const results = yield* judge.askMany(requests)

    const diagnostics: Array<Diagnostic> = []
    judged.forEach((page, index) => {
      const result = results[index]
      if (result === undefined) return
      const diagnostic = findingFor(page, result.answers)
      if (Option.isSome(diagnostic)) diagnostics.push(diagnostic.value)
    })

    const conforming = pages.length - diagnostics.length
    return outcome(diagnostics, [
      `${conforming} of ${pages.length} page(s) and modal(s) follow the composition pattern`,
      ...budgetNote("pages", budget, pages.length, pages.slice(budget).map((page) => page.file)),
    ])
  }),
})
