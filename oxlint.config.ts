/**
 * The plumb opinions that apply to THIS repository.
 *
 * plumb asks whether one file is well formed; joggle asks whether two things are
 * the same and whether a thing fits here. This file is the first half running on
 * the second half's source, which is the honest test of both: the rules that need
 * one file to answer should be answerable here, and anything that needs two files
 * belongs to joggle.
 *
 * The ruleset is generic plus effect. joggle is a Node application built on
 * Effect -- gen, Schema, Layer, Ref, Context.Service -- and renders nothing, so
 * plumb-react stays out. plumb-meta is for people writing oxlint rules, which
 * joggle does not.
 *
 * `plumb-effect` is consumer-opt-in upstream because plumb itself is not an
 * Effect application. This repository is, so the whole set is on.
 */

const GENERIC = [
  "no-anonymous-wide-tuples",
  "no-barrel-export-star",
  "no-boolean-field-signals",
  "no-builtin-throws",
  "no-chained-type-assertions",
  "no-conditional-empty-object-spread",
  "no-duplicated-literal-union",
  "no-exported-mutable-state",
  "no-generic-export-names",
  "no-impossible-branch-throw",
  "no-known-value-widening",
  "no-module-mocking",
  "no-multiple-function-params",
  "no-mutable-environment-capture",
  "no-nondeterministic-core",
  "no-object-parameters",
  "no-optional-function-parameters",
  "no-product-of-state-booleans",
  "no-redundant-derived-field",
  "no-reflect-apply",
  "no-reflect-get",
  "no-reinterpret-cast",
  "no-runtime-typeof",
  "no-sentinel-comparison-union",
  "no-shape-in-symbol-names",
  "no-single-use-private-functions",
  "no-sql-string-interpolation",
  "no-stacked-jsdoc-blocks",
  "no-stray-inline-comments",
  "no-swappable-primitive-params",
  "no-tag-ladder-assertions",
  "no-transposed-field-reads",
  "no-unit-return-validators",
  "no-unknown-parameters",
  "no-unknown-returns",
  "no-unknown-type-aliases",
  "no-unsafe-dictionary-type",
  "no-widen-then-assert",
  "prefer-payload-brand",
  "require-canonical-stringify-for-identity",
  "require-deprecated-tag-for-legacy-comments",
  "require-exhaustive-tag-switch",
  "require-fc-block-predicate",
  "require-jsdoc-on-exported",
  "require-published-order",
  "require-safety-comment-for-type-assertion",
  "require-sort-comparator",
] as const;

const EFFECT = [
  "guarded-op-must-return-effect",
  "guarded-op-must-return-option",
  "no-cascading-layer-provide",
  "no-decode-unknown-option",
  "no-direct-browser-storage",
  "no-direct-fetch",
  "no-manual-field-guards",
  "no-nested-layer-provide",
  "no-nullish-default-on-partial-input",
  "no-raw-error-forwarding",
  "no-schema-class-modeling",
  "no-service-constructor-imports",
  "no-silent-error-swallow",
  "no-static-effect-service-forwarders",
  "no-try-catch",
  "no-unguarded-json-parse",
  "option-core-needs-effect-public",
  "prefer-die-for-precondition-defects",
  "prefer-effect-gen-for-guard-ladders",
  "prefer-effect-match",
  "prefer-effect-predicate-over-boolean-function",
  "prefer-named-guard-predicate",
  "prefer-option-pipeline",
  "prefer-ordering-match",
  "prefer-tagged-enum",
  "require-schema-type-derivation",
] as const;

const every = (): Record<string, "error"> =>
  Object.fromEntries([
    ...GENERIC.map((id) => [`plumb/${id}`, "error"]),
    ...EFFECT.map((id) => [`plumb-effect/${id}`, "error"]),
  ]);

export default {
  ignorePatterns: ["node_modules", "tests/fixtures/**"],
  plugins: ["eslint", "oxc", "typescript", "unicorn", "jsdoc", "node"],
  settings: { jsdoc: { mode: "typescript" } },
  jsPlugins: [
    // The installed package, which is what a consumer has. Its dist was three
    // rules behind its src until I rebuilt it, which is the same lesson as every
    // other stale artifact in this session: a build output is another thing that
    // can quietly disagree with its source.
    { name: "plumb", specifier: "@autotelic/plumb" },
    { name: "plumb-effect", specifier: "@autotelic/plumb/effect" },
  ],
  rules: {
    ...every(),
    // plumb:allow-off: this rule is non-deterministic AND reports the pattern it
    // recommends. Read its detection: it collects schema names, collects every
    // interface, and reports the overlap at Program:exit without ever looking at
    // the `extends` clause -- so `interface X extends Schema.Schema.Type<typeof X>`
    // is reported as re-declaring X by hand. It also uses a createOnce visitor
    // with cross-file state, so the same tree reports 33, 39 or 40 findings
    // depending on the order files are visited. Both need fixing upstream before
    // this can hold a baseline; until then it cannot be part of a ratchet that is
    // supposed to be reproducible.
    "plumb-effect/require-schema-type-derivation": "off",
  },
};
