# joggle

> Cross-file patterns and idioms for TypeScript, enforced like a linter.

`tsc` checks one program. `oxlint` checks one file. Neither can tell you that
two functions in different modules are the same concept, that a name means
something different here than it does there, or that a module is not shaped
like the other twelve modules of its kind.

joggle is the layer above both. It indexes the codebase into facts, generates
candidates cheaply and deterministically, and then asks narrow typed questions
about the candidates it cannot decide by looking. Answers come back as
probabilities, code keeps control of the thresholds, and the output is an
ordinary diagnostic -- so the same tool serves an editor, a pre-commit hook and
CI.

The design rule is one sentence: **be deterministic where you can prove, and
judge only where you must.**

## Where it sits

| Tool | Unit | Question | Output |
| --- | --- | --- | --- |
| `tsc` / `tsgo` | the program | is this well-typed? | diagnostics |
| `oxlint` | the file and its AST | is this well-formed? | diagnostics |
| **joggle** | the codebase and its facts | is this the same thing as that? | diagnostics |

Because the output shape is identical, a host does not have to care which kind
of rule produced a finding. There is no separate report, no separate format,
and no separate gate.

## The shape of a rule

Every rule is a file with the same five moves.

```
find        deterministic, high recall, noise tolerated
  |
  v
evidence    the panel a reviewer would need in order to decide
  |
  v
questions   atomic, typed (Noul / Choice), all sent in one request
  |
  v
policy      weights and thresholds, imported from policy.ts
  |
  v
diagnose    span, message, help, confidence
```

Deterministic rules never call the judge. That is the only difference between
them and the judged ones.

## Running it

```sh
pnpm install

pnpm joggle rules                              # what is enforced
pnpm joggle check src                          # analyse a directory
pnpm joggle check --typecheck                  # carry tsgo diagnostics too
pnpm joggle check --format github              # GitHub Actions annotations
pnpm joggle check --offline                    # replay from cache, no network
pnpm joggle check --rule joggle/naming-drift   # one rule
pnpm joggle check --max-warnings 0             # warnings fail the build
```

With no paths, joggle asks `tsgo --listFilesOnly` what the project is, so it
analyses exactly what the compiler sees rather than whatever is on disk. With
paths, it walks them itself.

| Flag | Meaning |
| --- | --- |
| `--rule <ids>` | comma-separated rule ids |
| `--format text\|json\|github` | output format |
| `--max-warnings <n>` | fail when warnings exceed `n` (`-1` disables) |
| `--typecheck` | include tsgo diagnostics as `joggle/typecheck` |
| `--no-tsgo` | never invoke tsgo |
| `--offline` | answer only from the judgement cache |
| `--cache-dir <path>` | where `judgements.json` lives (default `.joggle`) |
| `--cwd <path>` | project root |

## CI and replay

A judgement is a network call, so the cache key is the contract:

```
question version + model + evidence + questions
```

It is serialised with sorted keys, so the same candidate produces the same key
on every machine — which means **run from the repository root**. Evidence
carries root-relative paths; running from a subdirectory changes the key and
misses every cached verdict. Successful judgements are written to
`.joggle/judgements.json`; commit that file and CI replays them with
`--offline` and **no API key at all**. Bump `policy.questionVersion` when you
change a question's wording, and every cached answer for it is invalidated at
once instead of silently replayed against newer questions.

When the judge is unavailable, judged rules are reported as skipped and the
deterministic rules still run. A missing key degrades the gate; it does not
disable it.

### Where the key goes

The key is read from the process environment only, so it never appears in the
repository or in any config file joggle owns.

Locally, use the secret manager the team already has:

```sh
doppler run -- pnpm joggle check src      # recommended
direnv allow                              # or a gitignored .envrc.local
```

In CI, add `TYPESAFE_API_KEY` as a repository secret and map it onto the step
that judges new candidates. The replay job needs no secret at all.

Two properties make this safe to live with:

* `.joggle/judgements.json` holds questions, evidence and answers. It never
  holds the key, so it is safe to commit and review.
* Because the cache is the replay path, **the judged run can be done by a
  person and the result handed to CI or to an agent**. Neither of them ever
  needs the credential; they work from the committed verdicts.

If the key is ever pasted into a file, into chat, or into a shell that gets
logged, rotate it in the TypeSafe console. This repository is private, so
GitHub's secret scanning will not catch it for you.

### What leaves the machine

The judged rules send the evidence panel -- including source excerpts of the
declarations being compared -- to `api.typesafe.ai`. Deterministic rules and
`--offline` send nothing.

Decide this per repository. For a client codebase, either point
`TYPESAFE_BASE_URL` at a deployment you control, or run the judged pass over
public and fixture code only and let the committed replay cache carry the
verdicts into the client's CI.

```sh
TYPESAFE_BASE_URL=https://typesafe.internal.example doppler run -- pnpm joggle check src
```

## The judgement

The evidence panel is the System One `state`; the questions are the typed
primitives. Everything the model returns is constrained to the options the rule
supplied, so nothing has to be recovered from generated prose.

- `Noul` -- the probability that a yes/no statement holds.
- `Choice` -- one option out of a set, with the full distribution and a
  confidence.

Thresholds live in `src/policy.ts` and nowhere else. When a verdict stops
matching what the team would decide, you change a weight, re-run, and see the
difference -- you do not rewrite a prompt.

## Adding a rule

1. Add a `src/rules/<name>.ts` with the five moves above.
2. Register it in `src/rules/index.ts`.
3. Put every new threshold in `src/policy.ts`.
4. Test it twice: once with answers that should activate the policy, once with
   answers that should not.
5. Run `pnpm joggle check src` -- joggle is expected to pass its own rules.

## Not here yet

The honest list: no LSP, no `--fix`, no emission as an oxlint rule, no `Score`
questions, and no calibration harness -- the last one being the piece that has
to exist before any rule can move from `warn` to `error` with confidence.

## Layout

```
src/
  policy.ts                 every threshold and question version, one file
  schema.ts                 diagnostics, the System One contract, typed errors
  workspace.ts              oxc facts, normalisation, similarity
  tsgo.ts                   tsgo subprocess adapter
  judge.ts                  System One client with a replayable cache
  rule.ts                   the Rule vocabulary
  rules/                    one file per rule
  check.ts                  the single analysis pass
  report.ts                 text / json / github
  main.ts                   CLI
tests/
  fixtures/corpus/          intentionally duplicated fixture project
```

`docs/` and `entropy-machine/` are untouched. `docs/` is the thinking that
motivated this layer -- how agents navigate code, why names are addresses, parse
don't validate, incremental computation, the deterministic harness.
`entropy-machine/` is the previous implementation: a Rust CLI of hand-written
heuristics. It stays as a reference for what these rules are trying to capture,
and as a reminder of why they are being written differently.
