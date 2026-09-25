// Meta-rules: the fence for rule authors.
//
// plumb ships rules that lint its own plugin authors (`require-create-once`,
// `require-rule-tester`, `no-manual-ancestor-walks`). joggle had none, which is
// why this session shipped a rule with no `violations`, an unbounded atom and an
// inline message before anyone noticed. These are the same idea: a small, named
// set of invariants every rule in this repository must keep, checkable from the
// source and enforced by a test.
//
// They are deliberately source-level. A rule's `plan` cannot be run without a
// workspace and a model, so the check reads what a rule declares rather than what
// it does -- the same trade plumb's meta-rules make over the plugin source.

/** One rule module, as the meta-rules see it. */
export interface RuleSource {
  /** The file's basename without `.ts`, which is also the test file's basename. */
  readonly name: string
  readonly source: string
  /** True when the module needs the model. */
  readonly judged: boolean
  /** The names the module exports, so a test can name any of them. */
  readonly names: ReadonlyArray<string>
  /** The rule ids the module declares. */
  readonly ruleIds: ReadonlyArray<string>
  /** True when the module delegates its plans to `cluster-verdict.ts`. */
  readonly delegates: boolean
}

/** One broken authorship rule. */
export interface MetaFinding {
  /** The meta-rule that was broken. */
  readonly metaRule: string
  /** The rule module, by basename. */
  readonly rule: string
  readonly detail: string
}

/**
 * The `atoms.add({...})` arguments in a source, by balanced braces.
 *
 * A source scan rather than a parse: the check only needs to see whether an atom
 * carries a whole file, and the balanced-brace walk is enough to tell that from a
 * sliced one.
 */
export const atomPayloads = (source: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  const marker = "atoms.add("
  let cursor = source.indexOf(marker)
  while (cursor !== -1) {
    const open = cursor + marker.length
    let depth = 0
    let index = open
    for (; index < source.length; index += 1) {
      const character = source[index]
      if (character === "(" || character === "{") depth += 1
      else if (character === ")" || character === "}") {
        depth -= 1
        if (depth === 0) break
      }
    }
    found.push(source.slice(open, index + 1))
    cursor = source.indexOf(marker, index)
  }
  return found
}

/**
 * True when the payload carries a whole file rather than a slice of one.
 *
 * The signal is a literal `.text` (or `text:`) with no `.slice(` beside it. A
 * named field such as `source: candidate.source` is the rule's own bounded
 * sample, whose bound is set where the candidate is built, and this check cannot
 * see that far -- so it does not guess.
 */
const unbounded = (payload: string): boolean =>
  /(\.text\b|\btext\s*:)/.test(payload) && !payload.includes(".slice(")

/**
 * The authorship rules, checked against a set of rule sources and their tests.
 *
 * @param input - the rule sources, the tests' texts, and the shared cluster module.
 * @returns one finding per broken rule, empty when every rule keeps them.
 */
export const metaFindings = (input: {
  readonly rules: ReadonlyArray<RuleSource>
  readonly tests: ReadonlyArray<string>
  readonly shared: string
}): ReadonlyArray<MetaFinding> => {
  const found: Array<MetaFinding> = []
  const namesThisRule = (rule: RuleSource): boolean =>
    input.tests.some(
      (test) =>
        rule.ruleIds.some((id) => test.includes(id)) ||
        rule.names.some((name) => new RegExp("\\b" + name + "\\b").test(test)),
    )
  for (const rule of input.rules) {
    // A rule may opt out of one meta-rule with `meta-allow: <rule>` and a stated
    // reason. The opt-out is explicit and greppable, the way a recorded decision
    // is: an author can make the exception, but not hide it.
    const push = (metaRule: string, detail: string): void => {
      if (!new RegExp("meta-allow:\\s*" + metaRule).test(rule.source)) {
        found.push({ metaRule, rule: rule.name, detail })
      }
    }
    if (!namesThisRule(rule)) {
      push("require-test", "no test names this rule or any symbol it exports")
    }
    if (!rule.judged) continue
    // A judged rule that builds plans must declare what violates it, or
    // calibration cannot reduce its question. A rule that answers its own
    // question has no plan to reduce and is outside that.
    if (rule.source.includes("plan:") && !rule.source.includes("violations")) {
      if (!(rule.delegates && input.shared.includes("violations"))) {
        push(
          "require-violations",
          "a planned rule declares no violating labels, so it cannot be calibrated",
        )
      }
    }
    // A judged rule must read a judgement's quality and act on every band. A band
    // is not a reason to discard an answer, and it is not a reason to shout one
    // either: the rule decides what each band does.
    if (!rule.source.includes("qualityOf")) {
      if (!(rule.delegates && input.shared.includes("qualityOf"))) {
        push(
          "band-the-answer",
          "no gate reads a judgement's quality, so a band cannot decide what to do",
        )
      }
    }
    for (const payload of atomPayloads(rule.source)) {
      if (unbounded(payload)) {
        push("bounded-atoms", "an atom carries a whole file; put a bounded sample in it")
      }
    }
  }
  return found
}
