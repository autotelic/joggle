// Generates docs/rule-anatomy.svg — how joggle's two kinds of rules work.
// Run with: node scripts/diagram-rules.mjs
import { writeFileSync } from "node:fs"

const W = 1500, H = 1108
const SANS = "ui-sans-serif,-apple-system,'Segoe UI',Inter,sans-serif"
const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace"
const PAPER = "#fbfaf6", INK = "#1a1914", MUTED = "#6f6c62", RULE = "#d8d4c8"
const DET = "#0f6f5c", JUD = "#a8480c", OUT = "#3a4a8c", CODE = "#2b2a24", SOFT = "#f1eee6"

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const t = (x, y, s, { size = 14, w = 400, fill = INK, anchor = "start", mono = false, ls = 0, op = 1 } = {}) =>
  `<text x="${x}" y="${y}" font-family="${mono ? MONO : SANS}" font-size="${size}" font-weight="${w}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${ls}" opacity="${op}">${esc(s)}</text>`
const box = (x, y, w, h, { fill = "none", stroke = RULE, sw = 1.2, rx = 12 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`
const pill = (x, y, w, h, { fill = "none", stroke = RULE } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`

// arrow with dashed "flow" class
const arrow = (x1, y1, x2, y2, color = MUTED, cls = "flow") => {
  const mx = (x1 + x2) / 2
  return `<path class="${cls}" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="1.6" marker-end="url(#a-${color.replace("#", "")})"/>`
}

const p = []
p.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="How joggle's rules work">`)
p.push(`<defs>`)
for (const c of [MUTED, DET, JUD, OUT]) {
  p.push(`<marker id="a-${c.replace("#", "")}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="${c}"/></marker>`)
}
p.push(`<style>
.flow{stroke-dasharray:7 6;animation:flow 1.1s linear infinite}
@keyframes flow{to{stroke-dashoffset:-13}}
.pulse{animation:pulse 2.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
@media (prefers-reduced-motion: reduce){.flow,.pulse{animation:none}}
</style>`)
p.push(`</defs>`)
p.push(box(0, 0, W, H, { fill: PAPER, stroke: PAPER, rx: 0 }))

// ── header ──────────────────────────────────────────────────────────────
p.push(t(64, 80, "How joggle decides", { size: 36, w: 700 }))
p.push(t(64, 112, "Two kinds of rule, one report.  Be deterministic where you can prove, and judge only where you must.", { size: 16, fill: MUTED }))
p.push(`<line x1="64" y1="136" x2="${W - 64}" y2="136" stroke="${RULE}" stroke-width="1.2"/>`)

// ── where it sits ───────────────────────────────────────────────────────
const chips = [
  ["tsc / tsgo", "the program  ·  is this well-typed?"],
  ["oxlint", "the file and its AST  ·  is this well-formed?"],
  ["joggle", "the codebase and its facts  ·  is this the same thing as that?"],
]
chips.forEach(([name, sub], i) => {
  const x = 64 + i * 460, y = 154, w = 440, h = 56
  const on = i === 2
  p.push(box(x, y, w, h, { fill: on ? SOFT : "none", stroke: on ? INK : RULE, sw: on ? 1.6 : 1.2 }))
  p.push(t(x + 18, y + 25, name, { size: 16, w: 700, fill: on ? INK : MUTED }))
  p.push(t(x + 18, y + 44, sub, { size: 12.5, fill: MUTED }))
})

// ── the index ───────────────────────────────────────────────────────────
p.push(box(64, 236, W - 128, 116, { fill: "#ffffff", stroke: RULE }))
p.push(t(86, 266, "1 · THE INDEX", { size: 15, w: 700, ls: 0.6 }))
p.push(t(W - 86, 266, "deterministic · content-addressed · cached", { size: 12, fill: MUTED, anchor: "end" }))
p.push(t(86, 296, "oxc parse  →  units · imports · call sites · jsx · object literals · columns", { size: 13.5, mono: true, fill: CODE }))
p.push(t(86, 318, "tsgo  →  types", { size: 13.5, mono: true, fill: CODE }))
p.push(t(86, 340, "an unchanged run costs nothing: the index is reused", { size: 12, fill: MUTED }))

// ── lanes ───────────────────────────────────────────────────────────────
const LY = 392, LH = 396
const DX = 64, DW = 616
const JX = 756, JW = W - 64 - JX

// deterministic lane
p.push(box(DX, LY, DW, LH, { fill: "#ffffff", stroke: DET, sw: 1.4 }))
p.push(`<rect x="${DX}" y="${LY}" width="${DW}" height="6" rx="3" fill="${DET}"/>`)
p.push(t(DX + 22, LY + 40, "2a · DETERMINISTIC RULES", { size: 15.5, w: 700, fill: DET, ls: 0.4 }))
p.push(t(DX + DW - 22, LY + 40, "static", { size: 12, fill: DET, anchor: "end", mono: true }))
p.push(t(DX + 22, LY + 66, "a predicate over the facts — never calls the model", { size: 12.5, fill: MUTED }))

const fy = LY + 92
p.push(pill(DX + 22, fy, 150, 40, { fill: SOFT }))
p.push(t(DX + 22 + 75, fy + 25, "find", { size: 14, w: 600, anchor: "middle" }))
p.push(arrow(DX + 176, fy + 20, DX + 206, fy + 20, DET))
p.push(pill(DX + 210, fy, 210, 40, { fill: SOFT }))
p.push(t(DX + 210 + 105, fy + 25, "predicate over facts", { size: 13.5, w: 600, anchor: "middle" }))
p.push(arrow(DX + 424, fy + 20, DX + 454, fy + 20, DET))
p.push(pill(DX + 458, fy, 136, 40, { fill: SOFT }))
p.push(t(DX + 458 + 68, fy + 25, "diagnostic", { size: 14, w: 600, anchor: "middle" }))

p.push(t(DX + 22, LY + 186, "EXAMPLES", { size: 11, fill: MUTED, ls: 1 }))
const detEx1 = ["layer-direction", "import-cycle", "field-type-drift", "nullability-drift", "object-shape"]
const detEx2 = ["compose-types", "one-concept-one-type", "call-pattern", "duplicate-call-run", "name-the-primitive"]
detEx1.forEach((r, i) => p.push(t(DX + 22, LY + 210 + i * 22, "joggle/" + r, { size: 12.5, mono: true, fill: CODE })))
detEx2.forEach((r, i) => p.push(t(DX + 300, LY + 210 + i * 22, "joggle/" + r, { size: 12.5, mono: true, fill: CODE })))
p.push(t(DX + 22, LY + LH - 20, "always runs — no model, no key", { size: 12, fill: DET }))

// judged lane
p.push(box(JX, LY, JW, LH, { fill: "#ffffff", stroke: JUD, sw: 1.4 }))
p.push(`<rect x="${JX}" y="${LY}" width="${JW}" height="6" rx="3" fill="${JUD}"/>`)
p.push(t(JX + 22, LY + 40, "2b · JUDGED RULES", { size: 15.5, w: 700, fill: JUD, ls: 0.4 }))
p.push(t(JX + JW - 22, LY + 40, "planned · batched", { size: 12, fill: JUD, anchor: "end", mono: true }))
p.push(t(JX + 22, LY + 66, "a query over candidates the code cannot decide by looking", { size: 12.5, fill: MUTED }))

const moves = [
  ["1  find", "high recall · noise tolerated"],
  ["2  evidence", "the panel a reviewer would need — atoms"],
  ["3  questions", "atomic and typed:  Noul · Choice · Score"],
  ["4  policy", "the gates you control"],
  ["5  diagnose", "span · message · help · confidence"],
]
moves.forEach(([k, v], i) => {
  const y = LY + 98 + i * 30
  p.push(t(JX + 22, y, k, { size: 13.5, w: 700, fill: JUD }))
  p.push(t(JX + 148, y, v, { size: 13, fill: INK }))
})

const prim = LY + 246
p.push(t(JX + 22, prim, "Noul: is it true? (0–1)      Choice: one of a set      Score: a level on a rubric", { size: 12.5, fill: MUTED }))

const bx = LY + 266
p.push(box(JX + 22, bx, JW - 44, 34, { fill: SOFT, stroke: JUD }))
p.push(t(JX + 22 + (JW - 44) / 2, bx + 22, "every judged rule's questions travel in ONE request", { size: 13, w: 600, anchor: "middle", fill: JUD }))

const gy = LY + 308
p.push(box(JX + 22, gy, JW - 44, 58, { fill: "none", stroke: RULE }))
p.push(t(JX + 38, gy + 23, "gates", { size: 12, w: 700, fill: MUTED, ls: 0.6 }))
p.push(t(JX + 96, gy + 23, "probabilityFloor 0.5  ·  minMargin 0.25  ·  reviewFloor 0.6", { size: 13, mono: true, fill: CODE }))
p.push(t(JX + 38, gy + 44, "below the floor: drop      ·      uncertain: review      ·      decisive: act", { size: 12.5, fill: MUTED }))

p.push(t(JX + 22, LY + LH - 18, "duplicate-meaning · reimplemented-primitive · naming-drift · hoist-to-domain · …", { size: 12.5, mono: true, fill: CODE, op: 0.85 }))

// ── connectors ──────────────────────────────────────────────────────────
p.push(arrow(430, 352, 372, LY, DET))
p.push(arrow(1090, 352, 1096, LY, JUD))

// ── outcome ─────────────────────────────────────────────────────────────
const OY = 824, OH = 140
p.push(box(64, OY, W - 128, OH, { fill: "#ffffff", stroke: OUT, sw: 1.4 }))
p.push(`<rect x="64" y="${OY}" width="${W - 128}" height="6" rx="3" fill="${OUT}"/>`)
p.push(t(86, OY + 42, "3 · THE OUTCOME", { size: 15.5, w: 700, fill: OUT, ls: 0.4 }))
p.push(t(W - 86, OY + 42, "text · stylish · unix · json · github", { size: 12.5, mono: true, fill: MUTED, anchor: "end" }))
const outs = [
  [86, "DIAGNOSTICS", "one shape for both lanes — span · severity · message · help · confidence"],
  [546, "NOTES", "the census, and every bound the run hit"],
  [1006, "DROPS", "the funnel: no_evidence · budget · declined · gated · unreadable"],
]
for (const [x, head, body] of outs) {
  p.push(t(x, OY + 76, head, { size: 12.5, w: 700, fill: MUTED, ls: 0.8 }))
  p.push(t(x, OY + 100, body, { size: 12.5, fill: INK }))
}
p.push(arrow(372, LY + LH, 372, OY, DET))
p.push(arrow(1096, LY + LH, 1096, OY, JUD))

// ── replay / scope ──────────────────────────────────────────────────────
const RY = 992
p.push(box(64, RY, W - 128, 84, { fill: SOFT, stroke: RULE }))
p.push(t(86, RY + 32, "REPLAY", { size: 11.5, w: 700, fill: MUTED, ls: 1 }))
p.push(t(86, RY + 58, "key = question version + model + evidence + questions", { size: 13, mono: true, fill: CODE }))
p.push(t(700, RY + 58, "commit .joggle/answers.json  →  CI replays --offline with no key", { size: 13, fill: INK }))
p.push(t(W - 86, RY + 32, "SCOPE", { size: 11.5, w: 700, fill: MUTED, ls: 1, anchor: "end" }))
p.push(t(W - 86, RY + 58, "changed · since <rev> · pr · all", { size: 13, mono: true, fill: CODE, anchor: "end" }))

p.push(t(64, H - 18, "joggle — docs/rule-anatomy.svg", { size: 11.5, fill: MUTED }))
p.push(`</svg>`)

writeFileSync(new URL("../docs/rule-anatomy.svg", import.meta.url), p.join("\n") + "\n")
console.log("wrote docs/rule-anatomy.svg", p.join("\n").length, "bytes")
