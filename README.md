<div align="center">

# joggle

**Cross-file patterns and idioms for TypeScript, enforced like a linter.**

[![CI](https://github.com/tognmund/mess/actions/workflows/joggle.yml/badge.svg)](https://github.com/tognmund/mess/actions/workflows/joggle.yml)

</div>

> "I want to build the entropy reverser — a big sausage machine where you put all
> programs into it and you turn the handle and a smaller number of programs come
> out."
>
> — Joe Armstrong, *The Mess We're In*, 2014

`tsc` checks one program. `oxlint` checks one file. Neither can tell you that two
functions in different modules are the same concept, that a name means something
different here than it does there, or that a module is not shaped like the other
twelve modules of its kind.

joggle is the layer above both. It indexes the codebase into facts, generates
candidates cheaply and deterministically, and asks narrow typed questions about
the candidates it cannot decide by looking. Answers come back as probabilities;
code keeps control of the thresholds. A finding is an ordinary diagnostic, the
same shape a linter emits.

Be deterministic where you can prove, and judge only where you must. The design
is in [JOGGLE.md](./JOGGLE.md).

| Tool | Unit | Question | Output |
| --- | --- | --- | --- |
| `tsc` / `tsgo` | the program | is this well-typed? | diagnostics |
| `oxlint` | the file and its AST | is this well-formed? | diagnostics |
| **joggle** | the codebase and its facts | is this the same thing as that? | diagnostics |

## Install

```sh
npm install -D @autotelic/joggle
npx joggle rules          # what this project enforces
npx joggle check src      # analyse a directory
npx joggle check --changed
```

With no paths, joggle asks `tsgo --listFilesOnly` what the project is and
analyses what the compiler sees. With paths, it walks them itself.

The deterministic rules need nothing else. The judged rules read
`TYPESAFE_API_KEY` from the environment and write their verdicts to
`.joggle/answers.json`; commit that file and CI replays it without the key.

```sh
TYPESAFE_API_KEY=... npx joggle check src
git add .joggle/answers.json
npx joggle check --since origin/main   # what this branch changed
npx joggle check --pr                  # what this pull request changed
```

From a checkout: `pnpm install && pnpm build`, then `pnpm joggle ...`.

## Rules

Deterministic, derived from the code:

| Rule | Detects |
| --- | --- |
| `layer-direction` | a module that imports from a layer above it |
| `layer-purity` | a module that imports what its layer forbids |
| `import-cycle` | a module that imports, directly or indirectly, from itself |
| `compose-types` | a type that repeats every field of another instead of composing it |
| `field-type-drift` | one field name declared with different, incompatible types |
| `one-concept-one-type` | one declared name resolving to different types in different files |
| `nullability-drift` | a column nullable in the database and required in a schema |
| `object-shape` | object literals that share a shape with no type of their own |
| `name-the-primitive` | a group of fields repeated across declarations with no name of its own |
| `call-pattern` | declarations that make the same calls in the same order with different bodies |
| `duplicate-call-run` | a run of calls two declarations share without the whole sequence |

Judged, asked about high-recall candidates:

| Rule | Detects |
| --- | --- |
| `duplicate-implementation` | one declaration written more than once across files |
| `duplicate-meaning` | near-duplicates where one declaration replaces the other |
| `reimplemented-primitive` | a function that inlines what an existing declaration already does |
| `naming-drift` | two spellings of one concept across files |
| `language-drift` | a domain word the prose uses and the code never names |
| `module-direction` | a module that depends on one whose role sits above it |
| `dependency-fit` | a package that depends on something its architecture says it should not |
| `hoist-to-domain` | business logic at the edge that belongs in a domain package |
| `shallow-module` | a file with many exports and little implementation behind them |
| `temporal-coupling` | a function that acquires something it may not release |
| `name-as-address` | a generic single-word export called from too many files to be searchable |
| `doc-matches-code` | a JSDoc that makes a claim the implementation contradicts |
| `rule-judgment` | a rule that decides in code a question only a judgement can answer |
| `data-error-as-outage` | a 5xx answer to a row that is simply not there |

The composition preset adds rules for one starter architecture — dot-notation
exports, one file per block, `{ state, actions, meta }` providers. It is off by
default; enable it in config.

### Output

Output formats follow oxlint's: `text` (default), `stylish`, `unix`, `json`, and
`github`.

```sh
npx joggle check --format github     # GitHub Actions annotations
npx joggle check --max-warnings 0    # warnings fail the build
npx joggle check --offline           # replay the committed verdicts
npx joggle check --rule joggle/naming-drift
```

## CI

The repository ships a composite action.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: tognmund/mess/.github/actions/joggle@main
  with:
    api-key: ${{ secrets.TYPESAFE_API_KEY }}
    scope: pr
```

With `.joggle/answers.json` committed the job needs no key and spends no tokens;
leave `api-key` off and judged rules replay, or report as skipped where nothing
has been judged. Add the key as a repository secret named `TYPESAFE_API_KEY`. A
fork's pull request does not receive secrets, so it falls back to `--offline`.

## The key

The key is read from the environment only. Locally, use whatever secret manager
the team has:

```sh
doppler run -- joggle check src
direnv allow
```

The judged rules send the evidence panel — including source excerpts of the
declarations being compared — to `api.typesafe.ai`. Deterministic rules and
`--offline` send nothing. To keep evidence inside a network, point
`TYPESAFE_BASE_URL` at your own deployment, or judge public code only and let the
committed cache carry the verdicts.

## Config

```json
{
  "presets": ["@autotelic/joggle/presets/composition"],
  "rules": { "joggle/naming-drift": "warn" },
  "ignore": [
    { "rule": "joggle/bundle-*", "path": "tests/fixtures/**", "reason": "deliberately broken" }
  ],
  "architecture": { "layers": [{ "name": "domain", "include": ["src/domain/**"] }] }
}
```

A preset's severities sit under the repository's own, per rule. The layering
rules have nothing to say until `architecture.layers` is set.

## pi

The repository is a [pi](https://pi.dev) package. `pi install /path/to/joggle`
adds `joggle_check`, `joggle_rules`, and `/joggle`.

## License

MIT.
