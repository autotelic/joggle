# Calibration and the measurements

Two measurements of the rules, both after every one of them became a Jev rule:
what the questions are worth (`joggle calibrate`), and what the whole rule set
reports on a real repository (`joggle check`). Both run against the sibling
`shakti-v2` checkout, with the key, and with `--cache-dir` so nothing is written
into that repository.

## Calibration, band-aware

`joggle calibrate` replays each question over the candidates this project
produces, reduces every answer to `P(violated)` with the plan's declared violating
labels, and applies abide's rule: answers near 0 or 1 are **decisive**, ones that
sit in the middle are **weak**, ones that fire on most states are **noisy**, and
fewer than five states is **skipped**.

`fired` counts the states the BAND would act on -- probability, margin and
confidence together -- not the ones above the probability floor. Calibration that
cannot see the difference calls a rule noisy when the report is quiet:
`field-type-drift` fires on 110 of 129 states by probability and acts on 15.

| Rule | States | Verdict | median | acted |
| --- | --: | --- | --: | --: |
| `doc-matches-code` | 400 | decisive | 0.00 | 2 |
| `call-pattern` | 13 | decisive | 0.09 | 0 |
| `duplicate-call-run` | 23 | decisive | 0.10 | 0 |
| `reimplemented-primitive` | 32 | decisive | 0.00 | 0 |
| `language-drift` | 18 | decisive | 0.00 | 0 |
| `field-type-drift` | 129 | decisive | 0.69 | 15 |
| `name-the-primitive` | 142 | decisive | 0.31 | 2 |
| `object-shape` | 258 | decisive | 0.79 | 149 |
| `compose-types` | 222 | noisy | 0.94 | 186 |
| `import-cycle` | 8 | noisy | 0.86 | 5 |

Skipped: `layer-direction` and `layer-purity` (shakti-v2 declares no layers),
`dependency-fit`, `hoist-to-domain`, `duplicate-implementation`,
`duplicate-meaning`, `naming-drift`, `one-concept-one-type`, `nullability-drift`,
`data-error-as-outage`. A rule with no candidates has nothing to calibrate, and a
rule that composes two decisions has no single reduction: both are named rather
than guessed at.

Two of the "noisy" verdicts are the candidate set, not the question: the cycles
`import-cycle` finds are real (`Table` and `TableCell` import each other), and the
compositions `compose-types` finds are real. A question that fires on most states
is only a defect when the states are not mostly violations.

## Tuning

### Round one: questions that did not use their state

- **`object-shape`** was naming library option objects -- `Intl.NumberFormat`'s
  `{ currency; currencyDisplay; minimumFractionDigits; style }`, a router plugin's
  `{ dir; dirNameRoutePrefix; maxDepth; options }`, an email's `{ from; subject;
  to }`. The criteria now say an external library's options object, or generic
  bookkeeping that unrelated modules carry, is `coincidental`. Noisy -> decisive;
  175 findings -> 104.
- **`compose-types`** was answering `composes` for two declarations that share a
  NAME ("Query lists all 4 fields of Query and adds 1"), because nothing told it
  `sameName` was decisive. It now uses `sameName` and the raw-mirror signal. 220 ->
  187.

### Round two: the provider, and the two weak questions

- **The provider** rejects a request when one decision's probabilities do not sum
  to 1 within `1e-6`, which lost the whole chunk. The calibrator now splits a
  failed chunk and retries, so a bad decision loses its own plan rather than every
  rule in the chunk. `object-shape` and `reimplemented-primitive` recovered their
  full state counts; only `duplicate-meaning` still has one candidate the provider
  rejects outright.
- **`compose-types` advice is recorded, not printed.** The compose case was 140 of
  187 findings, all true and none urgent. A name declared twice with different
  fields is the defect and stays a finding. `compose-types` 187 -> **47**.
- **`import-cycle`** was weak (median 0.56) because the state was file names
  alone. The atom now carries the edges that close the loop, so the question can
  tell a real dependency from a barrel. Weak -> noisy; 5 real cycles reported.
- **`name-the-primitive`** acted on nothing (median 0.23). The groups are wide
  record shapes that always travel together -- a plot record's fields, a sale
  row's -- so the criteria now say the co-occurrence IS the signal and `unrelated`
  is for genuinely different purposes. 0 -> 2 findings.

## The measurement

`joggle check --cwd ../shakti-v2 --format json`:

```
469 problems across 1729 files
  178  duplicate-implementation
  104  object-shape
   55  duplicate-meaning
   47  compose-types
   39  hoist-to-domain
   16  field-type-drift
   10  naming-drift
    7  doc-matches-code
    5  import-cycle
    2  dependency-fit, name-the-primitive, reimplemented-primitive
    1  data-error-as-outage, module-direction
```

Across the tuning: **707 -> 602 -> 462 -> 469**, the rises being questions that
now find real things (`import-cycle` +5, `name-the-primitive` +2) and the falls
being noise removed (`object-shape` -71, `compose-types` -140).

| Rule | before the migration | now |
| --- | --: | --: |
| `field-type-drift` | 124 | **16** (22 declined, 92 gated) |
| `data-error-as-outage` | 1 | 1 |

The concept question in `field-type-drift` declined 22 and the band flagged 92, so
114 of 130 disagreements are recorded rather than printed. That settles the worry
in `docs/type-resolution.md`: a concept question here does work, as long as the
uncertain answers are flagged.

## Round three: bands, not drops

`duplicate-implementation` calibrated for the first time: `redundant` is noisy
(206 states, median 0.73, 189 acted). Reading every decision of its nine-question
questionnaire -- via a probe over the warm cache, since calibration reduces only
the declared one -- showed why:

```
verdict        collapse 196, keep_variants   8, no_issue 2
role           domain_concept 94, implementation_detail 53, wire_contract 30, framework_glue 29
prescription   share_a_contract 69, merge 57, move 57, leave_it 23
```

The `verdict` question never said that two independently deployed services sharing
a wire shape should keep both, so it answered `collapse` almost always, and the
read reports unless `verdict` is `keep_variants`/declined. Naming the case moved
`collapse` to 152 and `keep_variants` to 52: **178 findings -> 139**.

The second half is the banding. A band is not a reason to discard an answer, so
the model's `prescription` now sets the severity: `leave_it` and
`share_a_contract` (expected duplication) are notices, `merge`/`move`/`split` are
warnings. **139 = 46 warnings + 93 notices.**

Across shakti-v2 the report is now **459 problems: 162 warnings, 297 notices**
(down from 508, all of it `duplicate-implementation`). The loud block is small and
the expected-duplication record stays visible, which is what the bands are for.

## Round four: a band is not a reason to discard an answer

Thirteen rules treated a non-`act` answer as a drop: `quality.quality !== "act"`
recorded it in the funnel and returned. That is the wrong reading of the bands.
Jev answers with a band so that every band can drive something, and discarding the
model's unsure answer throws away the one signal that says a reader should look.

The gate is now `quality.quality === "drop"` -- only a real no is a recorded drop
-- and `review` is a notice: the rule's own severity when decisive, `info` when
not. Every one of the thirteen moved (twelve uniform gates plus
`import-architecture`'s `readVerdict`), and the meta-rule was renamed from
`flag-not-print` to `band-the-answer`, which is what it was always trying to say.

On shakti-v2: **673 problems = 162 warnings + 511 notices** (was 459 = 162 + 297).
The warnings did not move at all; the notices are the review band that used to be
thrown away. `field-type-drift` alone went 15 warnings + 1 notice to 15 + 89,
`object-shape` 104 + 0 to 131, `types-over-logic` 41 to 67.

That is the honest shape of the report: 162 things a person should change, 511
things an unsure model pointed at, and nothing silently discarded.

## Round five: the band decides the severity, and the boundary in the question

Two rules where the band was not reaching the finding.

**`object-shape`** printed every finding as a notice, because severity was a
property of the rule and not of the finding -- a confident "these literals are one
concept, name them" did not stand out from a shrug. The band now decides: a
decisive `one_concept` is a warning, the review band is a notice, an unverified
fact stays a notice. On shakti-v2: 131 notices -> **104 warnings + 27 notices**.

**`compose-types`** reported 68 same-name pairs, and 18 of them were a name
defined once under `services/rest` and once under `services/ui` -- two deployables
that cannot import each other, so each must define its own wire shape. That is the
same boundary case that was added to `duplicate-implementation`'s verdict, and the
question now names it too (its atom carries both file paths): a shared name across
deployables is `independent`, not drift. 68 -> **47 findings (43 warnings, 4
notices)**.

The report is now **653 problems = 263 warnings + 390 notices**. `object-shape` is
the loudest rule at 104 warnings -- every one a shape repeated across files that
nobody has named, which is what the rule exists to say.

## What is left

- **`object-shape`'s warning volume** (104) is the next thing to look at, and the
  lever is the candidate generator rather than the question: a shape shared by two
  files with two fields is not the same finding as a shape shared by nine files.
- **`duplicate-meaning` has one candidate the provider rejects** outright even
  alone; worth a look at whether its criteria shape causes it.
- **The provider-rejected candidate** is the only remaining blemish on the
  calibrator.
