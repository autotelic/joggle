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

  /**
   * Declared exceptions, each with the reason written down.
   *
   * These are not suppressions. A suppression hides a finding; an exception
   * records that the rule and this codebase disagree about something, and says
   * what. Anything without a reason is missing from here on purpose.
   */
  overrides: [
    {
      // joggle/plugin exists to re-export a supported surface. A barrel export is
      // a smell in an application, where it hides what a module actually owns;
      // here the point IS the aggregate -- one name a rule author imports, and
      // one place to add the next thing to the contract. plumb's own rule cannot
      // know that, which is the whole reason the two tools are separate.
      files: ["src/plugin.ts"],
      rules: { "plumb/no-barrel-export-star": "off" },
    },
    {
      // `shape` is joggle's domain word. A declaration's SHAPE is its token
      // sequence with every identifier blanked, and `shapeHash` is that hashed;
      // `overlap` is the similarity between two of them. The rule reads "shape"
      // as structure-rather-than-ownership, which is right in general and
      // meaningless here -- there is no owner to name, because the shape is of
      // nothing in particular. Declared rather than renamed: renaming a domain
      // term to please a linter is the tool editing the domain.
      files: [
        "src/workspace.ts",
        "src/similarity.ts",
        "src/parsecache.ts",
        "src/rules/compose-types.ts",
        "src/rules/cluster-verdict.ts",
      ],
      rules: { "plumb/no-shape-in-symbol-names": "off" },
    },
    {
      // The remedy requires an API this Effect version does not have: there is no
      // `decodeUnknownResult`, and `SchemaParser.decodeResult` takes a schema's
      // ENCODED type, which a JSON file read as `unknown` cannot supply without a
      // cast. The concern behind the rule is addressed instead -- a cache file
      // that fails to decode is recorded and reported, so a cache that quietly
      // stopped working no longer looks exactly like a cold one.
      files: ["src/parsecache.ts"],
      rules: { "plumb-effect/no-decode-unknown-option": "off" },
    },
    {
      // The decode bridge: raw AST nodes and raw plugin modules in, typed values
      // out. plumb carves out exactly this exception for its own bridge module --
      // its config says "Reflection/decode boundary modules: representation checks
      // and broad parameters are their purpose: they own the crossing between raw
      // AST/config payloads and typed rule logic" -- and that sentence describes
      // these three files word for word.
      //
      // What was measured before deciding it: decoding one AST node with a Schema
      // costs 213ns against 3ns for a typeof check, a factor of 73, and joggle
      // walks millions of nodes per run. oxc produced that AST in this process and
      // `parseSync` has a type for it, so Schema-validating it would be validating
      // our own output at 73 times the price. The alternative -- keeping oxc's
      // types and narrowing on `node.type` -- is the right long-term shape and is
      // not done here.
      //
      // Scoped to the five rules that ARE the bridge: 113 of the 330 findings, and
      // 85 to 94 per cent of each of these five rules' occurrences. Everything
      // else these files trip -- swappable parameters, missing JSDoc, sort
      // comparators -- is ordinary debt and stays in the baseline.
      files: ["src/workspace.ts", "src/imports.ts", "src/plugins.ts"],
      rules: {
        "plumb/no-runtime-typeof": "off",
        "plumb/no-reinterpret-cast": "off",
        "plumb/require-safety-comment-for-type-assertion": "off",
        "plumb/no-unsafe-dictionary-type": "off",
        "plumb/no-unknown-parameters": "off",
      },
    },
    {
      // `Effect.gen(function* () { ... return x })` with no `yield` is idiomatic
      // Effect: the generator IS the effect, and a rule body with no effectful
      // steps still returns through one. eslint's rule predates Effect and cannot
      // see that, which is a gap worth reporting upstream rather than a decision
      // to make here -- but it is six sites, not a policy.
      files: ["src/rules/**"],
      rules: { "eslint/require-yield": "off" },
    },
    {
      // Policy, decided rather than drifted into. joggle keeps inline comments
      // for the REASONING -- why this threshold, why this shape, what the failure
      // looked like -- and JSDoc for the CONTRACT. plumb wants all of it in JSDoc,
      // and it has a real point: an inline comment is invisible to tooling. But
      // the reasoning belongs where the decision is made, and moving four hundred
      // of them onto the signatures above would put the explanation of a line
      // forty lines away from the line.
      //
      // The other half of the same rule family, `require-jsdoc-on-exported`, is
      // NOT excepted: an exported contract without a doc block is a real gap, and
      // the 28 it reports are work rather than disagreement.
      files: ["src/**", "scripts/**"],
      rules: { "plumb/no-stray-inline-comments": "off" },
    },
  ],
};
