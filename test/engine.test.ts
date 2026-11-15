import { describe, expect, it } from "vitest";
import { Switchboard, DEFAULTS, dryRun, type TraceEvent } from "../src/engine";
import type { LLM } from "../src/llm";
import { pickModel } from "../src/policy";
import { scoreWithRules } from "../src/rules";

/** Scripted fake provider: plan + check answers come from queues. */
function fake(opts: { plan?: unknown; checks?: Array<{ pass: boolean; score: number; issue: string }>; failModels?: string[]; triage?: unknown }): LLM & { log: string[] } {
  const checks = [...(opts.checks ?? [])];
  const log: string[] = [];
  return {
    log,
    async complete(req) {
      log.push(`complete:${req.model.key}`);
      if (opts.failModels?.includes(req.model.key)) throw Object.assign(new Error("overloaded"), { status: 529 });
      req.onText?.("ok");
      return { text: `answer from ${req.model.key}`, servedBy: req.model.id, refused: false, inputTokens: 1000, outputTokens: 500 };
    },
    async structured(req) {
      const sys = req.system;
      log.push(`structured:${req.model.key}`);
      const data = sys.startsWith("You triage") ? (opts.triage ?? { difficulty: 3, kind: "code", multi_step: true, reason: "x" })
        : sys.startsWith("You split") ? opts.plan
        : checks.shift() ?? { pass: true, score: 0.9, issue: "" };
      return { data: data as never, inputTokens: 300, outputTokens: 50 };
    },
  };
}

const run = async (llm: LLM, task: string, extra = {}) => {
  const events: TraceEvent[] = [];
  await new Switchboard(llm, { ...DEFAULTS, ...extra, onEvent: (e) => events.push(e) }).run(task);
  return events;
};

describe("rules", () => {
  it("rates a quick question low and a design task high", () => {
    expect(scoreWithRules("what's the capital of France?").level).toBeLessThan(1.6);
    expect(scoreWithRules("Design a distributed rate limiter for a microservices system and explain the trade-offs, edge cases and failure modes carefully.").level).toBeGreaterThan(4);
  });
  it("policy modes shift the cut-offs", () => {
    expect(pickModel(3.3, "save")).toBe("sonnet");
    expect(pickModel(3.3, "balanced")).toBe("opus");
    expect(pickModel(4, "quality")).toBe("fable");
  });
});

describe("engine", () => {
  const plan = { steps: [
    { title: "Design schema", instruction: "a", difficulty: 4, kind: "architecture" },
    { title: "Write README", instruction: "b", difficulty: 1, kind: "rewrite" },
  ] };

  it("switches down for a simple step and stitches the answer", async () => {
    const e = await run(fake({ plan }), "Design a distributed job queue with retries and the worker. Then ship it.\n1. design\n2. client");
    const switches = e.filter((x) => x.type === "switch");
    expect(switches[0]).toMatchObject({ from: "opus", to: "haiku", direction: "down" });
    expect(e.at(-1)).toMatchObject({ type: "final" });
  });

  it("escalates when the check fails, then stops at the limit", async () => {
    const bad = { pass: false, score: 0.3, issue: "missing edge cases" };
    const e = await run(fake({ plan: { steps: [{ title: "Hard", instruction: "x", difficulty: 2.5, kind: "debug" }, { title: "Done", instruction: "y", difficulty: 2, kind: "chat" }] }, checks: [bad, bad, bad] }),
      "Debug this race condition in my worker pool step by step\n1. find\n2. fix");
    const ups = e.filter((x) => x.type === "switch" && x.direction === "up" && x.step === 1);
    expect(ups.map((x) => (x as { to: string }).to)).toEqual(["opus", "fable"]);
    expect(e.some((x) => x.type === "budget")).toBe(true);
  });

  it("falls back when a model is overloaded", async () => {
    const llm = fake({ plan, failModels: ["opus"] });
    const e = await run(llm, "Design a distributed job queue with retries and trade-offs\n1. design\n2. client");
    expect(e.find((x) => x.type === "fallback")).toMatchObject({ from: "opus", to: "sonnet" });
  });

  it("refuses to escalate past the budget", async () => {
    const bad = { pass: false, score: 0.2, issue: "wrong" };
    const e = await run(fake({ plan, checks: [bad] }), "Design a distributed job queue with retries and trade-offs\n1. design\n2. client", { budgetUsd: 0.03 });
    expect(e.find((x) => x.type === "budget")).toMatchObject({ message: expect.stringContaining("budget") });
  });

  it("answers a trivial prompt with one Haiku call and no planner", async () => {
    const llm = fake({});
    await run(llm, "hi, what's 2+2? quick");
    expect(llm.log).toEqual(["complete:haiku"]);
  });
});

describe("dry run", () => {
  it("routes each listed step on its own", () => {
    const d = dryRun("1. Design the database schema for a distributed system with trade-offs\n2. fix the typo in the README", "balanced");
    expect(d.steps.map((s) => s.model)).toEqual(["opus", "haiku"]);
    expect(d.total).toBeLessThan(d.opus * 3);
  });
});
