import { Effect, Option, Schema } from "effect"
import { Decision, DecisionModel } from "effect/unstable/ai"
import { isUnreachable } from "../decision.ts"
import { policy } from "../policy.ts"
import {
  budgetNote,
  declined,
  defineRule,
  finding,
  marginOfAnswer,
  outcome,
  qualityOf,
  type DecisionAnswers,
  type Scope,
} from "../rule.ts"
import type { Diagnostic, Drop } from "../schema.ts"
import type { SourceFile, Workspace } from "../workspace.ts"

const RULE_ID = "joggle/language-drift"

/**
 * A domain word the prose uses and the code does not.
 *
 * The CANDIDATE is structural: a capitalized word the doc blocks repeat and no
 * declaration, path or import uses. That is a fact, and a cheap one.
 *
 * The JUDGEMENT is whether the word names a domain concept the code calls
 * something else. A stopword list cannot answer it -- the first version reported
 * "whether", "what" and "every", and no list makes a heuristic correct. So the
 * model picks the concept, or says none, and code reports what it picked.
 *
 * The words are the Choice's options, one per candidate, so the answer names
 * which one is a concept rather than only that one exists.
 */
const STOPWORDS = new Set([
  "react", "typescript", "javascript", "json", "http", "https", "html", "css", "jsx", "tsx",
  "api", "url", "uri", "uuid", "sql", "yaml", "toml", "xml", "npm", "pnpm", "cli", "sdk",
  "note", "example", "usage", "param", "params", "returns", "return", "throws", "see",
  "todo", "fixme", "hack", "workaround", "important", "warning", "deprecated",
])

const wordsOf = (name: string): ReadonlyArray<string> =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0)

/** The capitalized words that are not at the start of a sentence. */
const termsOf = (doc: string): ReadonlyArray<string> => {
  const words = doc.split(/\s+/)
  const terms: Array<string> = []
  for (let index = 0; index < words.length; index += 1) {
    const raw = words[index] ?? ""
    const clean = /^[^A-Za-z0-9]*([A-Z][A-Za-z0-9]{3,})/.exec(raw)?.[1]
    if (clean === undefined) continue
    const previous = words[index - 1] ?? ""
    if (index === 0 || previous === "" || /[.:;!?]$/.test(previous)) continue
    const lower = clean.toLowerCase()
    if (!STOPWORDS.has(lower)) terms.push(lower)
  }
  return terms
}

interface Candidate {
  readonly file: SourceFile
  readonly words: ReadonlyArray<string>
  readonly docs: ReadonlyArray<string>
}

const Evidence = Schema.Struct({
  file: Schema.Struct({
    path: Schema.String,
    words: Schema.Array(Schema.String),
    docs: Schema.String,
  }),
})

const candidatesIn = (workspace: Workspace, scope: Scope): ReadonlyArray<Candidate> => {
  const identifiers = new Set<string>()
  for (const unit of workspace.units) {
    for (const word of wordsOf(unit.name)) identifiers.add(word)
    for (const segment of unit.file.split("/")) for (const word of wordsOf(segment)) identifiers.add(word)
  }
  for (const file of workspace.files) {
    for (const imported of file.imports) {
      for (const name of imported.names) for (const word of wordsOf(name)) identifiers.add(word)
    }
  }

  const found: Array<Candidate> = []
  for (const file of workspace.files) {
    if (scope.changed !== undefined && !scope.changed.has(file.path)) continue
    const counts = new Map<string, number>()
    const docs: Array<string> = []
    for (const unit of file.units) {
      if (unit.doc === undefined) continue
      docs.push(unit.doc.slice(0, policy.evidence.maxDocChars))
      for (const term of termsOf(unit.doc)) {
        if (identifiers.has(term)) continue
        counts.set(term, (counts.get(term) ?? 0) + 1)
      }
    }
    const words = [...counts.entries()]
      .filter(([, count]) => count >= policy.languageDrift.minMentions)
      .map(([word]) => word)
      .sort((left, right) => left.localeCompare(right))
    if (words.length > 0) found.push({ file, words, docs })
  }
  return found
}

export const languageDrift = defineRule({
  id: RULE_ID,
  severity: "info",
  description: "A domain word the prose uses and the code never names.",
  judged: true,
  run: Effect.fn("joggle/language-drift")(function* (workspace: Workspace, scope: Scope) {
    const candidates = candidatesIn(workspace, scope)
    if (candidates.length === 0) {
      return outcome([], ["every domain word in the prose is also a word in a name"])
    }
    const budget = policy.languageDrift.maxFiles
    const judged = candidates.slice(0, budget)

    const results = yield* Effect.forEach(
      judged,
      (candidate) => {
        const criteria: Record<string, string> = { none: "None of these is a concept the code names differently." }
        for (const word of candidate.words) criteria[word] = "The prose says \"" + word + "\" and no name uses it."
        const definition = Decision.make({
          input: Evidence,
          decisions: {
            concept: Decision.classify({
              instructions: [
                "The doc blocks of `file.path` repeat the words in `file.words`, and no declaration, path or import uses any of them.",
                "Which one, if any, names a concept this code calls something else?",
                "Choose a word when the prose is naming a thing -- an entity, a process, a rule -- and the code names that thing differently.",
                "Choose `none` when the words are ordinary English, the technology stack, or something the code does not model at all.",
              ].join("\n"),
              criteria,
            }),
          },
        })
        return DecisionModel.decide(definition, {
          input: { file: { path: candidate.file.path, words: candidate.words, docs: candidate.docs.join("\n\n") } },
        }).pipe(
          Effect.map((result) => Option.some(result.answers)),
          Effect.catch((error) =>
            isUnreachable(error) ? Effect.fail(error) : Effect.succeed(Option.none<DecisionAnswers>()),
          ),
        )
      },
      { concurrency: policy.decision.requestConcurrency },
    )

    const diagnostics: Array<Diagnostic> = []
    const drops: Array<Drop> = candidates.slice(budget).map((candidate) => ({
      ruleId: RULE_ID,
      subject: candidate.file.path,
      stage: "budget" as const,
      reason: "past the budget of " + budget + " files with prose words",
    }))

    judged.forEach((candidate, index) => {
      const answer = results[index]
      if (answer === undefined || Option.isNone(answer)) {
        drops.push({ ruleId: RULE_ID, subject: candidate.file.path, stage: "unreadable", reason: "the response did not judge this file" })
        return
      }
      const concept = answer.value["concept"]
      if (concept === undefined || !("label" in concept)) {
        drops.push({ ruleId: RULE_ID, subject: candidate.file.path, stage: "unreadable", reason: "the response did not contain a verdict" })
        return
      }
      if (declined(concept.label)) {
        drops.push({ ruleId: RULE_ID, subject: candidate.file.path, stage: "declined", reason: "none of the words names a concept" })
        return
      }
      const quality = qualityOf({
        score: concept.probabilities[concept.label] ?? concept.confidence ?? 1,
        margin: marginOfAnswer(concept),
        confidence: concept.confidence,
      })
      if (quality.quality === "drop") {
        drops.push({ ruleId: RULE_ID, subject: candidate.file.path, stage: "gated", reason: quality.reason })
        return
      }
      const review = quality.quality === "review"
      diagnostics.push(
        finding({
          ruleId: RULE_ID,
          severity: review ? "info" : "warn",
          message: "The prose says \"" + concept.label + "\", and no declaration, path or import uses the word.",
          help:
            "Either the code is named for something else, or the prose describes a concept the code has not named. The first is drift; the second is a missing name." +
            (review ? " For review: " + quality.reason + "." : ""),
          location: { file: candidate.file.path, line: 1, column: 1 },
          identity: [RULE_ID, concept.label].join("\u0000"),
          confidence: concept.confidence ?? 1,
          score: concept.probabilities[concept.label] ?? 0,
          judged: true,
        }),
      )
    })

    return outcome(
      diagnostics,
      budgetNote("files with prose words", budget, candidates.length, candidates.slice(budget).map((candidate) => candidate.file.path)),
      drops,
    )
  }),
})
