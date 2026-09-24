<div align="center">

# joggle

**Cross-file patterns and idioms for TypeScript, enforced like a linter.**

[![MIT licensed][license-badge]][license-url]
[![CI][ci-badge]][ci-url]

</div>

`tsc` checks one program. `oxlint` checks one file. Neither can tell you that two
functions in different modules are the same concept, that a name means something
different here than it does there, or that a module is not shaped like the other
twelve modules of its kind.

joggle is the layer above both. It indexes the codebase into facts, generates
candidates cheaply and deterministically, and then asks narrow typed questions
about the candidates it cannot decide by looking. Answers come back as
probabilities, code keeps control of the thresholds, and the output is an
ordinary diagnostic — so the same tool serves an editor, a pre-commit hook, and
CI.

The design rule is one sentence: **be deterministic where you can prove, and
judge only where you must.**

Read [JOGGLE.md](./JOGGLE.md) for the whole design.

## 🔭 Where it sits

| Tool | Unit | Question | Output |
| --- | --- | --- | --- |
| `tsc` / `tsgo` | the program | is this well-typed? | diagnostics |
| `oxlint` | the file and its AST | is this well-formed? | diagnostics |
| **joggle** | the codebase and its facts | is this the same thing as that? | diagnostics |

A host does not have to care which kind of rule produced a finding. There is no
separate report, no separate format, and no separate gate.

## ⚡ Quick start

```sh
# in the project you want to check
npm install -D @autotelic/joggle
npx joggle rules                 # what this project enforces
npx joggle check src             # analyse a directory
```

Or run it without installing anything:

```sh
npx @autotelic/joggle@latest check --changed
```

With no paths, joggle asks `tsgo --listFilesOnly` what the project is, so it
analyses exactly what the compiler sees rather than whatever is on disk. With
paths, it walks them itself.

## 🧪 Try it against your own project

The judged rules need a key; everything else runs without one. A useful first
session:

```sh
# 1. Deterministic pass — no key, no network, a few seconds.
npx joggle check src

# 2. Add the judged pass. The key is read from the environment only.
TYPESAFE_API_KEY=... npx joggle check src

# 3. Commit the verdicts so CI never needs the key.
git add .joggle/answers.json

# 4. From now on, ask only what a change introduced.
npx joggle check --since origin/main
npx joggle check --pr            # resolved with the GitHub CLI
```

Three things make this safe to live with:

- **The cache is the contract.** A verdict's key is the question, the model, and
  the evidence, serialised with sorted keys, so the same candidate produces the
  same key on every machine. Run from the repository root — evidence carries
  root-relative paths.
- **A judged run can be done by one person and replayed by anyone.** Commit
  `.joggle/answers.json`; CI replays it with `--offline` and no secret.
- **A missing key degrades the gate, it does not disable it.** Judged rules
  report as skipped; the deterministic rules still run.

To check another checkout without writing into it:

```sh
npx joggle check --cwd ../other-repo --since origin/main --offline
```

## 🧰 What it finds

The built-in rules. `static` rules are deterministic and always run; `judged`
rules ask the model about high-recall candidates.

| Rule | Kind | Detects |
| --- | --- | --- |
| `layer-direction` | static | a module that imports from a layer above it |
| `layer-purity` | static | a module that imports what its layer forbids |
| `import-cycle` | static | a module that imports, directly or indirectly, from itself |
| `compose-types` | static | a type that repeats every field of another instead of composing it |
| `field-type-drift` | static | one field name declared with different, incompatible types |
| `one-concept-one-type` | static | one declared name resolving to different types in different files |
| `nullability-drift` | static | a column nullable in the database and required in a schema |
| `object-shape` | static | object literals that share a shape with no type of their own |
| `name-the-primitive` | static | a group of fields repeated across declarations with no name of its own |
| `call-pattern` | static | declarations that make the same calls in the same order with different bodies |
| `duplicate-call-run` | static | a run of calls two declarations share without the whole sequence |
| `duplicate-implementation` | judged | one declaration written more than once across files |
| `duplicate-meaning` | judged | near-duplicates where one declaration replaces the other |
| `reimplemented-primitive` | judged | a function that inlines what an existing declaration already does |
| `naming-drift` | judged | two spellings of one concept across files |
| `language-drift` | judged | a domain word the prose uses and the code never names |
| `module-direction` | judged | a module that depends on one whose role sits above it |
| `dependency-fit` | judged | a package that depends on something its architecture says it should not |
| `hoist-to-domain` | judged | business logic at the edge that belongs in a domain package |
| `shallow-module` | judged | a file with many exports and little implementation behind them |
| `temporal-coupling` | judged | a function that acquires something it may not release |
| `name-as-address` | judged | a generic single-word export called from too many files to be searchable |
| `doc-matches-code` | judged | a JSDoc that makes a claim the implementation contradicts |
| `rule-judgment` | judged | a rule that decides in code a question only a judgement can answer |
| `data-error-as-outage` | judged | a 5xx answer to a row that is simply not there |

The **composition preset** (`@autotelic/joggle/presets/composition`) adds rules for one
starter architecture — dot-notation exports, one file per block, `{ state,
actions, meta }` providers, and the page that belongs in a bundle. Enable it in
config; it is not on by default, because a tool that runs somebody's architecture
by default is a tool the first team with a different one switches off.

### Output formats

Follows oxlint, because oxlint already decided what a linter's output should be.

| Format | For |
| --- | --- |
| `text` (default) | terminals and CI logs |
| `stylish` | reading by hand, colour on a TTY |
| `unix` | editors and scripts |
| `json` | another tool, including per-answer confidence |
| `github` | Actions workflow commands (annotations) |

```sh
joggle check --format github      # GitHub Actions annotations
joggle check --max-warnings 0     # warnings fail the build
joggle check --offline            # replay from the committed verdicts
joggle check --rule joggle/naming-drift
```

## 🤖 CI

joggle is built to live in CI. The repository ships a composite action that
installs joggle, runs it, and attaches findings as annotations.

```yaml
name: joggle
on: [pull_request]

jobs:
  joggle:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: tognmund/mess/.github/actions/joggle@main
        with:
          # Omit to run the deterministic rules only; judged rules report as
          # skipped. Add the secret to judge new candidates.
          api-key: ${{ secrets.TYPESAFE_API_KEY }}
          scope: pr
```

The action does two things well:

- **Replay by default.** With `.joggle/answers.json` committed, the job needs no
  key and spends no tokens: deterministic rules run, judged rules replay. Set
  `api-key` only on a job that is allowed to judge and spend.
- **Scope to the change.** `scope: pr` checks only what the pull request
  introduced, which is the question a reviewer is actually asking.

Add the key as a repository secret named `TYPESAFE_API_KEY`. A fork's pull
request does not receive secrets; the job then runs `--offline` and still works.

## 🔑 The key

The key is read from the process environment only, so it never lands in the
repository or in any config file joggle owns. Locally, use whatever secret
manager your team already has:

```sh
doppler run -- joggle check src
direnv allow                      # or a gitignored .envrc.local
```

The judged rules send the evidence panel — including source excerpts of the
declarations being compared — to `api.typesafe.ai`. Deterministic rules and
`--offline` send nothing. For a codebase you cannot send anywhere, point
`TYPESAFE_BASE_URL` at a deployment you control, or run the judged pass over
public and fixture code only and let the committed cache carry the verdicts into
CI.

## ⚙️ Configuration

A repository configures joggle with `joggle.config.json`:

```json
{
  "presets": ["@autotelic/joggle/presets/composition"],
  "rules": {
    "joggle/naming-drift": "warn",
    "joggle/duplicate-meaning": "warn"
  },
  "ignore": [
    { "rule": "joggle/bundle-*", "path": "tests/fixtures/**", "reason": "fixtures are deliberately broken" }
  ],
  "architecture": {
    "layers": [{ "name": "domain", "include": ["src/domain/**"] }]
  }
}
```

A preset's severities and scoping sit under the repository's own, per rule:
enabling twenty opinions and turning one off should not mean restating the other
nineteen. `architecture.layers` is what the layering rules enforce; without it
they have nothing to say.

## 🥧 As a pi extension

The repository is also a [pi](https://pi.dev) package. Install it once and pi
gains two tools and a command in every repository it works in:

```sh
pi install /absolute/path/to/joggle
```

| Name | What it does |
| --- | --- |
| `joggle_check` | run a scoped check and return the findings; defaults to the changed scope |
| `joggle_rules` | list the rules a repository enforces |
| `/joggle` | run a check from the prompt line |

## ✍️ Contribute

- The design lives in [JOGGLE.md](./JOGGLE.md); the thinking that produced it is
  in [`docs/`](./docs).
- Adding a rule is one file and one line in
  [`src/rules/index.ts`](./src/rules/index.ts).
- Run `pnpm check` before you push: typecheck, tests, and the lint baseline.

```sh
pnpm install
pnpm check      # typecheck + test + lint
pnpm fix        # apply safe lint fixes
```

## 📖 License

MIT. joggle is free and open-source software, licensed under the
[MIT License](./LICENSE).

[license-badge]: https://img.shields.io/badge/license-MIT-blue.svg
[license-url]: ./LICENSE
[ci-badge]: https://github.com/tognmund/mess/actions/workflows/joggle.yml/badge.svg
[ci-url]: https://github.com/tognmund/mess/actions/workflows/joggle.yml
