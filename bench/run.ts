// Routing benchmark: runs Switchboard's free routing over a fixed prompt set and prices the
// whole pipeline (triage, plan, work, checks, compose) against sending each prompt to Opus once.
//
// SIMULATED: no API calls are made. Token counts come from the cost model below, not from
// real responses. Run `npm run bench` to regenerate bench/results.json and the charts in docs/.
import { readFileSync, writeFileSync } from "node:fs";
import { dryRun } from "../src/engine";
import { estimateCost, estimateTokens, LADDER, MODELS, type ModelKey } from "../src/models";
import { pickModel, up, type Mode } from "../src/policy";
import { scoreWithRules } from "../src/rules";

interface Item { cat: string; label: ModelKey | "mixed"; prompt: string }
const items: Item[] = JSON.parse(readFileSync(new URL("./prompts.json", import.meta.url), "utf8"));

// ---- Cost model (assumptions, stated in the README) ----
const SYSTEM = 250;                       // system prompt + step framing, tokens
/** Output length is a property of the work, not of the model, so both sides pay for the same output. */
const outputFor = (difficulty: number) => Math.round(150 + (difficulty - 1) * 700); // 1→150 … 5→2950
const ESCALATION_RATE = 1 / 7;            // scenario: about 1 in 7 checked steps (14%) fails once and moves up
let checkedSteps = 0;

interface Tally { tokensIn: number; tokensOut: number; cost: number; byModel: Record<ModelKey, number> }
const blank = (): Tally => ({ tokensIn: 0, tokensOut: 0, cost: 0, byModel: { haiku: 0, sonnet: 0, opus: 0, fable: 0 } });
function add(t: Tally, model: ModelKey, i: number, o: number) {
  const c = estimateCost(MODELS[model], i, o);
  t.tokensIn += i; t.tokensOut += o; t.cost += c; t.byModel[model] += c;
}

function simulate(prompt: string, mode: Mode, escalate: boolean) {
  const sb = blank(), opus = blank();
  const T = estimateTokens(prompt);
  const triage = scoreWithRules(prompt);
  const d = dryRun(prompt, mode);
  const steps = d.steps;
  const multi = steps.length > 1;
  const workModels: ModelKey[] = [];
  let escalations = 0;

  if (triage.confidence < 0.6) add(sb, "haiku", T + 150, 60);                      // Haiku triage
  if (multi) add(sb, triage.level >= 4 ? "opus" : "sonnet", T + 200, 80 * steps.length); // planner

  let context = 0, totalOut = 0;
  steps.forEach((s, i) => {
    const out = outputFor(s.difficulty);
    let model = s.model;
    add(sb, model, T + SYSTEM + context, out);
    const checked = !(steps.length === 1 && s.difficulty <= 1.5);
    if (checked) add(sb, "haiku", T + out + 200, 60);
    // Deterministic escalation scenario: every Nth checked step fails once.
    if (checked) checkedSteps++;
    if (escalate && checked && up(model) && checkedSteps % Math.round(1 / ESCALATION_RATE) === 0) {
      const next = up(model)!;
      add(sb, next, T + SYSTEM + context + out, out);   // retry with the reviewer's note
      add(sb, "haiku", T + out + 200, 60);              // re-check
      model = next; escalations++;
    }
    workModels.push(model);
    context += out; totalOut += out;
  });
  // Compose: default "stitch" joins step outputs with no model call.

  add(opus, "opus", T + SYSTEM, totalOut);                                           // baseline: one Opus call
  return { sb, opus, steps: steps.length, workModels, escalations, firstModel: steps[0].model, level: triage.level };
}

function run(mode: Mode, escalate: boolean) {
  checkedSteps = 0;
  const rows = items.map((it) => ({ ...it, ...simulate(it.prompt, mode, escalate) }));
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
  const share: Record<ModelKey, number> = { haiku: 0, sonnet: 0, opus: 0, fable: 0 };
  rows.forEach((r) => r.workModels.forEach((m) => share[m]++));
  const totalSteps = sum((r) => r.workModels.length);
  const labelled = rows.filter((r) => r.label !== "mixed");
  const agree = labelled.filter((r) => r.firstModel === r.label).length;
  const cats = [...new Set(items.map((i) => i.cat))].map((cat) => {
    const rs = rows.filter((r) => r.cat === cat);
    const s = rs.reduce((a, r) => a + r.sb.cost, 0), o = rs.reduce((a, r) => a + r.opus.cost, 0);
    return { cat, prompts: rs.length, switchboard: s, opus: o, saved: 1 - s / o };
  });
  const sbCost = sum((r) => r.sb.cost), opCost = sum((r) => r.opus.cost);
  return {
    mode, escalationScenario: escalate,
    prompts: rows.length, steps: totalSteps,
    switchboardCost: sbCost, opusCost: opCost, saved: 1 - sbCost / opCost,
    switchboardTokens: sum((r) => r.sb.tokensIn + r.sb.tokensOut), opusTokens: sum((r) => r.opus.tokensIn + r.opus.tokensOut),
    modelShare: Object.fromEntries(LADDER.map((k) => [k, share[k] / totalSteps])) as Record<ModelKey, number>,
    escalations: sum((r) => r.escalations),
    cheaperOn: rows.filter((r) => r.sb.cost < r.opus.cost).length,
    routingAgreement: { matched: agree, of: labelled.length },
    categories: cats,
  };
}

const modes: Mode[] = ["save", "balanced", "quality"];
const results = {
  generated: new Date().toISOString().slice(0, 10),
  kind: "simulated",
  note: "No API calls. Compose mode: stitch. Routing is Switchboard's free rules; token counts come from the cost model in bench/run.ts. Prices: Claude API list prices per 1M tokens.",
  prices: Object.fromEntries(LADDER.map((k) => [MODELS[k].id, { input: MODELS[k].inputPrice, output: MODELS[k].outputPrice }])),
  runs: modes.map((m) => run(m, false)),
  withEscalations: run("balanced", true),
};
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(results, null, 2) + "\n");

// ---- Charts (SVG, light and dark friendly) ----
const b = results.runs.find((r) => r.mode === "balanced")!;
const COLORS: Record<ModelKey, string> = { haiku: "#10b981", sonnet: "#3b82f6", opus: "#8b5cf6", fable: "#f59e0b" };
const pct = (n: number) => `${Math.round(n * 100)}%`;
const money = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

function costChart() {
  const W = 760, rowH = 46, left = 190, top = 56, maxV = Math.max(...b.categories.map((c) => c.opus));
  const H = top + b.categories.length * rowH + 40;
  const x = (v: number) => (v / maxV) * (W - left - 110);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Inter,Segoe UI,Helvetica,Arial,sans-serif">`;
  s += `<rect width="${W}" height="${H}" rx="14" fill="#0f1218"/>`;
  s += `<text x="24" y="32" fill="#e8ebf2" font-size="17" font-weight="700">Cost per category: Switchboard vs one Opus call</text>`;
  s += `<text x="24" y="${H - 14}" fill="#8b93a7" font-size="11.5">Simulated, balanced mode, ${b.prompts} prompts. Overhead included: triage, planning and checks.</text>`;
  b.categories.forEach((c, i) => {
    const y = top + i * rowH;
    s += `<text x="24" y="${y + 18}" fill="#c9cfdb" font-size="13">${c.cat.replace(/&/g, "&amp;")}</text>`;
    s += `<rect x="${left}" y="${y + 4}" width="${x(c.opus)}" height="13" rx="3" fill="#8b5cf6" opacity="0.35"/>`;
    s += `<rect x="${left}" y="${y + 20}" width="${Math.max(2, x(c.switchboard))}" height="13" rx="3" fill="#10b981"/>`;
    s += `<text x="${left + x(c.opus) + 8}" y="${y + 15}" fill="#8b93a7" font-size="11">${money(c.opus)}</text>`;
    s += `<text x="${left + Math.max(2, x(c.switchboard)) + 8}" y="${y + 31}" fill="#e8ebf2" font-size="11" font-weight="600">${money(c.switchboard)} (${c.saved >= 0 ? "−" : "+"}${pct(Math.abs(c.saved))})</text>`;
  });
  s += `<rect x="${W - 210}" y="20" width="10" height="10" rx="2" fill="#8b5cf6" opacity="0.35"/><text x="${W - 195}" y="29" fill="#8b93a7" font-size="11">All Opus</text>`;
  s += `<rect x="${W - 130}" y="20" width="10" height="10" rx="2" fill="#10b981"/><text x="${W - 115}" y="29" fill="#8b93a7" font-size="11">Switchboard</text>`;
  return s + `</svg>\n`;
}

function shareChart() {
  const W = 760, H = 150, left = 24, barW = W - 48;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Inter,Segoe UI,Helvetica,Arial,sans-serif">`;
  s += `<rect width="${W}" height="${H}" rx="14" fill="#0f1218"/>`;
  s += `<text x="24" y="32" fill="#e8ebf2" font-size="17" font-weight="700">Where the ${b.steps} steps went (balanced mode)</text>`;
  let xo = left;
  LADDER.forEach((k) => {
    const w = b.modelShare[k] * barW;
    if (w <= 0) return;
    s += `<rect x="${xo}" y="52" width="${w}" height="34" fill="${COLORS[k]}"/>`;
    if (w > 70) s += `<text x="${xo + 10}" y="74" fill="#0b0d12" font-size="13" font-weight="700">${MODELS[k].name} ${pct(b.modelShare[k])}</text>`;
    xo += w;
  });
  s += `<text x="24" y="112" fill="#8b93a7" font-size="12">${LADDER.map((k) => `${MODELS[k].name}: ${pct(b.modelShare[k])}`).join("   ·   ")}</text>`;
  s += `<text x="24" y="134" fill="#8b93a7" font-size="11.5">Simulated routing over bench/prompts.json. Agreement with hand labels: ${b.routingAgreement.matched}/${b.routingAgreement.of}.</text>`;
  return s + `</svg>\n`;
}
writeFileSync(new URL("../docs/benchmark-cost.svg", import.meta.url), costChart());
writeFileSync(new URL("../docs/benchmark-share.svg", import.meta.url), shareChart());

for (const r of [...results.runs, results.withEscalations]) {
  console.log(`${r.mode}${r.escalationScenario ? " +escalations" : ""}: ${money(r.switchboardCost)} vs ${money(r.opusCost)} → saved ${pct(r.saved)} | share ${LADDER.map((k) => `${k} ${pct(r.modelShare[k])}`).join(" ")} | esc ${r.escalations} | cheaper on ${r.cheaperOn}/${r.prompts} | agree ${r.routingAgreement.matched}/${r.routingAgreement.of}`);
}
console.table(b.categories.map((c) => ({ cat: c.cat, sb: money(c.switchboard), opus: money(c.opus), saved: pct(c.saved) })));
void pickModel;
