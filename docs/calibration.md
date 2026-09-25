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
`field-type-drift` fires on 110 of 129 states by probability and acts on 15, and
counting only the floor called it noisy.

| Rule | States | Verdict | median | max | acted |
| --- | --: | --- | --: | --: | --: |
| `doc-matches-code` | 400 | decisive | 0.00 | 0.81 | 2 |
| `call-pattern` | 13 | decisive | 0.09 | 0.42 | 0 |
| `duplicate-call-run` | 23 | decisive | 0.10 | 0.39 | 0 |
| `reimplemented-primitive` | 32 | decisive | 0.00 | 0.00 | 0 |
| `language-drift` | 18 | decisive | 0.00 | 0.00 | 0 |
| `field-type-drift` | 129 | decisive | 0.69 | 0.99 | 15 |
| `name-the-primitive` | 142 | decisive | 0.23 | 0.71 | 0 |
| `object-shape` | 161 | decisive | 0.79 | 0.96 | 92 |
| `compose-types` | 222 | noisy | 0.94 | 1.00 | 186 |
| `import-cycle` | 8 | weak | 0.56 | 0.64 | 0 |

Skipped for too few candidates: `layer-direction` and `layer-purity` (shakti-v2
declares no layers), `dependency-fit`, `hoist-to-domain`,
`duplicate-implementation`, `duplicate-meaning`, `naming-drift`,
`one-concept-one-type`, `nullability-drift`, `data-error-as-outage`. A rule with
no candidates has nothing to calibrate, and a rule that composes two decisions has
no single reduction: both are named rather than guessed at.

## Tuning round one

The first calibration had `object-shape` (median 0.84, 116 of 116 fired) and
`compose-types` (0.96, 145 of 147) firing on nearly everything. Two of them were
not bad questions, they were questions that did not use the state they had:

- **`object-shape`** was naming library option objects -- `Intl.NumberFormat`'s
  `{ currency; currencyDisplay; minimumFractionDigits; style }`, a router plugin's
  `{ dir; dirNameRoutePrefix; maxDepth; options }`, an email's `{ from; subject;
  to }`. The criteria now say so: a shape that is an external library's options
  object, or generic bookkeeping that unrelated modules carry, is `coincidental`.
- **`compose-types`** was answering `composes` when the two declarations share a
  NAME -- "Query lists all 4 fields of Query and adds 1", the nonsense its own
  comment had warned about -- because nothing told it that `atoms[id].sameName`
  is decisive. It now says: same name means `same_name_drift`, and a raw or wire
  mirror (`*Row`, `Unparsed*`, `*Json`) means `independent`.

Measured effect on the report:

| Rule | before | after |
| --- | --: | --: |
| `object-shape` | 175 findings (noisy, 214 acted) | **104** (decisive, 92 acted) |
| `compose-types` | 220 findings (noisy, 219 acted) | **187** (noisy, 186 acted) |
| whole report | 707 | **602** |

`object-shape` is tuned. `compose-types` is not, and the reason is worth keeping:
its remaining answers are true compositions. The containment is the evidence the
question is given, so a model that agrees with it is right -- the volume is a
product decision (report advice at info, or flag it), not a question defect.

## The measurement

`joggle check --cwd ../shakti-v2 --format json`, after tuning: **602 findings
across 1729 files**, 3081+ drops (1889 declined, 1016 budget, 240 gated, 36
unreadable, 3 no evidence).

| Rule | before the migration | now |
| --- | --: | --: |
| `field-type-drift` | 124 | **16** (22 declined, 92 gated) |
| `data-error-as-outage` | 1 | 1 |
| `compose-types` | -- | 187 |
| `object-shape` | -- | 104 |

The concept question in `field-type-drift` declined 22 and the band flagged 92,
so 114 of 130 disagreements are recorded rather than printed. That settles the
worry in `docs/type-resolution.md`: a concept question here does work, as long as
the uncertain answers are flagged.

## What is left

- **`compose-types` is loud, not wrong.** 187 findings, nearly all true
  compositions. The lever is whether compose advice is reported or flagged, not
  the question's wording.
- **`import-cycle` is weak** (median 0.56, 8 states, nothing acted). Small sample
  and it never fires; the question needs more states or a sharper boundary.
- **`name-the-primitive` acts on nothing** (142 states, median 0.23). Either the
  candidates on this repository are not one thing, or the question is too strict.
- **The provider sometimes returns a distribution that does not sum to 1.** Seven
  rules hit it on at least one chunk. `check` retries and finishes; `calibrate`
  names the rule rather than aborting. Worth understanding whether those questions
  have too many options or the adapter drops mass.