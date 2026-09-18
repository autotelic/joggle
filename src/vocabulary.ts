import type { Question } from "./schema.ts"

/**
 * Every word the model is asked to choose between, in one file.
 *
 * jev keeps its thresholds AND its whole vocabulary in a config module with no
 * imports: five dimensions, thirty mechanism strings, four rubric levels. Tuning
 * that system is editing data. joggle had the thresholds in policy.ts and the
 * vocabulary scattered through the rules that used them, which meant the only way
 * to compare two questions was to read two files -- and comparing them side by
 * side is exactly how you notice that one of them has no way to say "this is
 * fine", which is the bug the previous commit fixed.
 *
 * The split is by whether a string depends on the candidate. A string that is the
 * same for every candidate lives here. A criterion that names the member being
 * kept, or counts the declarations shown, is built in the rule that knows those
 * facts -- so the WORDS still come from here, through a template.
 */

/** The shared question for exact and near duplicates. */
export const duplicateVocabulary = {
  redundant: {
    true: "One declaration would serve better than several.",
    false: "The repetition is justified.",
  },
  /**
   * What a declaration IS, which decides what to do about it being duplicated.
   *
   * The same duplication has opposite prescriptions depending on this answer and
   * nothing else. A wire contract defined on both sides of a service boundary is
   * correct -- two independently deployed services share a shape, not a module. A
   * domain concept defined on both sides is the defect the whole architecture
   * exists to prevent. The paths say which; the model is the thing that can tell.
   */
  role: {
    wire_contract:
      "A shape that crosses a process or protocol boundary: a request body, a response, a serialized record.",
    domain_concept:
      "A thing the business has an opinion about, with rules or meaning attached to it.",
    implementation_detail:
      "A helper that exists to make other code work, and means nothing on its own.",
    framework_glue:
      "A shape a framework requires, such as route props, loader data, or a config object.",
  },
  /**
   * How the files holding the copies relate, which decides whether any of them
   * can import the others.
   *
   * This is what a declared layering used to be asked for. It is inferable from
   * the paths and the import graph, and it is genuinely fuzzy at the edges -- is
   * `app/routes/finance/x` a sibling of `app/routes/payroll/y` or in the same
   * module? -- which is exactly the shape of question worth asking.
   */
  relationship: {
    same_module: "One directory, or one feature: they are edited together.",
    same_package: "One deployable, different features.",
    sibling_packages: "Different packages inside one repository, able to depend on each other.",
    different_deployables:
      "Separately deployed services. Neither may import the other, whatever their paths suggest.",
  },
  /**
   * Whether it MATTERS, which is a different question from whether it is true.
   *
   * The report used to sort by redundancy -- "are these one thing?" -- and on one
   * repository that put the lowest score in the whole report on a spec that
   * re-implements the function it tests, while three placeholder aliases that
   * were all `any` sat above it at 0.68. Both answers were correct. Sorting by
   * the answer to the wrong question is how a real finding ends up last.
   */
  consequence: {
    true: "Sharing one would remove work, or stop the copies diverging.",
    false: "Nobody would notice either way. The copies are stable and independent.",
  },
  verdict: {
    collapse: "They are one thing. Keep one of them and delete the rest.",
    keep_variants:
      "Related but deliberately separate, such as a special case of a general routine. Keep them all.",
    no_issue: "Coincidentally similar. They are different things. Change nothing.",
  },
} as const

/** Name pairs: two spellings of one concept, or two different concepts. */
export const nameVocabulary = {
  oneConcept: {
    true: "One concept, so one name should go.",
    false: "Two concepts, so both names are correct.",
  },
  /**
   * The two "one concept" options differ only in WHICH name survives, so the
   * sentence is one template and the rule supplies the symbol.
   */
  standardize: (symbol: string): string =>
    "One concept, two spellings. Standardize on `" + symbol + "`.",
  noIssue: "Two different concepts. Both names are correct. Change nothing.",
} as const

/**
 * What "extract this into a bundle" means, per kind of file.
 *
 * This is the `mechanisms[dimension]` shape from the TypeSafe docs: the first
 * question's ANSWER selects the OPTIONS of the second. A route page and a modal
 * are both worth asking about, but a bundle means a different thing to each -- a
 * route owns a screen and its navigation state, a modal owns one interaction and
 * its dismissal. Asking both with one vocabulary is how a question gets an answer
 * that is true of neither.
 */
export const pageVerdictByRole: Record<string, Record<string, string>> = {
  route_page: {
    extract_to_bundle:
      "Its state and its screen-wide pieces belong in a bundle with `{ state, actions, meta }`, exported by dot notation.",
    extract_some:
      "Part of it does, such as the panel that always travels with the data it reads.",
    no_issue:
      "No. This page's state is genuinely its own and a provider would be ceremony between it and its children.",
  },
  modal: {
    extract_to_bundle:
      "Its draft state and its steps belong in a bundle, so the form and its actions are not threaded through each step.",
    extract_some:
      "Part of it does, such as the step controls that repeat per field.",
    no_issue:
      "No. A modal with one piece of state and one submit needs no provider to share anything.",
  },
  layout: {
    extract_to_bundle:
      "It owns state that its children read, which is a bundle's job rather than a layout's.",
    extract_some:
      "Part of it does, such as the chrome that several children configure.",
    no_issue: "No. A layout that renders children and owns nothing is exactly what a layout should be.",
  },
}

/**
 * The page rule's questions, whole.
 *
 * Every string here is fixed, so there is nothing to build per candidate and
 * nothing to keep in the rule.
 */
export const pageQuestions = {
  role: {
    type: "choice",
    instructions: {
      question: "What kind of file is `page.path`?",
      fallback: "Choose \"not_applicable\" when it is none of these.",
      focus:
        "Classify the file by what it is, not by whether it conforms. This answer decides which question is asked next, so a wrong classification wastes the rest of the request.",
    },
    criteria: {
      route_page: "A route's own page: it owns layout and state for one screen.",
      modal:
        "A dialog or modal: it owns state for one interaction and is opened and closed rather than navigated to.",
      layout: "A shell that renders children and owns little or no state of its own.",
      not_applicable:
        "A helper, a loader, a test, or something else this pattern does not apply to.",
    },
  },
  verdict: {
    type: "choice",
    instructions: {
      question: "Should this file's state and markup live in a composition bundle instead?",
      inspect: "`page`",
      fallback: "Choose `no_issue` when the state is this file's own and nothing is shared.",
      focus:
        "The pattern earns its keep when several blocks share state that this file currently threads itself. A file with its own state and no sharing between pieces does not need it.",
      note: "Judge whether a bundle would remove real duplication of state, not whether this file is long.",
    },
    criteria: {
      extract_to_bundle:
        "Its state and its pieces belong in a bundle with `{ state, actions, meta }`, exported by dot notation.",
      extract_some:
        "Part of it does, such as a repeated block or a group of elements that always travel together.",
      no_issue: "No. The state is genuinely this file's own and a provider would be ceremony.",
    },
  },
  primary_gap: {
    type: "choice",
    instructions: {
      question: "What is the single most useful thing to change about `page.path`?",
      fallback: "Choose `no_issue` when there is nothing to fix.",
      focus: "Name the gap a reviewer would fix first, or `no_issue` when there is nothing to fix.",
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
