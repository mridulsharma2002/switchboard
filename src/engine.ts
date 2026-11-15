import { z } from "zod";
import { estimateCost, estimateTokens, fallbackChain, MODELS, type ModelKey } from "./models";
import { isRetryable, type CompleteResult, type LLM } from "./llm";
import { atLeast, name, pickModel, rung, up, type Mode } from "./policy";
import { scoreWithRules, type TaskKind } from "./rules";

// ---------- Trace events (what the UI draws as the timeline) ----------
export type TraceEvent =
  | { type: "triage"; level: number; kind: string; source: "rules" | "haiku"; reasons: string[] }
  | { type: "plan"; steps: Step[]; by: ModelKey; source: "model" | "rules" }
  | { type: "route"; step: number; model: ModelKey; reason: string }
  | { type: "switch"; step: number; from: ModelKey; to: ModelKey; direction: "up" | "down"; reason: string }
  | { type: "output"; step: number; model: ModelKey; delta: string }
  | { type: "call"; step: number; model: ModelKey; role: CallRole; cost: number; inputTokens: number; outputTokens: number }
  | { type: "check"; step: number; pass: boolean; score: number; issue: string }
  | { type: "fallback"; step: number; from: ModelKey; to: ModelKey; reason: string }
  | { type: "budget"; step: number; message: string }
  | { type: "relax"; step: number; message: string }
  | { type: "compose"; step: number; model: ModelKey }
  | { type: "step-done"; step: number; model: ModelKey; attempts: number; output: string }
  | { type: "final"; text: string; totalCost: number; opusCost: number; calls: number }
  | { type: "error"; message: string };

export type CallRole = "triage" | "plan" | "work" | "check" | "compose";

export interface Step { title: string; instruction: string; difficulty: number; kind: string }

export interface RunOptions {
  mode: Mode;
  budgetUsd: number;          // hard cap for the whole run
  maxEscalations: number;     // per step
  checkThreshold: number;     // checker score needed to pass (0..1)
  compose: "stitch" | "merge"; // stitch = join step outputs (free); merge = Sonnet rewrites them
  onEvent: (e: TraceEvent) => void;
}

export const DEFAULTS: Omit<RunOptions, "onEvent"> = { mode: "balanced", budgetUsd: 0.5, maxEscalations: 2, checkThreshold: 0.7, compose: "stitch" };

// ---------- Schemas for the structured calls ----------
const TriageSchema = z.object({
  difficulty: z.number().describe("1 = trivial lookup or chit-chat, 3 = ordinary professional task, 5 = expert multi-step reasoning"),
  kind: z.enum(["chat", "rewrite", "code", "debug", "architecture", "analysis", "math", "creative", "agentic"]),
  multi_step: z.boolean().describe("true if doing this well needs several distinct steps"),
  reason: z.string().describe("one short sentence"),
});

const PlanSchema = z.object({
  steps: z.array(z.object({
    title: z.string().describe("3-6 words"),
    instruction: z.string().describe("what to produce in this step, self-contained"),
    difficulty: z.number().describe("1-5, rated for THIS step alone"),
    kind: z.string(),
  })).describe("2 to 5 steps, in order"),
});

const CheckSchema = z.object({
  pass: z.boolean(),
  score: z.number().describe("0 to 1: how fully and correctly the output does the step"),
  issue: z.string().describe("the main problem, or empty if none"),
});

// ---------- The engine ----------
export class Switchboard {
  private spent = 0;
  private workOutputTokens = 0;
  private calls = 0;

  constructor(private llm: LLM, private opts: RunOptions) {}

  private emit(e: TraceEvent) { this.opts.onEvent(e); }

  private track(step: number, model: ModelKey, role: CallRole, inputTokens: number, outputTokens: number) {
    const cost = estimateCost(MODELS[model], inputTokens, outputTokens);
    this.spent += cost;
    this.calls++;
    this.emit({ type: "call", step, model, role, cost, inputTokens, outputTokens });
  }

  private canAfford(model: ModelKey, prompt: string) {
    const projected = estimateCost(MODELS[model], estimateTokens(prompt) + 400);
    return this.spent + projected <= this.opts.budgetUsd;
  }

  async run(task: string): Promise<string> {
    try {
      // 1. Triage the whole task: free rules first, Haiku only when the rules are unsure.
      const rules = scoreWithRules(task);
      let level = rules.level;
      let kind: string = rules.kind;
      let multiStep = /\n\s*(\d+[.)]|[-*])\s+/.test(task) || rules.level >= 3;
      if (rules.confidence < 0.6) {
        const t = await this.llm.structured({
          model: MODELS.haiku,
          system: "You triage prompts for a model router. Rate how hard the task is for a language model, not for a human.",
          prompt: `Prompt to triage:\n<prompt>\n${task}\n</prompt>`,
          schema: TriageSchema,
        });
        this.track(0, "haiku", "triage", t.inputTokens, t.outputTokens);
        level = clamp(t.data.difficulty);
        kind = t.data.kind;
        multiStep = t.data.multi_step;
        this.emit({ type: "triage", level, kind, source: "haiku", reasons: [t.data.reason, ...rules.signals.map((s) => `rules: ${s}`)] });
      } else {
        this.emit({ type: "triage", level, kind, source: "rules", reasons: rules.signals });
      }

      // 2. Plan. Simple tasks are a single step; bigger ones get split by a planner.
      let steps: Step[];
      if (!multiStep || level < 2.5) {
        steps = [{ title: "Answer", instruction: task, difficulty: level, kind }];
        this.emit({ type: "plan", steps, by: pickModel(level, this.opts.mode), source: "rules" });
      } else {
        const planner: ModelKey = level >= 4 ? "opus" : "sonnet";
        const p = await this.llm.structured({
          model: MODELS[planner],
          system: "You split a task into 2-5 ordered steps for a pipeline where each step may run on a different model. Rate each step's difficulty on its own: formatting, summarising and boilerplate are 1-2; ordinary code or writing is 3; subtle reasoning, design decisions and tricky debugging are 4-5. The last step should produce the final deliverable.",
          prompt: `Task:\n<task>\n${task}\n</task>`,
          schema: PlanSchema,
        });
        this.track(0, planner, "plan", p.inputTokens, p.outputTokens);
        steps = p.data.steps.slice(0, 5).map((s) => ({ ...s, difficulty: clamp(s.difficulty) }));
        if (steps.length === 0) steps = [{ title: "Answer", instruction: task, difficulty: level, kind }];
        this.emit({ type: "plan", steps, by: planner, source: "model" });
      }

      // 3. Work through the steps, switching models as we go.
      const outputs: string[] = [];
      let prev: ModelKey | null = null;
      // When a kind of step needed escalation, later steps of that kind start higher...
      const floors = new Map<string, ModelKey>();
      // ...until enough steps pass first time to earn the cheaper models back.
      let cleanStreak = 0;

      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const n = i + 1;
        let model = pickModel(s.difficulty, this.opts.mode);
        let reason = `difficulty ${s.difficulty.toFixed(1)} (${s.kind}) → ${name(model)}`;
        const floor = floors.get(s.kind);
        if (floor && rung(floor) > rung(model)) {
          model = atLeast(model, floor);
          reason = `earlier ${s.kind} step needed escalation, so starting at ${name(model)}`;
        }
        this.emit({ type: "route", step: n, model, reason });
        if (prev && prev !== model) {
          this.emit({
            type: "switch", step: n, from: prev, to: model,
            direction: rung(model) > rung(prev) ? "up" : "down",
            reason: rung(model) > rung(prev) ? "this step is harder" : "this step is simpler, so use a cheaper model",
          });
        }

        const context = outputs.map((o, j) => `<step_${j + 1} title="${steps[j].title}">\n${truncate(o, 6000)}\n</step_${j + 1}>`).join("\n");
        let feedback = "";
        let attempts = 0;
        let output = "";
        let lastOut = 0;

        while (true) {
          attempts++;
          const prompt = [
            `Overall task:\n<task>\n${task}\n</task>`,
            context && `Work done so far:\n${context}`,
            `Your step (${n} of ${steps.length}): ${s.title}\n${s.instruction}`,
            feedback && `A reviewer rejected your previous attempt: ${feedback}\nFix that.\nPrevious attempt:\n<attempt>\n${truncate(output, 4000)}\n</attempt>`,
          ].filter(Boolean).join("\n\n");

          const res = await this.callWithFallback(n, model, prompt, steps.length === 1);
          model = res.model;
          output = res.text;
          lastOut = res.outputTokens;

          // 4. Check the step with Haiku. Skip on trivial single steps.
          if (steps.length === 1 && s.difficulty <= 1.5) break;
          const c = await this.llm.structured({
            model: MODELS.haiku,
            system: "You review one step of a multi-step task. Be strict about correctness and completeness for what the step asked, and lenient about style.",
            prompt: `Overall task:\n<task>\n${truncate(task, 3000)}\n</task>\n\nStep: ${s.title}\n${s.instruction}\n\nOutput to review:\n<output>\n${truncate(output, 8000)}\n</output>`,
            schema: CheckSchema,
          });
          this.track(n, "haiku", "check", c.inputTokens, c.outputTokens);
          const pass = c.data.pass && c.data.score >= this.opts.checkThreshold;
          this.emit({ type: "check", step: n, pass, score: c.data.score, issue: c.data.issue });
          if (pass) break;

          // 5. Failed: escalate one rung, if allowed and affordable.
          const next = up(model);
          if (!next || attempts > this.opts.maxEscalations) {
            this.emit({ type: "budget", step: n, message: next ? "escalation limit reached, keeping best attempt" : "already on the top model, keeping best attempt" });
            break;
          }
          if (!this.canAfford(next, prompt)) {
            this.emit({ type: "budget", step: n, message: `budget $${this.opts.budgetUsd.toFixed(2)} would be exceeded, not escalating` });
            break;
          }
          this.emit({ type: "switch", step: n, from: model, to: next, direction: "up", reason: `check failed (${c.data.score.toFixed(2)}): ${c.data.issue}` });
          floors.set(s.kind, next);
          cleanStreak = 0; // an escalated step resets the streak
          feedback = c.data.issue;
          model = next;
        }

        if (attempts === 1) cleanStreak++;
        if (cleanStreak >= 2 && floors.size > 0) {
          floors.clear();
          cleanStreak = 0;
          this.emit({ type: "relax", step: n, message: "two clean passes in a row, so later steps can use cheaper models again" });
        }
        outputs.push(output);
        this.workOutputTokens += lastOut;
        prev = model;
        this.emit({ type: "step-done", step: n, model, attempts, output });
      }

      // 6. Compose. One step: its output is the answer. Several: stitch them together for
      //    free by default, or (compose: "merge") have Sonnet rewrite them into one answer.
      let final = outputs[outputs.length - 1] ?? "";
      if (steps.length > 1) {
        final = outputs.map((o, j) => `## ${steps[j].title}\n\n${o.trim()}`).join("\n\n");
        if (this.opts.compose === "merge") {
          const composer: ModelKey = "sonnet";
          this.emit({ type: "compose", step: steps.length + 1, model: composer });
          if (prev && prev !== composer) {
            this.emit({ type: "switch", step: steps.length + 1, from: prev, to: composer, direction: rung(composer) > rung(prev) ? "up" : "down", reason: "Sonnet merges the finished steps into one answer" });
          }
          const prompt = `Overall task:\n<task>\n${task}\n</task>\n\nFinished steps:\n${outputs.map((o, j) => `<step_${j + 1} title="${steps[j].title}">\n${truncate(o, 8000)}\n</step_${j + 1}>`).join("\n")}\n\nWrite the final answer for the user. Keep every correct detail from the steps, remove repetition, and do not mention the steps or the pipeline.`;
          const res = await this.callWithFallback(steps.length + 1, composer, prompt, true, "compose");
          final = res.text;
        }
      }

      // Baseline: what one Opus call writing the same answer would cost.
      const baseline = estimateCost(MODELS.opus, estimateTokens(task) + 250, this.workOutputTokens);
      this.emit({ type: "final", text: final, totalCost: this.spent, opusCost: baseline, calls: this.calls });
      return final;
    } catch (err) {
      this.emit({ type: "error", message: (err as Error).message ?? String(err) });
      throw err;
    }
  }

  /** Call a model; if it is overloaded, erroring or refuses, walk the fallback chain. */
  private async callWithFallback(step: number, start: ModelKey, prompt: string, stream: boolean, role: CallRole = "work"): Promise<CompleteResult & { model: ModelKey }> {
    const chain = fallbackChain(start);
    let lastErr: unknown;
    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      if (i > 0) this.emit({ type: "fallback", step, from: chain[i - 1], to: model, reason: describe(lastErr) });
      try {
        const res = await this.llm.complete({
          model: MODELS[model],
          system: "You are one stage of a multi-model pipeline. Do exactly the step you are given, thoroughly and concisely. Use Markdown.",
          prompt,
          maxTokens: 16000,
          onText: stream || role === "work" ? (d) => this.emit({ type: "output", step, model, delta: d }) : undefined,
        });
        this.track(step, model, role, res.inputTokens, res.outputTokens);
        if (res.refused) { lastErr = new Error("model declined the request"); continue; }
        return { ...res, model };
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("every model in the fallback chain failed");
  }
}

// ---------- Dry run: what the router WOULD do, with no API calls ----------
export interface DryStep extends Step { model: ModelKey; estCost: number }
export function dryRun(task: string, mode: Mode) {
  const triage = scoreWithRules(task);
  const parts = splitTask(task);
  const steps: DryStep[] = (parts.length > 1 ? parts : [task]).map((p, i) => {
    const r = scoreWithRules(p);
    const difficulty = parts.length > 1 ? r.level : triage.level;
    const model = pickModel(difficulty, mode);
    const est = estimateCost(MODELS[model], estimateTokens(task) + 300 * i);
    return { title: firstWords(p), instruction: p, difficulty, kind: r.kind as TaskKind, model, estCost: est };
  });
  const total = steps.reduce((a, s) => a + s.estCost, 0);
  const opus = steps.reduce((a, s, i) => a + estimateCost(MODELS.opus, estimateTokens(task) + 300 * i, MODELS[s.model].typicalOutputTokens), 0);
  return { triage, steps, total, opus };
}

function splitTask(task: string): string[] {
  const items = ("\n" + task).split(/\n\s*(?:\d+[.)]|[-*])\s+/).map((s) => s.trim()).filter(Boolean);
  if (items.length >= 2) return items.slice(0, 6);
  if (task.includes("```")) return [task];
  const thens = task.split(/(?:,|\s)(?:and then|then|after that|finally)\s/i).map((s) => s.trim().replace(/^[,;]\s*/, "")).filter((s) => s.length > 12);
  return thens.length >= 2 ? thens.slice(0, 6) : [task];
}

const clamp = (n: number) => Math.min(5, Math.max(1, Number.isFinite(n) ? n : 3));
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…[truncated]" : s);
const firstWords = (s: string) => s.split(/\s+/).slice(0, 6).join(" ") + (s.split(/\s+/).length > 6 ? "…" : "");
function describe(err: unknown) {
  const status = (err as { status?: number })?.status;
  if (status === 529) return "model overloaded (529)";
  if (status === 429) return "rate limited (429)";
  if (status && status >= 500) return `server error (${status})`;
  return (err as Error)?.message ?? "unknown error";
}
