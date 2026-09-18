/**
 * The surface a rule author writes against.
 *
 * A linter is a registry, and a registry is only half a plugin system. The other
 * half is this file: one entry point exporting everything a rule needs, so an
 * opinion of your own is a module that imports `joggle/plugin` rather than three
 * relative paths into a package's internals.
 *
 * That distinction is not cosmetic. `../../../src/rule.ts` is a path a rule
 * author has to guess and a maintainer is free to move; `joggle/plugin` is a
 * promise. Everything re-exported here is supported, and anything not here is
 * not -- which is also how a rule author knows what they are allowed to rely on.
 *
 * The split follows what a rule actually does:
 *
 *   write one          defineRule, finding, outcome, the Rule interface
 *   read the code      Workspace, Unit, ImportGraph, SourceFile, Cluster
 *   ask a question     Choice, Noul, the judge service, the answer readers
 *   decide in code     qualityOf, marginOf, declined, the gate vocabulary
 *   know the shape     policy, the layer and composition helpers
 *
 * A deterministic rule needs only the first two, and that is deliberate: most
 * opinions are free, and the API should make the free path the easy one.
 */

/* Writing a rule. */
export * from "./rule.ts"

/* The shapes a rule produces and reads. */
export * from "./schema.ts"

/* The code under analysis. */
export * from "./workspace.ts"
export * from "./imports.ts"
export * from "./cluster.ts"
export * from "./similarity.ts"

/*
 * Asking.
 *
 * `Service` and `layer` are the module's own names and both are too generic to
 * publish: a rule author writing `yield* Service` has no idea what they are
 * yielding, and `layer` reads as any other layer in a program. The aliases are
 * what the surface promises.
 */
export * from "./judge.ts"
export { Service as Judge, layer as judgeLayer } from "./judge.ts"

/* Deciding, and the vocabulary decisions are made in. */
export * from "./policy.ts"
export * from "./vocabulary.ts"

/* Architecture: layers, direction, purity, and where something may reach. */
export * from "./architecture.ts"

/* The shared harness for rules whose unit is a set of declarations. */
export * from "./rules/cluster-verdict.ts"

/* The registry, so a preset can compose other presets. */
export * from "./plugins.ts"
export * from "./rules/index.ts"

/*
 * `Effect` itself, because a rule's `run` returns one. Leaving it out would make
 * the surface unusable for the one thing every rule must do.
 */
export { Effect } from "effect"
