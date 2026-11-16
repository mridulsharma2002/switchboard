import "./style.css";
import { DEFAULTS, dryRun, Switchboard, type TraceEvent } from "./engine";
import { LADDER, MODELS, type ModelKey } from "./models";
import type { Mode } from "./policy";
import { chip, renderBoard, tierBars, type Cord } from "./board";
import bench from "../bench/results.json";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const money = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`;
const pct = (n: number) => `${Math.round(Math.abs(n) * 100)}%`;
const signed = (saved: number) => `${saved >= 0 ? "−" : "+"}${pct(saved)}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// ---------- hero: a scripted run on loop ----------
const HERO_STEPS = ["Design the schema", "Write the endpoint", "Unit tests", "README section"];
type Beat = { cord?: Cord; fail?: boolean; line: string; cls?: string; status: string; wait: number };
const HERO: Beat[] = [
  { line: "<b>triage</b> rules: difficulty 4.1, multi-step build", status: "Triage", wait: 900 },
  { line: "<b>plan</b> 4 steps, by Opus 5.5", status: "Planning", wait: 900 },
  { cord: { step: 1, model: "opus", kind: "run" }, line: "<b>01 → Opus</b> schema design is hard (4.4)", status: "Patching step 1", wait: 1500 },
  { line: "<b>check</b> passed 0.91", cls: "good", status: "Checking step 1", wait: 800 },
  { cord: { step: 2, model: "sonnet", kind: "run" }, line: "<b>02 → Sonnet</b> ordinary code (2.9)", status: "Patching step 2", wait: 1500 },
  { fail: true, line: "<b>check failed</b> 0.52: time zones not handled", cls: "bad", status: "Check failed", wait: 1100 },
  { cord: { step: 2, model: "opus", kind: "retry" }, line: "<b>re-patch ↑ Opus</b> retry with the reviewer's note", status: "Re-patching step 2", wait: 1500 },
  { line: "<b>check</b> passed 0.88", cls: "good", status: "Checking step 2", wait: 800 },
  { cord: { step: 3, model: "opus", kind: "run" }, line: "<b>03 → Opus</b> code steps start higher now", status: "Patching step 3", wait: 1500 },
  { line: "<b>relax</b> two clean passes, floor lifted", cls: "good", status: "De-escalating", wait: 900 },
  { cord: { step: 4, model: "haiku", kind: "run" }, line: "<b>04 ↓ Haiku</b> a README is easy (1.4)", status: "Patching step 4", wait: 1500 },
  { line: "<b>done</b> 4 steps, 1 re-patch, stitched into one answer", cls: "good", status: "Done", wait: 3600 },
];

function hero() {
  const el = $("heroBoard"), ticker = $("heroTicker"), status = $("heroStatus");
  const finalCords = (): Cord[] => {
    const c: Cord[] = [];
    for (const b of HERO) { if (b.fail) c[c.length - 1] = { ...c[c.length - 1], kind: "failed" }; if (b.cord) c.push(b.cord); }
    return c;
  };
  if (reduced) {
    renderBoard(el, finalCords(), { steps: HERO_STEPS });
    status.textContent = "4 steps · 1 re-patch";
    ticker.innerHTML = HERO.slice(-3).map((b) => `<li class="${b.cls ?? ""}">${b.line}</li>`).join("");
    return;
  }
  let i = 0, cords: Cord[] = [], visible = true;
  const tick = () => {
    if (!visible) { setTimeout(tick, 500); return; }
    if (i === 0) { cords = []; ticker.innerHTML = ""; renderBoard(el, cords, { steps: HERO_STEPS }); }
    const b = HERO[i];
    let from: number | undefined;
    if (b.fail) cords[cords.length - 1] = { ...cords[cords.length - 1], kind: "failed" };
    if (b.cord) { cords.push(b.cord); from = cords.length - 1; }
    if (b.cord || b.fail) renderBoard(el, cords, { steps: HERO_STEPS, animateFrom: from ?? cords.length });
    const li = document.createElement("li");
    li.className = b.cls ?? ""; li.innerHTML = b.line;
    ticker.appendChild(li);
    while (ticker.children.length > 3) ticker.firstElementChild!.remove();
    status.textContent = b.status;
    i = (i + 1) % HERO.length;
    setTimeout(tick, b.wait);
  };
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(el);
  tick();
  let w = el.clientWidth;
  addEventListener("resize", () => { if (Math.abs(el.clientWidth - w) > 40) { w = el.clientWidth; renderBoard(el, cords, { steps: HERO_STEPS }); } });
}
hero();

// ---------- try it ----------
const promptEl = $<HTMLTextAreaElement>("prompt");
const keyEl = $<HTMLInputElement>("apikey");
const rememberEl = $<HTMLInputElement>("remember");
const budgetEl = $<HTMLInputElement>("budget");
let mode: Mode = "balanced";
let running = false;

const EXAMPLES: Record<string, string> = {
  "Build a feature": "1. Design the database schema for a habit-tracking app with streaks and reminders, and explain the trade-offs\n2. Write the TypeScript API endpoint that marks a habit done and updates the streak, handling time zones and edge cases\n3. Write unit tests for the streak logic\n4. Write a short README section explaining the endpoint",
  "Quick question": "What's the difference between a process and a thread? Short answer.",
  "Debug + explain": "My Node worker pool sometimes processes the same job twice under load. Find the likely race condition, fix it, then explain the fix in plain English for a non-technical manager.",
  "Rewrite": "Rewrite this to sound friendlier: 'Your request has been received and will be processed in due course.'",
};

try { const k = localStorage.getItem("sb-key"); if (k) { keyEl.value = k; rememberEl.checked = true; } } catch {}
const ex = $("examples");
const chips: HTMLButtonElement[] = [];
for (const [label, text] of Object.entries(EXAMPLES)) {
  const b = document.createElement("button");
  b.className = "chip"; b.textContent = label; b.type = "button";
  b.onclick = () => { promptEl.value = text; markChip(); if (!running) preview(true); };
  ex.appendChild(b); chips.push(b);
}
const markChip = () => chips.forEach((c) => c.classList.toggle("on", EXAMPLES[c.textContent!] === promptEl.value));
promptEl.value = EXAMPLES["Build a feature"];
promptEl.addEventListener("input", markChip);
markChip();

const seg = $("mode");
const segButtons = [...seg.querySelectorAll<HTMLButtonElement>("button")];
const thumb = seg.querySelector<HTMLElement>(".seg-thumb")!;
const placeThumb = () => { const i = segButtons.findIndex((b) => b.dataset.mode === mode); thumb.style.transform = `translateX(${i * 100}%)`; };
segButtons.forEach((b) => {
  b.onclick = () => {
    mode = b.dataset.mode as Mode;
    segButtons.forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
    placeThumb();
    if (!running) preview(true);
  };
});
placeThumb();

// run view state
let cords: Cord[] = [];
let stepTitles: string[] = [];
let switches = 0;
let t0 = 0;

function drawBoard(animateNew = true) {
  renderBoard($("board"), cords, { steps: stepTitles, animateFrom: animateNew && !reduced ? cords.length - 1 : undefined });
}

function resetView() {
  cords = []; stepTitles = []; switches = 0; t0 = performance.now();
  $("timeline").innerHTML = "";
  setStats(0, 0);
  $("switches").textContent = "0";
}

function setStats(spent: number, opus: number) {
  $("spent").textContent = money(spent);
  $("opus").textContent = money(opus);
  const saved = opus > 0 ? 1 - spent / opus : 0;
  const el = $("saved");
  el.textContent = opus > 0 ? signed(saved) : "0%";
  el.classList.toggle("good", opus > 0 && saved >= 0);
  el.classList.toggle("bad", opus > 0 && saved < 0);
}

function log(html: string, cls = "") {
  const li = document.createElement("li");
  li.className = cls; li.innerHTML = `<div>${html}</div>`;
  li.dataset.t = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  const tl = $("timeline");
  tl.appendChild(li);
  tl.scrollTop = tl.scrollHeight; // scroll inside the log only, never the page
}

// ---------- preview (free, no API calls) ----------
function preview(animate = false) {
  const task = promptEl.value.trim();
  if (!task) return;
  resetView();
  const d = dryRun(task, mode);
  $("routeNote").textContent = "Preview · free rules";
  $("runDot").className = "dot";
  log(`<b>triage</b> rules: difficulty ${d.triage.level.toFixed(1)}, ${esc(d.triage.kind)}<span class="sub">${esc(d.triage.signals.join(" · "))}</span>`);
  let prev: ModelKey | null = null;
  stepTitles = d.steps.map((s) => s.title);
  d.steps.forEach((s, i) => {
    cords.push({ step: i + 1, model: s.model, kind: "run" });
    if (prev && prev !== s.model) switches++;
    const dir = prev && prev !== s.model ? (LADDER.indexOf(s.model) > LADDER.indexOf(prev) ? "up" : "down") : "";
    log(`<b>${String(i + 1).padStart(2, "0")} → ${MODELS[s.model].name}</b> ${esc(s.title)}<span class="sub">difficulty ${s.difficulty.toFixed(1)} · est. ${money(s.estCost)}</span>`, dir);
    prev = s.model;
  });
  $("switches").textContent = String(switches);
  setStats(d.total, d.opus);
  $("spentLabel").textContent = "Estimated cost";
  $("answer").textContent = "Preview only. Add your API key and press Run live to get the answer.";
  $("answer").classList.add("muted");
  renderBoard($("board"), cords, { steps: stepTitles, animateFrom: animate && !reduced ? 0 : undefined });
}

// ---------- live run ----------
async function runLive() {
  const task = promptEl.value.trim();
  const key = keyEl.value.trim();
  if (!task) return;
  if (!key) { ($("keybox") as HTMLDetailsElement).open = true; keyEl.focus(); return; }
  try { rememberEl.checked ? localStorage.setItem("sb-key", key) : localStorage.removeItem("sb-key"); } catch {}

  running = true;
  setBusy(true);
  resetView();
  drawBoard(false);
  $("routeNote").textContent = "Live run";
  $("runDot").className = "dot live";
  $("spentLabel").textContent = "Spent";
  $("answer").textContent = ""; $("answer").classList.remove("muted");
  let spent = 0, opus = 0, liveStep = -1, buffer = "";
  const lastOf = (step: number) => { for (let k = cords.length - 1; k >= 0; k--) if (cords[k].step === step) return k; return -1; };

  const onEvent = (e: TraceEvent) => {
    switch (e.type) {
      case "triage":
        log(`<b>triage</b> ${e.source}: difficulty ${e.level.toFixed(1)}, ${esc(e.kind)}<span class="sub">${esc(e.reasons.join(" · "))}</span>`); break;
      case "plan":
        stepTitles = e.steps.map((s) => s.title); drawBoard(false);
        log(`<b>plan</b> ${e.steps.length} step${e.steps.length > 1 ? "s" : ""}${e.source === "model" ? ` by ${chip(e.by)}` : ""}<span class="sub">${e.steps.map((s, i) => `${i + 1}. ${esc(s.title)} (${s.difficulty.toFixed(1)})`).join("<br>")}</span>`); break;
      case "route":
        cords.push({ step: e.step, model: e.model, kind: "run" }); drawBoard();
        log(`<b>${String(e.step).padStart(2, "0")} →</b> ${chip(e.model)}<span class="sub">${esc(e.reason)}</span>`); break;
      case "switch":
        switches++; $("switches").textContent = String(switches);
        if (e.reason.startsWith("check failed")) {
          const k = lastOf(e.step); if (k >= 0) cords[k] = { ...cords[k], kind: "failed" };
          cords.push({ step: e.step, model: e.to, kind: "retry" }); drawBoard();
        }
        log(`<b>re-patch ${e.direction === "up" ? "↑" : "↓"}</b> ${chip(e.from)} → ${chip(e.to)}<span class="sub">${esc(e.reason)}</span>`, e.direction); break;
      case "fallback": {
        const k = lastOf(e.step); if (k >= 0) cords[k] = { ...cords[k], kind: "failed" };
        cords.push({ step: e.step, model: e.to, kind: "fallback" }); drawBoard();
        log(`<b>fallback</b> ${chip(e.from)} → ${chip(e.to)}<span class="sub">${esc(e.reason)}</span>`, "bad"); break;
      }
      case "check":
        log(`<b>check ${e.pass ? "passed" : "failed"}</b> ${e.score.toFixed(2)}${e.issue ? `<span class="sub">${esc(e.issue)}</span>` : ""}`, e.pass ? "good" : "bad"); break;
      case "budget":
        log(`<b>guardrail</b><span class="sub">${esc(e.message)}</span>`, "bad"); break;
      case "compose":
        log(`<b>compose</b> ${chip(e.model)} merges the steps`); break;
      case "relax":
        log(`<b>relax</b><span class="sub">${esc(e.message)}</span>`, "down"); break;
      case "call":
        spent += e.cost; opus += (e.inputTokens * MODELS.opus.inputPrice + e.outputTokens * MODELS.opus.outputPrice) / 1e6;
        setStats(spent, opus); break;
      case "output":
        if (e.step !== liveStep) { liveStep = e.step; buffer = ""; }
        buffer += e.delta; $("answer").textContent = buffer; break;
      case "step-done":
        log(`<b>${String(e.step).padStart(2, "0")} done</b> on ${chip(e.model)}${e.attempts > 1 ? ` after ${e.attempts} attempts` : ""}`); break;
      case "final":
        $("answer").textContent = e.text;
        setStats(e.totalCost, e.opusCost);
        log(`<b>done</b> ${e.calls} API calls · ${money(e.totalCost)} vs about ${money(e.opusCost)} for one Opus call`, "good"); break;
      case "error":
        log(`<b>error</b><span class="sub">${esc(e.message)}</span>`, "bad"); break;
    }
  };

  try {
    const { AnthropicLLM } = await import("./anthropic");
    const budget = Math.max(0.01, Number(budgetEl.value) || DEFAULTS.budgetUsd);
    await new Switchboard(new AnthropicLLM(key), { ...DEFAULTS, mode, budgetUsd: budget, onEvent }).run(task);
  } catch {
    /* already shown in the log */
  } finally {
    running = false;
    setBusy(false);
    $("runDot").className = "dot";
  }
}

function setBusy(b: boolean) {
  ($("runlive") as HTMLButtonElement).disabled = b;
  ($("preview") as HTMLButtonElement).disabled = b;
  $("runlive").textContent = b ? "Running…" : "Run live";
}

$("preview").onclick = () => preview(true);
$("runlive").onclick = runLive;
$("copy").onclick = () => {
  navigator.clipboard?.writeText($("answer").textContent ?? "");
  const b = $("copy"); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1400);
};
preview();
let bw = $("board").clientWidth;
addEventListener("resize", () => { const w = $("board").clientWidth; if (Math.abs(w - bw) > 40) { bw = w; drawBoard(false); } });

// ---------- benchmark (bench/results.json, made by `npm run bench`) ----------
function renderBench() {
  const b = bench.runs.find((r) => r.mode === "balanced")!;
  const quick = b.categories.find((c) => c.cat.startsWith("Quick"))!;
  const debug = b.categories.find((c) => c.cat.startsWith("Debug"))!;
  $("benchIntro").textContent = `I ran ${b.prompts} realistic prompts through it, from one-line questions to four-part builds, and priced each one against a single Claude Opus 5.5 call doing the same work. In balanced mode:`;
  const row = (l: string, sub: string, v: string, cls = "") => `<div class="row"><span class="l">${l}<small>${sub}</small></span><span class="v ${cls}">${v}</span></div>`;
  $("benchStats").innerHTML =
    row("Overall", `${money(b.switchboardCost)} vs ${money(b.opusCost)} for all ${b.prompts} prompts`, signed(b.saved), "pos") +
    row("Quick questions", "They go to Haiku, at 1/40 of Opus's price", signed(quick.saved), "pos") +
    row("Debugging", "Hard steps go to Opus anyway, plus the checks", signed(debug.saved), "neg") +
    row("Cheaper than Opus", "Prompts where Switchboard cost less", `${b.cheaperOn} of ${b.prompts}`) +
    row("Tokens used", "More tokens than one Opus call, but cheaper ones", `${(b.switchboardTokens / b.opusTokens).toFixed(1)}×`);

  // dumbbells: Opus = 100 on every row, Switchboard where its cost lands
  const MAX = 120;
  const at = (v: number) => `${(Math.min(v, MAX) / MAX) * 100}%`;
  $("benchCats").innerHTML = b.categories.map((c, i) => {
    const rel = (c.switchboard / c.opus) * 100;
    const over = rel > 100;
    const lo = Math.min(rel, 100), hi = Math.max(rel, 100);
    return `<div class="db" style="--ref:${at(100)};--to:${at(rel)};--lo:${at(lo)};--w:calc(${at(hi)} - ${at(lo)});--delay:${i * 0.08}s">
      <div class="db-name">${esc(c.cat)}<small>${c.prompts} prompts</small></div>
      <div class="db-val ${c.saved >= 0 ? "pos" : "neg"}">${signed(c.saved)}</div>
      <div class="db-track" role="img" aria-label="${esc(c.cat)}: Switchboard ${Math.round(rel)}, one Opus call 100">
        <span class="db-bar${over ? " over" : ""}"></span><span class="db-dot o"></span><span class="db-dot s${over ? " over" : ""}"></span>
      </div>
    </div>`;
  }).join("");
  document.querySelector(".axis")!.innerHTML = [0, 25, 50, 75, 100].map((v) => `<span style="left:${at(v)}">${v}</span>`).join("");

  const names: Record<string, [string, string]> = { save: ["Save money", ""], balanced: ["Balanced", "default"], quality: ["Best quality", "hard steps go to Fable"] };
  $("benchModes").innerHTML = bench.runs.map((r) => `<div class="mode">
      <div class="row"><span class="l"><b>${names[r.mode][0]}</b>${names[r.mode][1] ? `<span class="tag">${names[r.mode][1]}</span>` : ""}<small>Cheaper on ${r.cheaperOn} of ${r.prompts} · ${LADDER.map((k) => `${MODELS[k].name.split(" ")[0]} ${pct(r.modelShare[k])}`).join(", ")}</small></span><span class="v ${r.saved >= 0 ? "pos" : "neg"}">${signed(r.saved)}</span></div>
      <div class="mix" aria-hidden="true">${LADDER.map((k) => `<i class="${k}" style="--w:${r.modelShare[k] * 100}%"></i>`).join("")}</div>
    </div>`).join("");

  const e = bench.withEscalations;
  $("benchEsc").textContent = `The catch: failed checks eat the savings. If about 1 in 7 checked steps fails and moves up a model (${e.escalations} escalations across the ${e.prompts} prompts), balanced mode comes out at ${signed(e.saved)}, which is break-even. Switchboard pays off when a task mixes hard and easy parts. For one hard question, just ask Opus.`;
}
renderBench();

// the models, in How it works
const usd = (n: number) => `$${n < 1 ? n.toFixed(2) : n}`;
$("ladder").innerHTML = [...LADDER].reverse().map((k) => {
  const m = MODELS[k];
  return `<div class="rung">${tierBars(k)}<b>${m.name}</b><span class="p">${usd(m.inputPrice)} / ${usd(m.outputPrice)}</span><span class="bl">${m.blurb}</span></div>`;
}).join("");

// ---------- animate the charts when they scroll into view ----------
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
}, { threshold: 0.2 });
document.querySelectorAll("#benchCats, #benchModes").forEach((el) => (reduced ? el.classList.add("in") : io.observe(el)));
