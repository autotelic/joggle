<div align="center">

# joggle

**The entropy reverser for a TypeScript codebase. Cross-file judgements, enforced like a linter.**

[![CI](https://github.com/tognmund/mess/actions/workflows/joggle.yml/badge.svg)](https://github.com/tognmund/mess/actions/workflows/joggle.yml)

</div>

> "I want to build the entropy reverser — a big sausage machine where you put all
> programs into it and you turn the handle and a smaller number of programs come
> out."
>
> — Joe Armstrong, *The Mess We're In*, 2014

The two halves of building software want opposite things. **Exploration** pushes
the frontier of the design space out into the world: you try things, you hack
things together to learn what the problem actually is, and entropy is the point ,
the mess is the record of everything you learned. A tool that demands a tidy
codebase during that half is a tool that stops the exploring.

joggle is the other half. It looks at what you built and asks one question: **can
this be rebuilt out of the primitives I already have?** That is Armstrong's
reverser, pointed at a repository. It has no opinion about how messy the code is
and no target of zero: a live repository *should* be full of what it finds, because
each one is a place where the code ran ahead of its vocabulary, which is exactly
what pressing the frontier out produces. **The number is not the product. The move
is.**

`tsc` checks one program. `oxlint` checks one file. Neither can tell you that two
functions in different modules are the same concept, that a name means something
different here than it does there, or that a module is not shaped like the other
twelve modules of its kind. joggle is the layer above both: it indexes the codebase
into facts, generates candidates cheaply and deterministically, and asks narrow
typed questions about the candidates it cannot decide by looking.

| Tool | Unit | Question | Output |
| --- | --- | --- | --- |
| `tsc` / `tsgo` | the program | is this well-typed? | diagnostics |
| `oxlint` | the file and its AST | is this well-formed? | diagnostics |
| **joggle** | the codebase and its facts | is this the same thing as that? | diagnostics |

The design rule is one sentence: **be deterministic where you can prove, and judge
only where you must.** What the tool is *for*, the entropy reverser, and the three
moves a finding can propose, is in [docs/thesis.md](./docs/thesis.md); the
architecture is in [JOGGLE.md](./JOGGLE.md).

## The three moves

Every finding proposes one of three things, and they are not interchangeable. The
rule declares the move, every finding carries it, and the report **groups by it**:

- **contract**: a primitive already exists here; this is a second copy of it.
  Delete the copy and use the primitive. Cleanup: cheap, safe, mechanical.
- **combine**: the primitives exist and the combination was never written. The
  thing is real; it just is not stated as a composition. A refactor.
- **expand**: neither: the code's model of the problem is wrong, and the vocabulary has to grow: a name
  for a concept nobody named, a type that carries an invariant instead of being
  re-checked, a boundary in the wrong place. A **design act**, and the scarcest and
  most valuable of the three.

The report prints them in that order on purpose. It is a ratchet: **the copies
hide the primitives**, so nothing is legible until the duplicates are gone;
composing makes the primitives explicit; and a new primitive has to be built out
of the ones you can now see. That is Armstrong's "clean the leaves first", applied
to the report.

| move | rules |
| --- | --- |
| **contract** | `duplicate-implementation`, `duplicate-meaning`, `reimplemented-primitive`, `naming-drift`, `one-concept-one-type`, `call-pattern`, `duplicate-call-run`, `single-path`, `inferred-over-recorded` |
| **combine** | `compose-types` (the compose advice) |
| **expand** | `compose-types` (a name declared twice), `object-shape`, `name-the-primitive`, `types-over-logic`, `field-type-drift`, `nullability-drift`, `language-drift`, `hoist-to-domain`, `shallow-module`, `name-as-address`, `meaning-switched-by-flag`, `generic-carries-a-caller`, `page-needs-composition` |
| **requirement** | the rest check the code against a requirement: a cycle, a layering, a boundary, a wire schema, a cloud of undeclared dependencies. `layer-direction`, `layer-purity`, `import-cycle`, `module-direction`, `dependency-fit`, `doc-matches-code`, `temporal-coupling`, `data-error-as-outage`, `schema-excludes-domain-value`, `unbounded-default-read`, `unaccounted-drop`, `rule-judgment`, and the composition preset's bundle rules |

A move is a band, not a severity. A 104-file `expand` and a two-file `contract`
are both real; they are just different kinds of work. Severity says how urgent a
finding is; the move says what kind of thing it is asking for.

`joggle rules` lists what a repository enforces, in this order.

## Jev

The judged half runs on **Jev**, TypeSafe's System One model. It is a *judgement*
model, not a generative one: it does not write text or choose its next action, it
answers narrow typed questions with calibrated probabilities. That is what makes it
composable with code, and it is the whole reason joggle asks rather than decides.

- **Typed questions, not prompts.** A yes/no is a **Noul**, a choice among named
  options is a **Choice**, a spectrum is a **Score**. Every answer is validated
  against the labels before a rule sees it, so no rule ever parses prose. The
  question, its criteria and the evidence panel are all data.
- **Bands, not booleans.** A probability is a value, not a verdict. One policy file
  turns a Noul's probability, a Choice's margin and the answer's confidence into
  three actions: **act** (print a finding), **review** (print a notice, the model
  is unsure, and a linter that hides its uncertainty is a linter nobody reads), or
  **drop** (recorded, never printed).
- **One request.** Every rule's candidates for a run are answered together: the
  engine merges their evidence into one state and sends as few requests as fit.
  Questions run in parallel; the vendor measures batching a set of questions at
  about 12× cheaper and 10× faster than asking them one at a time. A request the
  provider rejects is split and retried rather than lost.
- **A Noul is asked three times.** One yes/no arrives as a single number with no
  second signal, so a Noul would be gated by its probability alone. Instead it is
  asked `repeats` times in the same request and reduced to a mean plus the
  **agreement** across the asks, which becomes its margin, exactly what a Choice
  gets from its own distribution. A Choice is asked once, because its distribution
  already is the signal. ([Self-consistency](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook).)
- **The verdicts are a file.** Every answer is cached per question and per piece of
  evidence in `.joggle/answers.json`, so it can be *committed*. CI, and a teammate
  with no key, replay it at zero cost and zero tokens, and adding a question, or
  changing a declaration another question does not name, leaves every other answer
  valid.
- **It is calibrated, not assumed.** `joggle calibrate` replays each question over
  the candidates a real repository produces and labels it *decisive*, *weak*,
  *noisy* or *skipped*, so a question that agrees with its own generator, or one
  that never acts, is visible rather than guessed at.
- **What Jev is not.** It is not a calculator, a date comparator or a code
  generator. The docs say keep arithmetic in code and joggle does: counts, sums,
  spans, orderings and structure all come from the index, and the model answers
  only what a person would have to read to decide.

The judged rules send the evidence panel, including source excerpts of the
declarations being compared, to `api.typesafe.ai`. Deterministic work and
`--offline` send nothing.

## Get it running

### As a local CLI

From this checkout:

```sh
pnpm install && pnpm build
pnpm joggle check src        # runs the source, no build needed
node dist/main.js check src  # runs the build
npm link                     # puts `joggle` on PATH (bin/joggle.js)
```

Once published, `npm install -D @autotelic/joggle` and `npx joggle …` is the same
command with no checkout.

```sh
joggle rules                      # what this repository enforces, by move
joggle check                      # the whole project: tsgo says what that is
joggle check src packages/domain  # or the paths you name
joggle check --changed            # what changed since the stored run
joggle check --since origin/main  # what this branch changed
joggle check --pr                 # what this pull request changed
```

With no paths, joggle asks `tsgo --listFilesOnly` what the project is and analyses
what the compiler sees; `--no-tsgo` walks the paths itself instead. `--types`
resolves types through the checker: declaration types from `tsgo`'s trace, and
the checker's own type at a node's offset. The type-aware rules need it.

### The key, and running without one

The judged rules read `TYPESAFE_API_KEY` from the environment:

```sh
TYPESAFE_API_KEY=… joggle check src
doppler run -- joggle check src      # or direnv, or whatever the team uses
```

Every verdict is written to `.joggle/answers.json`. Commit it, and CI and
teammates replay with no key and no tokens:

```sh
git add .joggle/answers.json
joggle check --offline               # replay the committed verdicts, call nothing
```

To keep evidence inside a network, point `TYPESAFE_BASE_URL` at your own
deployment; or judge public code only and let the committed cache carry the
verdicts.

### As a pi extension

The repository is a [pi](https://pi.dev) package (`pi.extensions` →
`./extensions`), so pi can run joggle in whatever repository it is working in:

```sh
pi install /absolute/path/to/joggle   # global: adds the tools and the command
pi -e /absolute/path/to/joggle        # one run, no install
```

It adds three things:

- **`joggle_check`**: run a scoped check and return the findings.
- **`joggle_rules`**: list what the current repository enforces.
- **`/joggle`**: run a check from the prompt line.

The extension is a thin shell over the CLI, and the report is built from the files
on disk, never from a remote, which is what makes "cut a PR, then iterate" work:
the next run sees the edits made after the last one.

## Output

Output formats follow oxlint's: `text` (default), `stylish`, `unix`, `json`, and
`github`.

```sh
joggle check --format github     # GitHub Actions annotations
joggle check --max-warnings 0    # warnings fail the build
joggle check --rule joggle/naming-drift
joggle check --baseline .joggle/accepted.json   # report only what is new
```

The text report lists findings grouped by move, then a census by move and by rule.
A run that finds nothing still says what it looked at and what it declined.

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
leave `api-key` off and judged rules replay, or report as skipped where nothing has
been judged. Add the key as a repository secret named `TYPESAFE_API_KEY`. A fork's
pull request does not receive secrets, so it falls back to `--offline`.

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

A preset's severities sit under the repository's own, per rule. The composition
preset adds rules for one starter architecture: dot-notation exports, one file per
block, `{ state, actions, meta }` providers. It is off by default. The layering
rules have nothing to say until `architecture.layers` is set.

## Writing a rule

A rule is a candidate generator plus a question. `@autotelic/joggle/plugin` is the
published surface: the facts, the decision primitives, the report helpers.
`@autotelic/joggle/testing` runs a rule against a fixture with or without a model.
The guide is [docs/writing-rules.md](./docs/writing-rules.md), and the meta-rules
that keep authors on the paved path (a planned rule declares its violations; every
rule has a test; an atom is bounded; a judged rule bands every answer; a rule does
not decide meaning with a pattern; every rule is judged) are enforced by a test.

## License

MIT.
