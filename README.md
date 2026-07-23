# entropy-machine

An entropy reduction tool for TypeScript codebases. Built on Joe Armstrong's idea: walk the AST up and down, find structural duplication, collapse it until the codebase converges.

```
npm install -D entropy-machine
npx entropy-machine src/
```

## What it does

Runs six analysis passes against your TypeScript source:

| Pass | What | Finds |
|---|---|---|
| **Exact match** | AST fingerprinting with identifier normalization | `sum(a,b){return a+b}` = `add(x,y){return x+y}` |
| **NCD** | gzip normalized fingerprints → fuzzy similarity | `QuoteIcon` ≈ `SwirlyDoodle` at NCD=0.20 |
| **Distribution** | Namespace entropy table + most-repeated structures | `lib/db/*.ts` has `delay()` in 6 files |
| **Compression targets** | Raw source NCD, CSS/className dedup, naming entropy, comment duplication | `font-display text-3xl...` in 9 files |
| **Convergence** | Simulate collapse → remap callers → re-detect emergent matches | Collapsing `add→sum` reveals that `calculateTotal` = `computePrice` |
| **Entropy score** | `unique_fingerprints / total_entities` → single 0-1 number | 0.98 for Jig, 0.84 for composition-pattern-starter |

## Quick start

```bash
# Build
cd entropy-machine && cargo build --release

# Run all analyses
./target/release/entropy-machine --all src/

# Run specific passes
./target/release/entropy-machine --ncd src/        # NCD + distribution
./target/release/entropy-machine --compress src/   # Compression targets only
./target/release/entropy-machine --converge src/   # Progressive convergence

# Tune sensitivity
./target/release/entropy-machine --all --ncd-threshold 0.2 src/
```

## Architecture

```
                    extract.rs  ──► fingerprint strings (normalized AST)
                         │
                    ncd.rs     ──► pairwise gzip comparison
                         │
                    graph.rs   ──► call/type/JSX dependency graph
                    ┌────┼────┐
                    │    │    │
              shower.rs │  compress.rs
               distrib.  │  raw source NCD
               entropy    │  className dedup
               table      │  naming entropy
                          │  comment duplication
                    suggest.rs
               collapse / extract / missing-type
```

Each module composes: `extract` produces normalized fingerprint strings → `ncd` compresses them pairwise → `graph` builds the dependency graph → `shower` visualizes the structural landscape → `compress` finds repetition in non-code targets → `suggest` classifies findings.

## Composition-aware analysis

The machine doesn't treat all structural matches equally. It distinguishes:

| Match | Namespaces | Action |
|---|---|---|
| `sum(a,b)` ≈ `add(x,y)` in `lib/` | Same | Collapse into one |
| `Header.tsx::Header` ≈ `Header.tsx::MobileHeader` | Same | Fuzzy — may share pattern |
| `Composer.Header` ≈ `Settings.Header` | Different | Cross-namespace — silence (composition pattern) |

Namespace detection is automatic from directory structure: `lib/`, `components/`, `features/`, `app/` etc.

## Output format

```
═══ Entropy Distribution ═══

  Overall: 334 total, 282 unique → entropy ratio 0.84

  ╭──────────────┬────────┬─────────┬────────┬────────┬───────────────────────╮
  │ namespace    │  total │  unique │ dup gr │ ratio  │  most repeated        │
  ├──────────────┼────────┼─────────┼────────┼────────┼───────────────────────┤
  │ ui           │    123 │      53 │      1 │ 0.431  │ AlertTitle (11×)      │
  │ db           │     40 │      28 │      4 │ 0.700  │ <arrow> (6×)          │
  │ settings-dlg │     31 │      29 │      1 │ 0.935  │ SaveButtonProps (2×)  │
  ╰──────────────┴────────┴─────────┴────────┴────────┴───────────────────────╯

  ── Most Repeated Structures ──
    11×  in 3 (card.tsx, alert.tsx, dialog.tsx)
    8×  in 8 (counter.ts, messages.ts, settings.ts, ...) ↕ cross-namespace
    7×  in 6 (todo-list-context.tsx, composer-context.tsx, ...) ↕ cross-namespace
```

## The Armstrong vision

Joe Armstrong described an entropy machine that walks up and down the stack looking for the same idea expressed in different forms — JSON body, Erlang term, SQL row, URL query string — and collapses them to a single canonical representation. This tool applies that philosophy to a single-language TypeScript codebase, finding functions, interfaces, JSX components, and object literals that express the same structure across files and namespaces.

The four Armstrong mechanisms implemented:

1. **Compression as similarity detector** — NCD (Normalized Compression Distance) via gzip. Two structurally similar function bodies compress well together regardless of naming.
2. **Entropy measurement** — Per-file uniqueness ratio. `register/success/page.tsx` (entropy=0.08) is almost entirely duplicated by the failure page.
3. **Progressive convergence** — Simulate collapse → remap call targets → re-detect emergent duplicates. Each pass reveals new opportunities.
4. **System-wide walk** — Cross-file, cross-namespace analysis. Not just "this file has duplicates" but "this structure repeats 8 times across these 3 namespaces."

## Contributing

The Rust binary lives in `entropy-machine/`. An oxlint JS plugin for per-file checks lives in `src/`. Both ship together.

Requirements: Rust 1.95+, Node.js 20+, pnpm.

```bash
# Rust binary
cd entropy-machine && cargo build --release

# JS oxlint plugin  
pnpm install && pnpm run build
```
