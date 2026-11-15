import "./style.css";
import { DEFAULTS, dryRun, Switchboard, type TraceEvent } from "./engine";
import { LADDER, MODELS, type ModelKey } from "./models";
import type { Mode } from "./policy";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const promptEl = $<HTMLTextAreaElement>("prompt");
const keyEl = $<HTMLInputElement>("apikey");
const rememberEl = $<HTMLInputElement>("remember");
const budgetEl = $<HTMLInputElement>("budget");
let mode: Mode = "balanced";

const EXAMPLES: Record<string, string> = {
  "Quick question": "What's the difference between a process and a thread? Short answer.",
  "Build a feature": "1. Design the database schema for a habit-tracking app with streaks and reminders, and explain the trade-offs\n2. Write the TypeScript API endpoint that marks a habit done and updates the streak, handling time zones and edge cases\n3. Write unit tests for the streak logic\n4. Write a short README section explaining the endpoint",
  "Debug + explain": "My Node worker pool sometimes processes the same job twice under load. Find the likely race condition, fix it, then explain the fix in plain English for a non-technical manager.",
  "Rewrite": "Rewrite this to sound friendlier: 'Your request has been received and will be processed in due course.'",
};

// ---------- setup ----------
try { const k = localStorage.getItem("sb-key"); if (k) { keyEl.value = k; rememberEl.checked = true; } } catch {}
const ex = $("examples");
for (const [label, text] of Object.entries(EXAMPLES)) {
  const b = document.createElement("button");
  b.className = "chip"; b.textContent = label;
  b.onclick = () => { promptEl.value = text; preview(); };
  ex.appendChild(b);
}
promptEl.value = EXAMPLES["Build a feature"];
$("mode").querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
  b.onclick = () => {
    mode = b.dataset.mode as Mode;
    $("mode").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    if (!running) preview();
  };
});
$("ladder").innerHTML = LADDER.map((k) => {
  const m = MODELS[k];
  return `<div class="m" style="border-top-color:var(--${k})"><b>${m.name}</b><span>${m.blurb}</span><span class="price">$${m.inputPrice.toFixed(2)} in · $${m.outputPrice.toFixed(2)} out / 1M tokens</span></div>`;
}).join("");

// ---------- state for the lane diagram ----------
interface Node { model: ModelKey; step: number; kind: "run" | "retry" | "fallback" | "compose"; }
let nodes: Node[] = [];
let switches = 0;
let running = false;

function resetView() {
  nodes = []; switches = 0;
  $("timeline").innerHTML = "";
  $("results").classList.remove("hidden");
  setStats(0, 0);
  $("switches").textContent = "0";
}

function setStats(spent: number, opus: number) {
  $("spent").textContent = money(spent);
  $("opus").textContent = money(opus);
  const saved = opus > 0 ? Math.max(0, 1 - spent / opus) : 0;
  $("saved").textContent = `${Math.round(saved * 100)}%`;
}

function drawLanes() {
  const rows = [...LADDER].reverse(); // Fable on top
  const W = Math.max(640, 120 + nodes.length * 90), rowH = 46, top = 16, left = 96;
  const H = top * 2 + rowH * rows.length + 18;
  const y = (m: ModelKey) => top + rowH * rows.indexOf(m) + rowH / 2;
  const x = (i: number) => left + 30 + i * ((W - left - 60) / Math.max(1, nodes.length - 1 || 1));
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Which model ran each step">`;
  rows.forEach((m) => {
    svg += `<line x1="${left}" x2="${W - 10}" y1="${y(m)}" y2="${y(m)}" stroke="var(--line)" stroke-dasharray="2 6"/>`;
    svg += `<text x="8" y="${y(m) + 4}" class="lane-label" fill="var(--${m})">${MODELS[m].name}</text>`;
  });
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i];
    const dash = b.kind === "retry" ? `stroke-dasharray="5 4"` : b.kind === "fallback" ? `stroke-dasharray="1 4"` : "";
    const color = b.kind === "retry" ? "var(--bad)" : b.kind === "fallback" ? "var(--fable)" : "var(--muted)";
    const x1 = x(i - 1), x2 = x(i), y1 = y(a.model), y2 = y(b.model), mx = (x1 + x2) / 2;
    svg += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="${color}" stroke-width="2" ${dash}/>`;
  }
  let lastStep = -1;
  nodes.forEach((n, i) => {
    svg += `<circle cx="${x(i)}" cy="${y(n.model)}" r="9" fill="var(--${n.model})" stroke="var(--panel)" stroke-width="3"/>`;
    if (n.step !== lastStep) {
      svg += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="step-label">${n.kind === "compose" ? "merge" : `step ${n.step}`}</text>`;
      lastStep = n.step;
    }
  });
  svg += `</svg>`;
  $("lanes").innerHTML = svg;
}

function log(html: string, cls = "") {
  const li = document.createElement("li");
  li.className = cls; li.innerHTML = html;
  $("timeline").appendChild(li);
  li.scrollIntoView({ block: "nearest" });
}

const pill = (m: ModelKey) => `<span class="pill ${m}">${MODELS[m].name}</span>`;
const money = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// ---------- preview (free, no API calls) ----------
function preview() {
  const task = promptEl.value.trim();
  if (!task) return;
  resetView();
  const d = dryRun(task, mode);
  $("routeNote").textContent = "Preview from the free rules. A live run plans with a model and can switch more.";
  log(`<b>Triage</b> (rules): difficulty ${d.triage.level.toFixed(1)}, ${d.triage.kind}<span class="sub">${esc(d.triage.signals.join(" · "))}</span>`);
  let prev: ModelKey | null = null;
  d.steps.forEach((s, i) => {
    nodes.push({ model: s.model, step: i + 1, kind: "run" });
    if (prev && prev !== s.model) switches++;
    const dir = prev && prev !== s.model ? (LADDER.indexOf(s.model) > LADDER.indexOf(prev) ? "up" : "down") : "";
    log(`<b>Step ${i + 1}</b> ${pill(s.model)} ${esc(s.title)}<span class="sub">difficulty ${s.difficulty.toFixed(1)} · est. ${money(s.estCost)}</span>`, dir);
    prev = s.model;
  });
  $("switches").textContent = String(switches);
  setStats(d.total, d.opus);
  $("answer").textContent = "Preview only. Add your API key and press Run live to get the answer.";
  $("answer").classList.add("muted");
  drawLanes();
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
  $("routeNote").textContent = "Live run";
  $("answer").textContent = ""; $("answer").classList.remove("muted");
  let spent = 0, opus = 0, liveStep = -1, buffer = "";

  const onEvent = (e: TraceEvent) => {
    switch (e.type) {
      case "triage":
        log(`<b>Triage</b> (${e.source}): difficulty ${e.level.toFixed(1)}, ${esc(e.kind)}<span class="sub">${esc(e.reasons.join(" · "))}</span>`); break;
      case "plan":
        log(`<b>Plan</b> ${e.source === "model" ? `by ${pill(e.by)}` : ""}: ${e.steps.length} step${e.steps.length > 1 ? "s" : ""}<span class="sub">${e.steps.map((s, i) => `${i + 1}. ${esc(s.title)} (${s.difficulty.toFixed(1)})`).join("<br>")}</span>`); break;
      case "route":
        nodes.push({ model: e.model, step: e.step, kind: "run" }); drawLanes();
        log(`<b>Step ${e.step}</b> → ${pill(e.model)}<span class="sub">${esc(e.reason)}</span>`); break;
      case "switch":
        switches++; $("switches").textContent = String(switches);
        if (e.reason.startsWith("check failed")) { nodes.push({ model: e.to, step: e.step, kind: "retry" }); drawLanes(); }
        log(`<b>Switch ${e.direction === "up" ? "up" : "down"}</b> ${pill(e.from)} → ${pill(e.to)}<span class="sub">${esc(e.reason)}</span>`, e.direction); break;
      case "fallback":
        nodes.push({ model: e.to, step: e.step, kind: "fallback" }); drawLanes();
        log(`<b>Fallback</b> ${pill(e.from)} → ${pill(e.to)}<span class="sub">${esc(e.reason)}</span>`, "bad"); break;
      case "check":
        log(`<b>Check</b> ${e.pass ? "passed" : "failed"} (${e.score.toFixed(2)})${e.issue ? `<span class="sub">${esc(e.issue)}</span>` : ""}`, e.pass ? "" : "bad"); break;
      case "budget":
        log(`<b>Guardrail</b><span class="sub">${esc(e.message)}</span>`); break;
      case "compose":
        nodes.push({ model: e.model, step: e.step, kind: "compose" }); drawLanes(); break;
      case "relax":
        log(`<b>De-escalate</b><span class="sub">${esc(e.message)}</span>`, "down"); break;
      case "call":
        spent += e.cost; opus += (e.inputTokens * MODELS.opus.inputPrice + e.outputTokens * MODELS.opus.outputPrice) / 1e6;
        setStats(spent, opus); break;
      case "output":
        if (e.step !== liveStep) { liveStep = e.step; buffer = ""; }
        buffer += e.delta; $("answer").textContent = buffer; break;
      case "step-done":
        log(`<b>Step ${e.step} done</b> on ${pill(e.model)}${e.attempts > 1 ? ` after ${e.attempts} attempts` : ""}`); break;
      case "final":
        $("answer").textContent = e.text;
        setStats(e.totalCost, e.opusCost);
        log(`<b>Done</b>: ${e.calls} API calls, ${money(e.totalCost)} vs ${money(e.opusCost)} at Opus prices`); break;
      case "error":
        log(`<b>Error</b><span class="sub">${esc(e.message)}</span>`, "bad"); break;
    }
  };

  try {
    const { AnthropicLLM } = await import("./anthropic");
    const budget = Math.max(0.01, Number(budgetEl.value) || DEFAULTS.budgetUsd);
    await new Switchboard(new AnthropicLLM(key), { ...DEFAULTS, mode, budgetUsd: budget, onEvent }).run(task);
  } catch {
    /* already shown in the timeline */
  } finally {
    running = false;
    setBusy(false);
  }
}

function setBusy(b: boolean) {
  ($("runlive") as HTMLButtonElement).disabled = b;
  ($("preview") as HTMLButtonElement).disabled = b;
  $("runlive").textContent = b ? "Running…" : "Run live";
}

$("preview").onclick = preview;
$("runlive").onclick = runLive;
$("copy").onclick = () => navigator.clipboard?.writeText($("answer").textContent ?? "");
preview();
