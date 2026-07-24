# New Passes

Four new analysis passes for the entropy machine. Each reuses existing infrastructure — the AST visitor, dependency graph, type resolution, and NCD — but applies domain-specific rules on top.

```
entropy-machine/src/
├── composition.rs   # tripartite enforcement
├── ddd.rs           # DDD boundary leak detection
├── deep.rs          # deep module metrics
└── main.rs          # +4 new flags
```

---

## 1. Composition Linter (`--composition`)

Flag: `./entropy-machine --composition src/components/`

Based on the **Composition Pattern Starter** (Fernando Rojo). Enforces:

1. Components export via dot notation (`Composer.Provider`, `Composer.Input`, …)
2. Context is structured `{ state, actions, meta }`
3. No prop drilling through intermediate sub-components
4. One file per block, no orphan exports

### Data Structures

```rust
// composition.rs

use std::collections::HashMap;
use std::path::PathBuf;

/// One composition module (e.g. `components/settings-dialog/`)
#[derive(Debug, Clone)]
pub struct CompositionModule {
    pub dir: PathBuf,
    pub index_file: PathBuf,          // index.ts
    pub exported_keys: Vec<String>,   // keys on the exported object literal
    pub block_files: Vec<PathBuf>,    // individual .tsx files in dir
    pub provider: Option<ProviderShape>,
    pub orphans: Vec<String>,         // exported keys with no matching file
    pub unexported_files: Vec<PathBuf>, // files in dir not in index export
}

/// Shape of a Provider's context value
#[derive(Debug, Clone)]
pub struct ProviderShape {
    pub file: PathBuf,
    pub line: usize,
    pub keys: Vec<String>,            // top-level keys in the context value
    pub has_state: bool,
    pub has_actions: bool,
    pub has_meta: bool,
}
```

### Core Function Signatures

```rust
/// Walk `components/*/` and collect composition modules.
pub fn collect_composition_modules(root: &Path) -> Vec<CompositionModule>;

/// Check that index.ts exports an object literal with dot-notation keys.
/// e.g. `export const Settings = { Provider, Dialog, … }`
pub fn check_dot_notation_export(module: &CompositionModule) -> Vec<Diagnostic>;

/// Parse the Provider component's context value to verify { state, actions, meta }.
pub fn check_provider_shape(
    module: &CompositionModule,
    source_texts: &HashMap<PathBuf, String>,
) -> Vec<Diagnostic>;

/// Detect prop drilling: a prop passes through N intermediate components
/// without being consumed. Uses the dependency graph's Renders edges.
pub fn detect_prop_drilling(
    module: &CompositionModule,
    graph: &Graph,
) -> Vec<Diagnostic>;

/// Ensure every exported key has a matching file and vice versa.
pub fn check_one_file_per_block(module: &CompositionModule) -> Vec<Diagnostic>;

/// Check that sub-components using a context have a Provider ancestor
/// in the render tree.
pub fn detect_missing_provider(
    module: &CompositionModule,
    graph: &Graph,
) -> Vec<Diagnostic>;
```

### Key Pseudocode

#### `check_dot_notation_export`

```
for each composition module:
    parse index.ts AST
    find top-level VariableDeclaration with ExportDeclaration parent
    →
    if declarator.init is ObjectExpression:
        for each ObjectProperty in ObjectExpression.properties:
            key_name = property.key.name  // e.g. "Provider", "Dialog"
            add key_name to exported_keys

        if index exports bare named exports instead of object literal:
            → WARN "components/foo/index.ts exports {Input, Button} —
                     use dot notation: export const Foo = { Input, Button }"
```

#### `check_provider_shape`

```
for each composition module with a Provider:
    find Provider component file (e.g. settings-provider.tsx)
    parse AST, find the JSXElement that renders <Context.Provider value={…}>
    →

    if value expression is ObjectExpression:
        for each property in the object:
            record key name

        if keys ≠ ["state", "actions", "meta"]:
            → WARN "Settings.Provider context leaks shape —
                     got [keys], expected [state, actions, meta]"

        if "state" uses useState/useReducer (good):
            pass
        else:
            → WARN "state shape should be managed by useState or useReducer"

        if "actions" contains functions wrapped in useCallback (good):
            pass
        else:
            → NOTE "actions may cause unnecessary re-renders without useCallback"
```

#### `detect_prop_drilling`

```
for each pair of connected nodes in the Render graph:
    A → B → C → D  (A renders B, B renders C, C renders D)

    check props of A:
        extract prop names from JSX attributes in A's body
        e.g. <B onSubmit={…} data={…} />

    for each intermediate node in the chain (B, C):
        check if that node's parameters include the prop
        check if that node passes the prop to its own child

        if node accepts prop but never uses it (no IdentifierReference in body):
            → WARN "onSubmit prop passes through Settings.Frame unused —
                     Settings.Frame should accept it as a slot or it should be
                     lifted to the Provider"
```

#### `check_one_file_per_block`

```
for each composition module:
    block_files   = glob("components/foo/*.tsx") minus index
    exported_keys = keys from index export minus "useX" hooks

    for each key not matching a file:
        → WARN "useSettings exported but no file — orphan hook"

    for each file not matching a key:
        → WARN "components/settings/hidden-helper.tsx not in index export"
```

#### `detect_missing_provider`

```
for each function/component node in the graph:
    if node.body contains a context hook call (useSettings(), useContext(), …):
        trace render ancestors through the graph's Renders edges
        find the closest ancestor that calls createContext/Provider
        →
        if no such ancestor found in the render chain:
            → ERR "Settings.TextField rendered without Settings.Provider —
                    composition boundary broken"
```

### CLI Integration

```rust
// main.rs additions:
match args[i].as_str() {
    "--composition" => run_composition = true,
    "--all" => { /* ... */ run_composition = true; }
}

if run_composition {
    let modules = composition::collect_composition_modules(&root);
    composition::run_composition_analysis(&modules, &graph);
}
```

---

## 2. DDD Boundary Check (`--ddd`)

Flag: `./entropy-machine --ddd src/`

Based on **Domain-Driven Design** (Eric Evans). Detects:

1. Aggregate root violations (internal entities imported directly)
2. Bounded context boundaries (clusters in the dependency graph)
3. Ubiquitous language drift (domain terms in comments vs identifiers)
4. Value Object vs Entity classification
5. Repository, Anti-Corruption Layer, Domain Event pattern detection

### Data Structures

```rust
// ddd.rs

#[derive(Debug, Clone)]
pub struct AggregateRoot {
    pub name: String,
    pub file: PathBuf,
    pub namespace: String,
    pub internal_entities: Vec<String>, // types defined in same file/dir
    pub external_imports: Vec<ExternalImport>,
}

#[derive(Debug, Clone)]
pub struct ExternalImport {
    pub entity_name: String,      // e.g. "OrderLine"
    pub imported_by: PathBuf,     // who's importing it
    pub expected_root: String,    // who should own it (e.g. "Order")
}

#[derive(Debug, Clone)]
pub struct BoundedContext {
    pub name: String,                    // directory name
    pub files: Vec<PathBuf>,
    pub internal_imports: usize,         // imports within the context
    pub external_imports: usize,         // imports from outside
    pub shared_kernel_imports: usize,    // imports from shared/
    pub outgoing_deps: Vec<String>,      // contexts this one depends on
}

#[derive(Debug, Clone)]
pub struct DomainTerm {
    pub term: String,            // the canonical term
    pub seen_in_comments: usize,
    pub seen_in_identifiers: usize,
    pub aliases_used: Vec<String>, // alternate names found (e.g. "User" for "Customer")
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DomainObjectKind {
    Entity,        // has identity field (id, uuid, …)
    ValueObject,   // no identity, structural equality
    DomainEvent,   // name matches *Event, has timestamp
    Repository,    // only imports DB + domain types
    Service,       // coordinates, no state
    AntiCorruptionLayer, // sits between two contexts, translates types
    Unknown,
}
```

### Core Function Signatures

```rust
/// Heuristically identify aggregate roots: files that export a type with an
/// identity field AND define internal entity types in the same directory.
pub fn find_aggregate_roots(
    graph: &Graph,
    type_fps: &[TypeFingerprint],
) -> Vec<AggregateRoot>;

/// For each aggregate root, check whether internal entities are imported
/// directly from outside the aggregate boundary.
pub fn detect_aggregate_violations(
    roots: &[AggregateRoot],
    graph: &Graph,
    all_data: &[FileData],
) -> Vec<Diagnostic>;

/// Cluster the dependency graph to find bounded context boundaries.
/// Contexts are directories with high internal coupling and low external coupling.
pub fn detect_bounded_contexts(graph: &Graph) -> Vec<BoundedContext>;

/// Compare domain terms used in JSDoc comments against identifiers in the same
/// file. Drift = comments say "Customer" but code says `User`/`Client`.
pub fn detect_ubiquitous_language_drift(
    all_data: &[FileData],
) -> Vec<DomainTerm>;

/// Classify a type as Entity, ValueObject, DomainEvent, or Unknown based on
/// its shape (identity field = Entity, no identity = ValueObject, name pattern).
pub fn classify_domain_object(
    type_fp: &TypeFingerprint,
    source_text: &str,
) -> DomainObjectKind;

/// Detect Repository pattern: a module whose only imports are DB/ORM packages
/// and domain types, and whose exports are domain objects.
pub fn detect_repositories(
    graph: &Graph,
    all_data: &[FileData],
) -> Vec<Diagnostic>;

/// Detect ACLs: modules sitting between two bounded contexts that import from
/// both and have a high type-transform ratio (not just passthrough).
pub fn detect_anti_corruption_layers(
    graph: &Graph,
    contexts: &[BoundedContext],
    type_fps: &[TypeFingerprint],
) -> Vec<Diagnostic>;
```

### Key Pseudocode

#### `detect_aggregate_violations`

```
-- Heuristic: aggregate roots are directories that export a type with "id".
-- Their "internal entities" are other types declared in the same directory.

for each directory with 3+ exported types:
    candidates = types that have an "id" / "uuid" / "key" field

    for each candidate as root:
        internal_entities = all other types in same directory

        -- Now check: is any internal entity imported from outside?
        for each import in all_data (from files NOT in this directory):
            if imported symbol matches an internal_entity name:
                → WARN "billing/invoice.ts imports OrderLine directly —
                         bypass aggregate root Order.
                         Expected: import { Order } and access Order.line"

                -- Additional check: is Order itself also imported?
                if Order is NOT imported in the same file:
                    → ERROR "Aggregate boundary violation —
                             OrderLine used without its root Order"
```

#### `detect_bounded_contexts`

```
-- Cluster graph nodes by directory.
-- A bounded context boundary exists where:
--   1. Two directories have zero mutual imports
--   2. Both share imports from a common "shared/" or "kernel/" directory

for each pair of directories (A, B):
    imports_A_from_B = count(edges where src ∈ A, dst ∈ B)
    imports_B_from_A = count(edges where src ∈ B, dst ∈ A)
    mutual_imports = count(edges where src ∈ A, dst ∈ shared_kernel
                           AND dst ∈ B, dst ∈ shared_kernel)

    if imports_A_from_B == 0 AND imports_B_from_A == 0 AND mutual_imports > 2:
        → NOTE "billing/ and shipping/ have 0 mutual imports but share 8
                 types from shared/ — probable bounded context boundary"

    -- Detect leaking boundaries: low mutual imports but high type collisions
    type_collisions_between = same-name types with different resolved types
                              across A and B
    if type_collisions_between > 0:
        → WARN "Same name 'Price' resolves to different types in billing/
                 and shipping/ — possible shared kernel concept, should be
                 unified or explicitly separated"
```

#### `detect_ubiquitous_language_drift`

```
for each file:
    domain_terms_in_comments = []
    for each JSDoc/block comment in file:
        extract capitalized nouns, PascalCase terms, business terms
        e.g. from "/** The Customer must have a valid Subscription */"
             → ["Customer", "Subscription"]

    domain_terms_in_identifiers = []
    for each identifier (function name, variable, type) in file:
        split PascalCase/camelCase into words
        e.g. from "createUserAccount" → ["create", "User", "Account"]

    for each comment_term:
        if comment_term NOT found in identifiers:
            → WARN "Domain term 'Customer' appears in comments but not in
                     code identifiers — using 'User'/'Client' instead.
                     Ubiquitous language drift."
```

#### `classify_domain_object`

```
fn classify(type_fp, source_text):
    name = type_fp.name

    -- Check name patterns first
    if name matches "*Event" | "*Happened" | "*Occurred":
        -- Verify domain event shape: immutable, has timestamp
        has_occurred_at = source_text contains "occurredAt" | "timestamp" | "date"
        has_mutators = source_text matches "set\w+\("  -- setter methods
        if has_occurred_at and not has_mutators:
            return DomainEvent

    -- Check for identity
    has_id_field = source_text matches pattern:
        /(id|uuid|key|_id)\s*[:?]\s*(string|number|bigint)/
    if has_id_field:
        return Entity

    -- Check for mutability
    has_setter = source_text matches pattern:
        /set\w+\s*\(/   -- set methods
    has_mutable = has_setter or source_text contains "let " or "var "

    -- Value objects: no identity, ideally immutable
    if not has_id_field and not has_mutable:
        return ValueObject
    if not has_id_field and has_mutable:
        → WARN "{name} has no identity field but has setters —
                 value objects should be immutable"

    return Unknown
```

#### Detect Repository Pattern

```
for each module (file):
    imports = all import statements

    -- Check: all imports are either ORM/db packages or domain types
    orm_packages = ["prisma", "drizzle", "typeorm", "sequelize",
                    "knex", "pg", "mysql", "mongodb", "@prisma/client"]
    domain_dirs = paths under "domain/", "models/", "entities/"

    is_db_import = any import source matches an orm_package
    is_domain_import = any import source is from a domain directory
    has_other_imports = any import that is NOT db AND NOT domain

    if is_db_import and is_domain_import and not has_other_imports:
        → NOTE "{file} matches Repository pattern —
                 100% of imports are ORM + domain types"
```

#### Detect Anti-Corruption Layer

```
for each module:
    imports_from_legacy = imports from "legacy/", "old/", "v1/"
    imports_from_new = imports from "new/", "v2/", "core/"

    if imports_from_legacy > 0 and imports_from_new > 0:
        -- Check for translation: high type-transform ratio
        exports = types exported by this module
        imports_types = types imported from both contexts

        -- If module's exports are a remapping of legacy → new:
        if type_transform_ratio > 0.5:  -- lots of mapping, not passthrough
            → NOTE "{file} sits between legacy/ and core/ with
                     {ratio} transform ratio — Anti-Corruption Layer pattern"
```

### CLI Integration

```rust
if run_ddd {
    let roots = ddd::find_aggregate_roots(&graph, &type_fps);
    ddd::print_aggregate_violations(&roots, &graph, &all_data);

    let contexts = ddd::detect_bounded_contexts(&graph);
    ddd::print_context_boundaries(&contexts);

    let drift = ddd::detect_ubiquitous_language_drift(&all_data);
    ddd::print_language_drift(&drift);

    ddd::print_domain_classifications(&type_fps, &all_data);
}
```

---

## 3. Deep Module Metrics (`--deep-modules`)

Flag: `./entropy-machine --deep-modules src/`

Based on **A Philosophy of Software Design** (John Ousterhout). Measures:

1. Deep module score (`implementation_lines / exports_count`)
2. Information hiding leaks (internal symbols imported externally)
3. Temporal coupling (lock/unlock, open/close pairs)
4. Exception handling sprawl
5. Classitis (too many tiny classes)
6. General-purpose vs special-purpose module classification
7. Strategic comment density

### Data Structures

```rust
// deep.rs

#[derive(Debug, Clone)]
pub struct DeepModuleMetrics {
    pub file: PathBuf,
    pub namespace: String,
    pub export_count: usize,           // surface area
    pub implementation_lines: usize,   // depth
    pub deep_score: f64,              // implementation_lines / export_count
    pub is_deep: bool,                // score > threshold
    pub info_leaks: Vec<InfoLeak>,
    pub temporal_couplings: Vec<TemporalCoupling>,
    pub exception_lines: usize,
    pub total_lines: usize,
    pub class_count: usize,
    pub avg_class_size: f64,
    pub strategic_comment_ratio: f64,  // "why" comments / total comments
}

#[derive(Debug, Clone)]
pub struct InfoLeak {
    pub symbol_name: String,
    pub defined_in: PathBuf,
    pub leaked_to: PathBuf,
    pub is_internal_by_naming: bool,  // starts with _, in internal/ dir, etc.
}

#[derive(Debug, Clone)]
pub struct TemporalCoupling {
    pub first_fn: String,    // e.g. "lock"
    pub second_fn: String,   // e.g. "unlock"
    pub file: PathBuf,
    pub missing_pair: bool,  // true if one is called without the other
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ModulePurpose {
    GeneralPurpose,    // imported by 10+ unrelated modules
    SpecialPurpose,    // imported by 1 module
    Shared,            // imported by 2-9 modules
}
```

### Core Function Signatures

```rust
/// Compute the deep module score for every module file.
/// Deep score = implementation_lines / exports_count.
/// Higher score = deeper module (good, per Ousterhout).
pub fn compute_deep_module_metrics(
    graph: &Graph,
    all_data: &[FileData],
) -> Vec<DeepModuleMetrics>;

/// Find symbols that appear to be internal (prefixed with _, in internal/ dir,
/// or not exported) but are imported by external modules.
pub fn detect_information_leaks(
    graph: &Graph,
    all_data: &[FileData],
) -> Vec<InfoLeak>;

/// Find method pairs that indicate temporal coupling:
/// lock/unlock, open/close, start/stop, begin/end, connect/disconnect, …
/// Checks whether they're always called together in the same scope.
pub fn detect_temporal_coupling(
    graph: &Graph,
    all_data: &[FileData],
) -> Vec<TemporalCoupling>;

/// Count try/catch blocks vs happy-path code lines. High ratio = exceptions
/// are sprawled across callers instead of being handled internally.
pub fn measure_exception_sprawl(
    all_data: &[FileData],
) -> HashMap<PathBuf, f64>;

/// Classify a module as general-purpose or special-purpose based on how many
/// unrelated modules import it. "Unrelated" = different namespace/directory.
pub fn classify_module_purpose(
    graph: &Graph,
) -> HashMap<PathBuf, ModulePurpose>;

/// Measure strategic comment density: comments containing "why" language
/// (because, reason, rationale, tradeoff) vs "what" comments (describe code).
pub fn measure_strategic_comments(
    all_data: &[FileData],
) -> HashMap<PathBuf, (usize, usize)>; // (strategic, tactical) counts
```

### Key Pseudocode

#### `compute_deep_module_metrics`

```
for each file in all_data:
    export_count = count of:
        export function
        export const … =
        export class
        export interface
        export type
        export default

    implementation_lines = count of NON-export lines that contain actual logic:
        exclude: import statements
        exclude: blank lines
        exclude: comment-only lines
        exclude: type/interface declarations (these are interface, not impl)
        include: function bodies
        include: class method bodies
        include: variable initializations with logic

    deep_score = if export_count > 0:
        implementation_lines / export_count
    else:
        0.0  -- nothing exported, not a module

    -- Ousterhout's threshold (tunable with --deep-threshold)
    is_deep = deep_score > 10.0  -- reasonable default

    if deep_score < 2.0 and export_count > 5:
        → WARN "{file} scores {deep_score} — shallow module.
                 {export_count} exports with only {impl_lines} impl lines.
                 Consider merging with related modules or reducing surface area."

    if deep_score > 20.0:
        → NOTE "{file} scores {deep_score} — deep module.
                 {export_count} exports, {impl_lines} impl lines.
                 Good: simple interface, complex implementation."
```

#### `detect_information_leaks`

```
for each export symbol in the graph:
    -- Determine if symbol is "meant to be internal"
    is_internal = any of:
        symbol name starts with "_"
        file path contains "/internal/" or "/_internal/"
        file path contains "/__tests__/" and symbol is a test helper
        symbol has no JSDoc/TSDoc comment (undocumented exports)

    if is_internal:
        find all files that import this symbol
        for each importer:
            if importer is NOT in the same directory as the symbol:
                → WARN "Internal symbol '{symbol}' (defined in {def_file})
                         imported by {importer} —
                         implementation detail leaked across modules"

            if importer is a test file and the symbol is NOT a test utility:
                → NOTE "Test file {importer} imports {symbol} —
                         test is coupled to internal implementation detail"
```

#### `detect_temporal_coupling`

```
coupling_pairs = [
    ("lock", "unlock"),
    ("open", "close"),
    ("start", "stop"),
    ("begin", "end"),
    ("connect", "disconnect"),
    ("acquire", "release"),
    ("subscribe", "unsubscribe"),
    ("mount", "unmount"),
    ("init", "destroy"),
    ("enable", "disable"),
    ("addEventListener", "removeEventListener"),
]

for each file:
    for each (first, second) in coupling_pairs:
        calls_to_first  = find all call sites of functions matching "*{first}*"
        calls_to_second = find all call sites of functions matching "*{second}*"

        -- Walk up from each call to find the enclosing scope (function body)
        for each call in calls_to_first:
            scope = enclosing function/block
            -- Check if the paired call exists in the same scope
            matching_second = calls_to_second within same scope

            if matching_second is empty:
                → WARN "{caller_fn} calls {first_fn}() without matching
                         {second_fn}() in same scope —
                         temporal coupling violation. If {first_fn} throws,
                         {second_fn} will never execute."
```

#### `measure_exception_sprawl`

```
for each file:
    exception_lines = sum of:
        lines inside try/catch blocks (try body + catch body)
        lines in functions that throw (count the entire function)
        lines in error handling callbacks (.catch(), .onError(), etc.)

    happy_path_lines = total_lines - exception_lines - blanks - comments

    ratio = exception_lines / total_lines

    if ratio > 0.2:
        → WARN "{file} — {ratio:.0%} of code is exception handling.
                 Ousterhout: handle exceptions internally.
                 Callers should not bear the complexity of your failures."
```

#### `classify_module_purpose`

```
for each module (file or namespace):
    importers = set of all files that import from this module
    importer_namespaces = set of namespaces of those importers

    if len(importer_namespaces) >= 10:
        classification = GeneralPurpose
        → NOTE "{module} is general-purpose — imported by {n} namespaces.
                 Keep it. It earns its abstraction cost."
    elif len(importers) <= 1:
        classification = SpecialPurpose
        → WARN "{module} is special-purpose — only imported by {importer}.
                 Candidate for inlining. One consumer doesn't justify a module."
    else:
        classification = Shared  -- 2-9 importers
```

#### `measure_strategic_comments`

```
strategic_markers = ["because", "reason", "rationale", "tradeoff",
                     "why", "however", "alternative", "unfortunately",
                     "TODO", "HACK", "WORKAROUND"]

for each file:
    strategic = 0
    tactical = 0

    for each comment in file:
        text = comment.lower()

        if any marker in text for marker in strategic_markers:
            strategic += 1
        else:
            tactical += 1  -- "what" comments: "// render the list", "// fetch data"

    ratio = if (strategic + tactical) > 0:
        strategic / (strategic + tactical)
    else:
        0.0

    if ratio == 0.0 and (strategic + tactical) > 5:
        → WARN "{file} — 0% strategic comments.
                 All {total} comments describe what, not why.
                 Ousterhout: comments should explain the rationale."
```

### CLI Integration

```rust
if run_deep_modules {
    let metrics = deep::compute_deep_module_metrics(&graph, &all_data);
    deep::print_deep_module_table(&metrics);

    let leaks = deep::detect_information_leaks(&graph, &all_data);
    deep::print_info_leaks(&leaks);

    let couplings = deep::detect_temporal_coupling(&graph, &all_data);
    deep::print_temporal_couplings(&couplings);

    let exceptions = deep::measure_exception_sprawl(&all_data);
    deep::print_exception_sprawl(&exceptions);

    let purpose = deep::classify_module_purpose(&graph);
    deep::print_module_purposes(&purpose);

    let comments = deep::measure_strategic_comments(&all_data);
    deep::print_strategic_comments(&comments);
}
```

---

## 4. Convergence: Trie-Accelerated Neighborhood Matching

The current convergence pass does O(n²) pairwise NCD comparison. For large codebases, this becomes the bottleneck. The fix: use a **trie** to cluster nodes by shared prefix, then only compare within clusters.

```rust
// ncd.rs additions

use std::collections::HashMap;

/// A trie node for fingerprint prefix clustering.
/// Each level represents a token in the normalized fingerprint.
struct FpTrieNode {
    children: HashMap<String, FpTrieNode>,
    node_ids: Vec<usize>,   // graph node IDs with this exact prefix path
}

impl FpTrieNode {
    fn new() -> Self {
        Self { children: HashMap::new(), node_ids: Vec::new() }
    }

    /// Insert a node_id at the path formed by its fingerprint tokens
    fn insert(&mut self, tokens: &[&str], node_id: usize) {
        let mut current = self;
        for token in tokens {
            current = current.children.entry(token.to_string()).or_insert_with(FpTrieNode::new);
        }
        current.node_ids.push(node_id);
    }

    /// Collect all node_ids in clusters at or below the given depth threshold.
    /// A "cluster" is all node_ids that share at least `min_prefix_tokens` tokens.
    fn clusters_at_depth(&self, depth: usize, min_prefix_tokens: usize, out: &mut Vec<Vec<usize>>) {
        if depth >= min_prefix_tokens && !self.node_ids.is_empty() {
            out.push(self.node_ids.clone());
        }
        for child in self.children.values() {
            child.clusters_at_depth(depth + 1, min_prefix_tokens, out);
        }
    }
}

/// Tokenize a fingerprint string into its component parts.
/// "F$B0$B1>B+$R0$R1" → ["F", "$B0", "$B1", ">", "B+", "$R0", "$R1"]
fn tokenize_fingerprint(fp: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut start = 0;
    let bytes = fp.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if i == start { continue; }
        // Split on known token boundaries: $, B, L, U, C, N, M, A, I, F, …
        if b == b'$' || b == b'>' || b == b'<' || b == b'{' || b == b'}'
           || b == b'[' || b == b']' || b == b'?' || b == b':' || b == b','
           || b == b'(' || b == b')' {
            if i > start {
                tokens.push(&fp[start..i]);
            }
            tokens.push(&fp[i..i+1]);
            start = i + 1;
        }
    }
    if start < fp.len() {
        tokens.push(&fp[start..]);
    }
    tokens
}
```

### Trie-Accelerated NCD Comparison

```
fn accelerated_convergence(graph, ncd_threshold):
    -- Step 1: build trie from all node fingerprints
    trie = FpTrieNode::new()
    for node in graph.nodes:
        tokens = tokenize_fingerprint(node.fingerprint)
        trie.insert(tokens, node.id)

    -- Step 2: extract clusters — nodes sharing at least N prefix tokens
    clusters = []
    trie.clusters_at_depth(0, min_prefix=4, clusters)

    -- Step 3: only do pairwise NCD within each cluster
    -- Instead of O(n²) we do O(k × (c²)) where k = clusters, c = avg cluster size
    pass2_pairs = []
    for cluster in clusters:
        for i in 0..len(cluster):
            for j in (i+1)..len(cluster):
                a = cluster[i]; b = cluster[j]
                if a.file == b.file: continue
                d = ncd(neighborhood_fp(a), neighborhood_fp(b))
                if d < threshold:
                    pass2_pairs.push((d, a, b))

    -- Step 4: sort and report as before
    pass2_pairs.sort()
    return pass2_pairs
```

---

## Integration Summary

```
entropy-machine/src/
├── main.rs           # +4 flags, +4 analysis dispatch blocks
├── composition.rs    # new: tripartite enforcement
├── ddd.rs            # new: DDD boundary detection
├── deep.rs           # new: deep module metrics
├── extract.rs        # unchanged
├── ncd.rs            # +trie-accelerated clustering
├── graph.rs          # +render-tree ancestor traversal (for missing-provider check)
├── shower.rs         # unchanged
├── compress.rs       # unchanged
├── suggest.rs        # unchanged
└── types.rs          # unchanged
```

| Flag | Module | Reuses |
|---|---|---|
| `--composition` | `composition.rs` | Graph (Renders edges), AST visitor, `FileData` |
| `--ddd` | `ddd.rs` | Graph (import edges), type resolution, `FileData`, shower |
| `--deep-modules` | `deep.rs` | Graph, `FileData`, AST visitor |
| `--ncd` (accelerated) | `ncd.rs` | `FpTrieNode` + `tokenize_fingerprint` |

All four passes are deterministic — they work from AST structure, dependency graph topology, type resolution data, and text analysis. No LLM, no heuristics that require tuning.
