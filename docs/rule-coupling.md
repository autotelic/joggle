# Rule coupling: meaning decided in code

joggle's design rule is **be deterministic where you can prove, and judge only
where you must.** There are three things a rule can do with a piece of code, and
only two of them are allowed:

1. **Collect a fact.** The AST says a call site exists; the type trace says an
   expression's resolved type; the import graph says who imports whom. Facts are
   cheap, exact, and do not care what the code is *called*.
2. **Ask a question.** Jev decides what a fact means.
3. **Recognise a pattern.** A regular expression over the source, a list of names,
   a hand-ranked score -- deciding meaning in code, and then asking the model to
   confirm it.

The third is not a fact and not a question. It is a person's opinion wearing the
costume of a fact, and it is the failure `docs/two-regimes.md` names and
`joggle/rule-judgment` exists to find. It has two costs the other two do not:

- **It is coupled to one implementation.** `toFixed(2)` and `formatDollar` are
  how *this* repository spells money today. Rename the helper, adopt a currency
  library, format dates with `Temporal` -- the rule needs editing. The whole point
  of Jev is that the rule does not: the fact is the call site and the resolved
  type, and the meaning is the question.
- **It decides the thing Jev is for.** A pattern that says "this looks like money"
  has already answered the question, and the model is reduced to confirming it --
  which is why these rules agree with their own generator so often
  (`docs/calibration.md`).

### The test

> If I changed the naming convention, the library, or the language idiom -- and
> the *structure* of the code were unchanged -- would this rule need editing?

If yes, the rule is coupled.

## The audit

Every rule, by what its deterministic half actually does.

| rule | what the code decides | verdict |
| --- | --- | --- |
| `single-path` | `DOMAINS`/`HELPER_NAME`/`HELPER_BODY`/`INLINE`: which strings look like money, a percent or a date, and which names are formatters | **coupled** |
| `unaccounted-drop` | `ADAPTER_NAME`/`ADAPTER_PATH`/`SKIPS`/`ITERATES`/`ACCOUNTS`: which functions are adapters, which skip, which account | **coupled** |
| `temporal-coupling` | `PAIRS`: `lock`/`unlock`, `acquire`/`release`, `connect`/`disconnect`, `subscribe`/`unsubscribe`, `mount`/`unmount` | **coupled** |
| `field-type-drift` | `minWords` and `canCompose`: string rules for whether two types are compatible | **coupled** |
| `compose-types` | the same `canCompose` | **coupled** |
| `reimplemented-primitive` | `inputKey`/`argKey`: string shapes standing in for "the same inputs" | **coupled** |
| `hoist-to-domain` | `ruleLikeness`: imported +3, typed +2, comparisons +2, a number +1, a doc +1 -- a hand-ranked score for "looks like a domain rule" | **coupled** |
| `language-drift` | `STOPWORDS` and `termsOf`: prose tokenising standing in for "a domain word the code never names" | **coupled** |
| `naming-drift` | `NON_DISTINGUISHING` and `worthJudging`: a word list plus a token-difference rule for "the same concept" | **coupled** |
| `types-over-logic` | `BARE`/`NULLABLE`, `GUARDS`, `declaredTypeOf`: guard shapes by regex, the declared type by text parse | **partly coupled** -- the guard shape should be an AST fact and the declared type a type fact |
| `page-needs-composition` | `isPage`: `/^(route|page)\.tsx?$/` and `/modal/i` | **coupled** -- a filename convention deciding "is a page" |
| `data-error-as-outage` | `FUNCTION_KINDS`/`STATUS_METHODS`, and "5xx" | borderline -- AST node kinds are facts; the status and the "row" are judged |
| `doc-matches-code` | `messageLiterals` and doc extraction | borderline -- parsing prose is unavoidable; the comparison is judged |
| `rule-judgment` | patterns for switch/threshold shapes | borderline -- it is *about* proxies, and its inputs are structural |
| `object-shape` | field-set equality and subset-of-declared | fact |
| `name-the-primitive` | field co-occurrence | fact |
| `duplicate-implementation`, `duplicate-meaning` | shape hash, resolved type signature, similarity | fact |
| `call-pattern`, `duplicate-call-run` | resolved call sequences (`unit.calls`, `callSignature`) | fact |
| `one-concept-one-type` | the tsgo type trace | fact |
| `nullability-drift` | migration columns plus schema `nullable`/`sources` | fact |
| `import-architecture` (3 rules) | the import graph and the declared layers | fact |
| `dependency-fit` | imports, manifests, node builtins | fact |
| `name-as-address` | exported + one-word name + caller count | fact |
| `shallow-module` | export count and implementation lines | fact |
| `module-direction` | the import graph plus model-classified roles | fact + judged |
| `bundle-conformance` | bundle structure against the pattern's own `TRIPARTITE` spec | fact (a declared spec, not a proxy) |

## How to fix it

A coupled rule is fixed by moving its decision from (3) to (1) and (2): collect
the structural facts, then ask. Two pieces of substrate are missing:

**AST facts.** `StructureFacts` today carries call sites, JSX element names, object
literals and migration columns. The coupled rules reach past it into
`unit.text` because it does not carry what they need:

- **string construction** -- template literals and `+` concatenation, with the
  references they interpolate (`single-path`);
- **guard shapes** -- an `if` and the test's structure (`types-over-logic`);
- **flow** -- `continue`, `throw`, early `return`, and the value returned
  (`unaccounted-drop`);
- **member calls and literals** -- the callee, the receiver, the arguments
  (`field-type-drift`, `reimplemented-primitive`).

**Type resolutions.** `canCompose`, `inputKey`, `BARE` and `isWide` are all
string rules standing in for a type question that the tsgo trace answers exactly.
`src/typetrace.ts` and the `--types` path already exist; the coupled rules do not
use them.

With those two, a rule's deterministic half is exactly what the design rule says:
*a fact from the AST or the type trace, and a question about what it means.*

## Order

1. **Substrate first.** Add the AST facts and wire the type trace to the rules
   that need it.
2. **Then the rules.** Rebuild `single-path` and `unaccounted-drop` on the
   facts (they are new and can be removed cleanly until then), then
   `temporal-coupling`, `field-type-drift`, `compose-types`,
   `reimplemented-primitive`, `hoist-to-domain`, `language-drift`,
   `naming-drift`, `types-over-logic` and `page-needs-composition` one at a time,
   each with its question re-calibrated.
3. **Then the fence.** `joggle/rule-judgment` finds this category in a
   repository's rules; the same shape should be a meta-rule over joggle's own,
   so a rule that reaches into `unit.text` to decide meaning is rejected where it
   is written.
