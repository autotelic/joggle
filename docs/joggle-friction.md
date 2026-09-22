# joggle friction log

Running joggle against a real repository (`shakti-v2`, ~2,500 parsed files) from
a sibling checkout. Everything that fought back, with the reproduction and the
resolution, plus two suspicions that were disproved.

The session that produced this ran before the fixes below. Items marked
**fixed** changed in the same commit as this file; items marked **open** are
either by design or need a repository config.

## The commands that worked

```sh
cd /Users/togmund/autotelic/mess
pnpm joggle rules
pnpm joggle:elsewhere ../shakti-v2 --since origin/develop --offline
doppler run --project joggle --config dev -- pnpm joggle check \
  --cwd /Users/togmund/autotelic/shakti-v2 --pr-number 1568
doppler run --project joggle --config dev -- pnpm joggle ask \
  --cwd ../shakti-v2 "where are bonus rates applied?" services/rest/src/domain/pay-review
```

The judged layer works: findings come back with confidences, and a low-margin
answer is marked for review rather than asserted.

## Fixed

### 1. There is no `joggle` command

**Was:** `joggle@0.1.0` lived only inside the checkout (`bin/joggle.js`,
`dist/main.js`); from any other repository it was `command not found`.

**Now:** a global command, installed once:

```sh
ln -sf /Users/togmund/autotelic/mess/scripts/joggle.sh ~/.local/bin/joggle
```

`~/.local/bin` is on `PATH`. The wrapper resolves its own checkout through the
symlink, prefers `dist/`, falls back to `src/` with the `development` export
condition, and forwards every argument.

### 2. A missing model key was silent

**Was:** with `TYPESAFE_API_KEY` unset the run exited 0, and the only tells were
an `(unverified)` suffix and `0 API calls` in the footer.

**Now:** the report says it in a sentence:

```
note: no model key reached the provider, so judged rules were skipped.
      Set TYPESAFE_API_KEY (or run with --offline to say so on purpose).
```

### 3. `doppler run` is context-sensitive

**Was:** from a repository with its own `doppler.yaml`, a bare `doppler run`
looked for the wrong project and died with `Could not find requested project
'joggle'`.

**Now:** the global wrapper supplies the key itself. The first attempt -- pass
`--project joggle --config dev` -- was only half a fix, and the second session
proved it: doppler resolves a project from the **working directory's**
`doppler.yaml`, and a sibling repository's setup wins over the explicit flags.
Even `DOPPLER_PROJECT` / `DOPPLER_CONFIG` in the environment lose. The matrix,
same command, only the working directory varying:

```sh
cd mess      && doppler run --project joggle --config dev -- node dist/main.js rules   # ✓
cd shakti-v2 && doppler run --project joggle --config dev -- node mess/dist/main.js rules   # ✗
cd shakti-v2 && (cd mess && doppler run --project joggle --config dev -- node dist/main.js rules)  # ✓
```

The wrapper now fetches the one secret from the joggle root with
`doppler secrets get TYPESAFE_API_KEY`, then runs the analysis from the
caller's directory -- so the analysed root, a relative `--cwd`, and the report's
paths all stay what the caller asked for.

A second session found the other half. pi spawns the wrapper directly, not
through a login shell, and the environment it hands over has no `HOME` -- which
doppler needs to find its own auth. `env -i PATH=… joggle check …` reproduced
pi's `MissingKey` exactly, and adding `HOME` back fixed it. The wrapper now
restores `HOME` from the passwd database when it is missing, and checks a
gitignored `.env.local` beside itself before doppler, so a host without an auth
context still gets the key. The failure is also visible now: the warning goes
to stderr and the pi tools append it to the result, so a degraded run says
`no model key …` instead of leaving a bare `skipped - MissingKey` to infer.

### 4. Relative `--cwd` + a git scope found nothing (bug)

**Was:**

```sh
cd mess
pnpm joggle check --cwd ../shakti-v2 --since origin/develop     # ✗
# → discover: no source files under ../shakti-v2
pnpm joggle check --cwd /Users/togmund/autotelic/shakti-v2 --since origin/develop   # ✓
```

**Cause:** not the git diff. When no path argument is given, discovery asks
`tsgo --listFilesOnly` for the project and then keeps the files under the root
with `file.startsWith(root)`. With a relative root, the absolute paths tsgo
printed did not start with `../shakti-v2`, so the list came back empty and
discovery returned nothing. An explicit path bypassed tsgo and walked instead,
which is why it worked.

**Now:** `--cwd` is resolved to an absolute path at the CLI boundary, and
`underRoot` resolves both sides and compares path segments, so a sibling whose
name merely begins with the root no longer matches either.

### 5. The message blamed the wrong thing

**Was:** `no source files under X, and no path argument was given` -- even when
the cause was tsgo returning a list that did not survive the root comparison.

**Now:** the message names the source. `tsgo listed no source files under X`,
`no source files under X`, or `no source files under <paths> in X`. And a git
scope that comes back empty says so instead of looking like a clean repository:

```
note: the changed-file list for origin/develop is empty: nothing is in scope,
      so this run reports nothing
```

### 6. `joggle ask` on a whole repository failed hard (bug)

**Was:** one request carried a decision per candidate, so a whole-repository ask
exceeded the provider's output ceiling and exited 1 with a stack trace. `check`
had `--max-tokens`; `ask` had no budget and no fallback.

**Now:**

- `ask` takes `--max-tokens` (default 8,000) and trims the candidate list to the
  input budget before sending.
- A request the provider still rejects is halved and retried, down to one
  candidate -- the same degradation `check` uses for its chunks.
- A typed failure prints one sentence, not a stack trace.

Narrowing the paths remains the best answer, and the per-directory ask that
worked before still works.

### 7. `joggle_check` output was unbounded

**Was:** a `scope: "all"` tool call returned ~1,186 findings / ~51k characters
in one result; the default `scope: "changed"` returned the same because the
machine-local stored run was the full-repo one and nothing had changed, so it
replayed.

**Now:** the pi tool takes `limit` (default 50, `0` for all) and always reports
the total:

```
showing 50 of 1186 findings; narrow the scope, pass rule, or raise limit to see the rest
```

The CLI-side escape remains `--no-replay`.

### 8. `/joggle` and `joggle_check` disagreed about `cwd`

**Was:** the tool resolved a relative `cwd`; the slash command passed `--cwd`
through raw, so it hit bug #4 while the tool call did not.

**Now:** #4 is fixed at the CLI, so both forms resolve the same way. The slash
command also applies the same non-invasive cache rule as the tool.

### 9. Judged results depended on pi's ambient environment

**Was:** the extension ran `dist/main.js` directly, so it inherited pi's
environment (no key) and pi runs were `(unverified)` unless `JOGGLE_BIN` pointed
at a wrapper.

**Now:** the extension prefers a `joggle` on `PATH` -- on this machine, the
doppler-aware wrapper -- so pi and the shell produce the same judged results.
`JOGGLE_BIN` still overrides, and the checkout build is the fallback.

### 10. Noise and duplication on a real repository

Three changes, and one honest limit.

- **`field-type-drift` reported one finding per field, all anchored at the
  declaration's line**, so a type with five drifting fields read as five
  duplicates at `pay-programs.ts:45`. It now emits one finding per declaration
  that lists the fields: `5 field(s) of HourlyPayBreakdown disagree ...`.
- **`language-drift` split prose words differently from code names.** A doc that
  wrote `SortedByDate` became the lowercase blob `sortedbydate`, which no
  identifier could contain, so a name that existed was reported as missing. It
  now splits camelCase the same way declarations do. The reserved words that
  collide with the Choice's own decline option (`none`) or are language
  primitives are filtered too.
- **`object-shape` suppressed too little.** It treated a literal as a use of a
  named type only when the literal carried every field, but optionality is not
  recorded for an interface, so a literal that dropped an optional field was
  reported. A literal whose keys are all fields of a named type is now a use of
  it. On `shakti-v2` the repeated-shape total fell accordingly.
- **Open:** literals that genuinely have no type in the repository -- knex
  insert payloads, Mapbox style objects, test fixtures -- are still reported.
  No code change can know they are structured data; that is what
  `joggle.config.json` is for. `shakti-v2` has no config, so the adapter layer's
  `Money`/`number`, `Count`/`number` pairs and the fixture shapes are all noise
  there until one exists. The `evidence.repository` field and `ignore` list are
  the mechanisms.

## Also found while fixing

**A replayed report dropped its notes.** The replay path kept the stored
diagnostics but replaced the stored notes with the replay message alone, so a
replayed run lost the funnel and every "rule skipped" line -- which made a
replay look like a run that had nothing to say. The stored notes are now kept.

## Disproved suspicions

- **"`--pr` uses the invoking repository's `gh` context."** False. `gh` is
  invoked with the target: `gh pr view 1568 --json baseRefName` with
  `cwd=.../shakti-v2`. The failure in #4 was the relative path and nothing else.
- **"`--pr` diffs against a stale local base branch."** False. `prRef` prefers
  `origin/<base>` when it resolves, so a stale local `develop` cannot widen the
  scope. A hand-rolled diff against the stale local ref gave 44 files where
  joggle correctly reported 18.

## Operator errors, not joggle's

- `timeout` does not exist on macOS by default.
- Piping the 50k-character tool payloads into a model's context twice -- which is
  itself the argument for the `limit` in #7.
