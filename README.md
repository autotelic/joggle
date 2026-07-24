# entropy-machine

> "I want to build the entropy reverser — a big sausage machine where you put all programs into it and you turn the handle and a smaller number of programs come out."
>
> — Joe Armstrong, *The Mess We're In*, 2014

An entropy reduction tool for TypeScript codebases. Finds structural duplication, type collisions, naming drift, and design token repetition — then shows where the entropy lives so you can decide what to collapse.

## Quick Start

```bash
# Build
cd entropy-machine && cargo build --release

# Run all analyses against your codebase
./target/release/entropy-machine --all src/

# Run individual passes
./target/release/entropy-machine --ncd src/        # distribution + NCD
./target/release/entropy-machine --types src/      # type resolution + collisions
./target/release/entropy-machine --compress src/   # raw source, className, comments
./target/release/entropy-machine --converge src/   # progressive convergence

# Tune sensitivity
./target/release/entropy-machine --all --ncd-threshold 0.2 src/
```

## What It Detects

| Pass | Flag | What It Finds |
|---|---|---|
| **Distribution** | `--ncd` | Namespace entropy table with ratio per directory. `ui` at 0.43? Template territory. `db` at 0.70 with `<arrow>` repeated 6×? That's real. |
| **NCD** | `--ncd` | gzip normalized fingerprints pairwise. `handleError` copy-pasted into 4 payment dialogs at NCD=0.064. Raw source body comparison — Armstrong's actual mechanism. |
| **Type Resolution** | `--types` | Spawns a Go type checker. Structural type identity, same-name collisions, declared-vs-resolved divergence, identity passthrough ratio. `addTodo` returns `void` in the provider but `Todo` in the DB — caught. |
| **Compression Targets** | `--compress` | Raw source NCD, className string dedup, identifier naming entropy, comment duplication. `"mx-auto w-full max-w-sm"` in 10 files — token candidate. |
| **Convergence** | `--converge` | Simulate collapse → remap callers → re-detect emergent duplicates. 52 exact matches collapsed → 1 new fuzzy match revealed. |
| **Entropy Score** | `--ncd` | `unique / total` fingerprints → single 0–1 number. 0.98 for Jig, 0.84 for the composition starter. |

## Architecture

```
entropy-machine/
├── src/
│   ├── main.rs         # CLI, file processing, analysis dispatch
│   ├── extract.rs      # AST fingerprint visitor (oxc_ast_visit)
│   ├── ncd.rs          # Normalized Compression Distance via gzip
│   ├── graph.rs        # Dependency graph (calls, renders, type refs)
│   ├── shower.rs       # Distribution table + namespace stats
│   ├── compress.rs     # Raw source, className, naming, comment analysis
│   ├── suggest.rs      # Suggestion engine (collapse/extract/missing-type)
│   └── types.rs        # tsgolint subprocess integration
├── entropy-types       # Go binary (not committed — build from repos/tsgolint)
└── Cargo.toml
```

Each module is composable: `extract` produces normalized fingerprints → `ncd` compresses them → `graph` builds the dependency graph → `shower` visualizes the landscape → `compress` finds non-code repetition → `types` adds structural type identity.

## Requirements

- Rust 1.95+ (oxc crates track recent Rust)
- Go 1.26+ (for the type checker subprocess)
- `repos/tsgolint` cloned with `typescript-go` submodule

## Building the Type Checker

```bash
cd repos/tsgolint
git submodule update --init
mkdir -p internal/collections
find typescript-go/internal/collections -type f ! -name '*_test.go' -exec cp {} internal/collections/ \;
cd typescript-go && git am --3way ../patches/*.patch && cd ..
go build -o ../entropy-machine/entropy-types ./cmd/tsgolint/
```

## Contributing

The machine is a single Rust binary that uses oxc for parsing and AST analysis, tsgolint (Go/TypeScript) for type resolution, and rayon for parallelism. All analysis is local — no network calls, no API keys.
