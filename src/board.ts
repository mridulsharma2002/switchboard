// The switchboard: one row of jacks per model, one column per step. Each attempt is a patch cord
// dropped from the step's label into a model's jack. Used by the hero demo and by real runs.
import { LADDER, MODELS, type ModelKey } from "./models";

export type CordKind = "run" | "retry" | "fallback" | "failed";
export interface Cord { step: number; model: ModelKey; kind: CordKind; label?: string }

const ROWS: ModelKey[] = [...LADDER].reverse(); // Fable on top, the expensive end
const price = (k: ModelKey) => `$${MODELS[k].inputPrice < 1 ? MODELS[k].inputPrice.toFixed(2) : MODELS[k].inputPrice}`;

/** Signal-style bars: how expensive a model is (1-4). */
export const tierBars = (k: ModelKey) =>
  `<span class="tier" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<i${i <= LADDER.indexOf(k) ? ' class="on"' : ""}></i>`).join("")}</span>`;

export const chip = (k: ModelKey) => `<span class="chip-m">${tierBars(k)}${MODELS[k].name}</span>`;

export function renderBoard(el: HTMLElement, cords: Cord[], opts: { steps?: string[]; animateFrom?: number; compact?: boolean } = {}) {
  const stepCount = Math.max(opts.steps?.length ?? 0, ...cords.map((c) => c.step), 1);
  const compact = opts.compact ?? el.clientWidth < 560;
  const left = compact ? 106 : 150, right = 24, top = 54, rowH = compact ? 50 : 58;
  const colW = Math.max(compact ? 64 : 96, 0);
  const W = Math.max(left + right + stepCount * colW, compact ? 340 : 640);
  const usable = W - left - right;
  const H = top + rowH * ROWS.length + 18;
  const cx = (step: number) => left + usable * ((step - 0.5) / stepCount);
  const cy = (m: ModelKey) => top + rowH * ROWS.indexOf(m) + rowH / 2;

  // Offset repeated attempts on the same step so every cord stays visible.
  const seen = new Map<number, number>();
  const placed = cords.map((c, i) => {
    const n = seen.get(c.step) ?? 0;
    seen.set(c.step, n + 1);
    return { ...c, i, x: cx(c.step) + n * (compact ? 9 : 13) };
  });
  const lit = new Set<ModelKey>();
  const last = placed[placed.length - 1];
  if (last) lit.add(last.model);

  let s = `<svg viewBox="0 0 ${W} ${H}" class="board-svg" role="img" aria-label="Which Claude model handled each step">`;
  // Rows: label, price, lamp, rail with jacks
  ROWS.forEach((m) => {
    const y = cy(m);
    s += `<g class="row${lit.has(m) ? " lit" : ""}">`;
    s += `<circle class="lamp-ring" cx="${left - 18}" cy="${y}" r="${compact ? 4.5 : 5.5}"/>`;
    s += `<circle class="lamp" cx="${left - 18}" cy="${y}" r="${compact ? 4.5 : 5.5}"/>`;
    s += `<text class="rname" x="8" y="${y - (compact ? 2 : 3)}">${MODELS[m].name}</text>`;
    s += `<text class="rprice" x="8" y="${y + (compact ? 11 : 14)}">${price(m)}${compact ? "" : " / 1M in"}</text>`;
    s += `<line class="rail" x1="${left - 4}" x2="${W - right + 6}" y1="${y}" y2="${y}"/>`;
    for (let st = 1; st <= stepCount; st++) s += `<circle class="jack" cx="${cx(st)}" cy="${y}" r="${compact ? 5 : 6.5}"/>`;
    s += `</g>`;
  });
  // Step labels across the top
  for (let st = 1; st <= stepCount; st++) {
    const label = opts.steps?.[st - 1];
    s += `<text class="slabel" x="${cx(st)}" y="16" text-anchor="middle">${String(st).padStart(2, "0")}</text>`;
    if (label && !compact) s += `<text class="stitle" x="${cx(st)}" y="32" text-anchor="middle">${esc(trim(label, 16))}</text>`;
    s += `<circle class="port" cx="${cx(st)}" cy="${top - 10}" r="3"/>`;
  }
  // The route trace between consecutive final cords
  const finals = [...new Map(placed.filter((p) => p.kind !== "failed").map((p) => [p.step, p])).values()];
  for (let k = 1; k < finals.length; k++) {
    const a = finals[k - 1], b = finals[k];
    const mx = (a.x + b.x) / 2;
    s += `<path class="trace" d="M${a.x},${cy(a.model)} C${mx},${cy(a.model)} ${mx},${cy(b.model)} ${b.x},${cy(b.model)}"/>`;
  }
  // Cords
  placed.forEach((p) => {
    const y = cy(p.model), x0 = cx(p.step), y0 = top - 10;
    const sag = Math.min(26, (y - y0) * 0.25);
    const d = `M${x0},${y0} C${x0},${y0 + 18} ${p.x + (p.x === x0 ? -sag * 0.6 : sag * 0.3)},${y - 26} ${p.x},${y - 9}`;
    const anim = opts.animateFrom !== undefined && p.i >= opts.animateFrom ? " draw" : "";
    s += `<g class="cord ${p.kind}${anim}" style="--d:${anim ? (p.i - (opts.animateFrom ?? 0)) * 0.12 : 0}s">`;
    s += `<path d="${d}" pathLength="1"/>`;
    s += `<rect class="plug" x="${p.x - 4.5}" y="${y - 11}" width="9" height="13" rx="3"/>`;
    if (p.kind === "failed") s += `<text class="x" x="${p.x + 9}" y="${y - 10}">✕</text>`;
    s += `</g>`;
  });
  s += `</svg>`;
  el.innerHTML = s;
}

const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
