# Calibration and the first real measurement

Two measurements of the rules after every one of them became a Jev rule: what the
questions are worth (`joggle calibrate`), and what the whole rule set reports on a
real repository (`shakti-v2`). Both run against the sibling `shakti-v2` checkout,
with the key, and with `--cache-dir` so nothing is written into that repository.

## Calibration

`joggle calibrate` replays each question over the candidates this project
produces, reduces every answer to `P(violated)` with the plan's declared violating
labels, and applies abide's rule: answers near 0 or 1 are **decisive**, ones that
sit in the middle are **weak**, ones that fire on most states are **noisy**, and
fewer than five states is **skipped**.

Measured on `shakti-v2` (`joggle calibrate --cwd ../shakti-v2`):

| Rule | States | Verdict | median | min | max | fired |
| --- | --: | --- | --: | --: | --: | --: |
| `doc-matches-code` | 400 | decisive | 0.00 | 0.00 | 0.81 | 6 |
| `language-drift` | 18 | decisive | 0.00 | 0.00 | 0.00 | 0 |
| `duplicate-call-run` | 23 | decisive | 0.10 | 0.04 | 0.39 | 0 |
| `call-pattern` | 13 | decisive | 0.09 | 0.00 | 0.42 | 0 |
| `name-the-primitive` | 16 | weak | 0.38 | 0.11 | 0.53 | 2 |
| `import-cycle` | 8 | noisy | 0.56 | 0.32 | 0.64 | 6 |
| `field-type-drift` | 129 | noisy | 0.69 | 0.15 | 0.99 | 110 |
| `object-shape` | 116 | noisy | 0.84 | 0.56 | 0.97 | 116 |
| `compose-types` | 147 | noisy | 0.96 | 0.43 | 1.00 | 145 |

Skipped for too few candidates: `layer-direction`, `layer-purity` (shakti-v2
declares no layers), `name-as-address`, `rule-judgment`, `shallow-module`,
`temporal-coupling`, `dependency-fit`, `hoist-to-domain`,
`duplicate-implementation`, `duplicate-meaning`, `naming-drift`,
`reimplemented-primitive`, `one-concept-one-type`, `nullability-drift`,
`data-error-as-outage`.

Two of those are honest about what calibration can do here: a rule with no
candidates on this repository has nothing to calibrate, and a rule that composes
two decisions (a Noul and a Choice) has no single reduction, so it is named rather
than guessed at.

## What the questions are worth

- **The call questions are decisive.** `call-pattern`, `duplicate-call-run`,
  `language-drift` and `doc-matches-code` answer near 0 on almost every real
  candidate: the model reads a shared call sequence and says "these are not one
  orchestration" with a flat distribution. That is the good shape -- the key
  generates, the question declines.
- **The shape questions are noisy.** `compose-types` (median 0.96), `object-shape`
  (0.84) and `field-type-drift` (0.69) say "violated" on nearly every candidate.
  The keys that generate those candidates are coarse on purpose, so a model that
  agrees with them adds little: it is answering the same question the key already
  answered. `naming-drift`'s shape -- `name-the-primitive` -- is weak rather than
  noisy, which is the opposite problem: it sits in the middle and does not know.

## The measurement

`joggle check --cwd ../shakti-v2 --format json`:

```
707 problems across 1729 files
274 model calls, 4.4M input tokens, 517k output tokens

findings                          drops (3081)
  220  compose-types               1814 declined
  178  duplicate-implementation    1018 budget
  175  object-shape                 210 gated
   55  duplicate-meaning             36 unreadable
   40  hoist-to-domain                3 no evidence
   16  field-type-drift
   10  naming-drift                 per rule that matters here:
    7  doc-matches-code               field-type-drift  22 declined, 92 gated, 16 acted
    2  dependency-fit                 call-pattern      11 declined,  2 gated
    2  reimplemented-primitive        data-error-as-outage 22 declined,  1 acted
    1  data-error-as-outage
    1  module-direction
```

Against the numbers before the migration:

| Rule | before | after |
| --- | --: | --: |
| `field-type-drift` | 124 | **16** (22 declined, 92 gated) |
| `data-error-as-outage` | 1 | 1 |

`field-type-drift` is the one the migration most changed, and for the better: the
"one concept or two?" question declined 22 candidates and the band flagged another
92, so 114 of 130 disagreements are now recorded rather than printed. That is the
answer to the concern from `docs/type-resolution.md`: a concept question here does
work, as long as the uncertain answers are flagged rather than reported.

## Two things this exposed

1. **The band does work the calibration does not see.** `field-type-drift` fires on
   110 of 129 states by probability, but only 16 become findings: the other 92 are
   `gated` on margin and confidence. Calibration with a single threshold therefore
   overstates the noise of a gated rule. A faithful version would count ACTED
   states (apply the whole band) rather than probability above the floor.
2. **The provider sometimes returns a distribution that does not sum to 1.** Seven
   rules hit `Invalid output: Provider returned probabilities that do not sum to
   1` on at least one chunk (`compose-types`, `object-shape`,
   `name-the-primitive`, `hoist-to-domain`, `duplicate-implementation`,
   `duplicate-meaning`, `reimplemented-primitive`). `check` retries and finishes;
   `calibrate` names the rule rather than aborting. It is worth understanding
   whether the question has too many options or the adapter is dropping mass.
