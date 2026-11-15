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

// ---------- top bar ----------
const bar = document.querySelector(".bar")!;
const onScroll = () => bar.classList.toggle("scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true }); onScroll();

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
  $("benchIntro").textContent = `${b.prompts} realistic prompts in 6 kinds, from one-line questions to four-part builds. Each one is routed by Switchboard and priced against one Claude Opus 5.5 call writing the same amount.`;
  const big = (label: string, value: string, note: string, count?: number, suffix = "") =>
    `<div class="big"><span class="label">${label}</span><b${count !== undefined ? ` data-count="${count}" data-suffix="${suffix}"` : ""}>${value}</b><p>${note}</p></div>`;
  $("benchStats").innerHTML =
    big("Overall, balanced", signed(b.saved), `${money(b.switchboardCost)} vs ${money(b.opusCost)} for all ${b.prompts}`, -Math.round(b.saved * 100), "%") +
    big("Quick questions", signed(quick.saved), "Haiku is 1/40 of Opus per token", -Math.round(quick.saved * 100), "%") +
    big("Cheaper on", `${b.cheaperOn}<small>/${b.prompts}</small>`, "prompts, in balanced mode") +
    big("Tokens used", `${(b.switchboardTokens / b.opusTokens).toFixed(1)}×`, "more than one Opus call. They're cheaper tokens.");

  // dumbbells: Opus = 100 on every row, Switchboard where its cost lands
  const MAX = 125;
  const at = (v: number) => `${(Math.min(v, MAX) / MAX) * 100}%`;
  $("benchCats").innerHTML = b.categories.map((c, i) => {
    const rel = (c.switchboard / c.opus) * 100;
    const over = rel > 100;
    const lo = Math.min(rel, 100), hi = Math.max(rel, 100);
    return `<div class="db" style="--ref:${at(100)};--to:${at(rel)};--lo:${at(lo)};--w:calc(${at(hi)} - ${at(lo)});--delay:${i * 0.09}s">
      <div class="db-name">${esc(c.cat)}<small>${c.prompts} prompts · ${money(c.switchboard)} vs ${money(c.opus)}</small></div>
      <div class="db-track" role="img" aria-label="${esc(c.cat)}: Switchboard ${Math.round(rel)} vs Opus 100">
        <span class="db-bar${over ? " over" : ""}"></span><span class="db-dot o"></span><span class="db-dot s${over ? " over" : ""}"></span>
      </div>
      <div class="db-val ${c.saved >= 0 ? "pos" : "neg"}">${signed(c.saved)}</div>
    </div>`;
  }).join("");

  // mode cards: a half-dial of cost vs Opus, then the model mix
  const names: Record<string, [string, string]> = { save: ["Save money", "Cheapest that passes"], balanced: ["Balanced", "Default"], quality: ["Best quality", "Hard steps to Fable"] };
  const ARC = Math.PI * 44; // half circle, r = 44
  $("benchModes").innerHTML = bench.runs.map((r) => {
    const rel = 1 - r.saved; // cost as a share of Opus
    const len = (Math.min(rel, 1.5) / 1.5) * ARC;
    const mark = (1 / 1.5) * Math.PI; // where 100% sits on the dial
    const mx = 52 - 38 * Math.cos(mark), my = 54 - 38 * Math.sin(mark);
    const mx2 = 52 - 52 * Math.cos(mark), my2 = 54 - 52 * Math.sin(mark);
    return `<article class="mode-card${r.mode === "balanced" ? " pick" : ""}">
      <div class="mode-top"><h4>${names[r.mode][0]}</h4><span class="label${r.mode === "balanced" ? " tagd" : ""}">${names[r.mode][1]}</span></div>
      <div class="gauge">
        <svg viewBox="0 0 104 60" aria-hidden="true">
          <path class="g-bg" d="M8,54 A44,44 0 0 1 96,54"/>
          <path class="g-fg${rel > 1 ? " over" : ""}" d="M8,54 A44,44 0 0 1 96,54" data-len="${len.toFixed(1)}"/>
          <line class="g-mark" x1="${mx.toFixed(1)}" y1="${my.toFixed(1)}" x2="${mx2.toFixed(1)}" y2="${my2.toFixed(1)}"/>
        </svg>
        <div><b class="${r.saved >= 0 ? "pos" : "neg"}">${signed(r.saved)}</b><span>vs Opus · cheaper on ${r.cheaperOn}/${r.prompts}</span></div>
      </div>
      <div class="mix">${LADDER.map((k) => `<i class="${k}" style="--w:${r.modelShare[k] * 100}%" title="${MODELS[k].name} ${pct(r.modelShare[k])}"></i>`).join("")}</div>
      <div class="mixkey">${LADDER.map((k) => `<span><b>${pct(r.modelShare[k])}</b>${MODELS[k].name.split(" ")[0]}</span>`).join("")}</div>
    </article>`;
  }).join("");

  const e = bench.withEscalations;
  $("benchEsc").textContent = `Failed checks eat the savings. If about 1 in 7 checked steps fails and moves up a model (${e.escalations} escalations across the ${e.prompts} prompts), balanced mode lands at ${signed(e.saved)}: break-even. On hard work like debugging, routing barely helps, because those steps go to Opus anyway. Best quality costs more than Opus on purpose.`;
}
renderBench();

// ladder in How it works
const usd = (n: number) => `$${n < 1 ? n.toFixed(2) : n}`;
$("ladder").innerHTML = [...LADDER].reverse().map((k) => {
  const m = MODELS[k];
  return `<div class="rung">${tierBars(k)}<b>${m.name}</b><span class="p">${usd(m.inputPrice)} / ${usd(m.outputPrice)}</span><span class="bl">${m.blurb}</span></div>`;
}).join("") + `<div class="rung foot-rung"><span class="bl">USD per 1M tokens, input / output.</span></div>`;

// ---------- reveals and count-ups ----------
function countUp(el: HTMLElement) {
  const target = Number(el.dataset.count), suffix = el.dataset.suffix ?? "";
  if (!Number.isFinite(target) || reduced) return;
  const start = performance.now(), dur = 1100;
  const fmt = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(Math.round(v))}${suffix}`;
  const step = (t: number) => {
    const p = Math.min(1, (t - start) / dur), eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(target * eased);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function arm(el: Element) {
  el.classList.add("in");
  el.querySelectorAll<SVGPathElement>(".g-fg").forEach((p) => (p.style.strokeDasharray = `${p.dataset.len} 400`));
  el.querySelectorAll<HTMLElement>("[data-count]").forEach(countUp);
}
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { arm(e.target); io.unobserve(e.target); }
}, { threshold: 0.18, rootMargin: "0px 0px -8% 0px" });
document.querySelectorAll(".reveal, .proof").forEach((el) => io.observe(el));
