// Model catalog. Prices are USD per 1M tokens (Anthropic first-party API, Nov 2026).
export type ModelKey = "haiku" | "sonnet" | "opus" | "fable";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelInfo {
  key: ModelKey;
  id: string;
  name: string;
  inputPrice: number;
  outputPrice: number;
  effort: Effort;
  /** Typical reply length for the work this model gets routed. Used for cost estimates only. */
  typicalOutputTokens: number;
  blurb: string;
  /** Server-side refusal fallback is supported on this model. */
  serverFallback: boolean;
}

export const MODELS: Record<ModelKey, ModelInfo> = {
  haiku: {
    key: "haiku", id: "claude-haiku-5-5", name: "Haiku 5.5",
    inputPrice: 0.1, outputPrice: 0.5, effort: "low", typicalOutputTokens: 300,
    blurb: "Fastest and cheapest. Quick facts, rewrites, short answers.", serverFallback: false,
  },
  sonnet: {
    key: "sonnet", id: "claude-sonnet-5-5", name: "Sonnet 5.5",
    inputPrice: 2, outputPrice: 10, effort: "medium", typicalOutputTokens: 900,
    blurb: "Everyday workhorse. Normal coding, writing, explanations.", serverFallback: true,
  },
  opus: {
    key: "opus", id: "claude-opus-5-5", name: "Opus 5.5",
    inputPrice: 4, outputPrice: 20, effort: "high", typicalOutputTokens: 2000,
    blurb: "Deep reasoning. Architecture, tricky bugs, hard analysis.", serverFallback: true,
  },
  fable: {
    key: "fable", id: "claude-fable-5-2", name: "Fable 5.2",
    inputPrice: 8, outputPrice: 40, effort: "high", typicalOutputTokens: 4000,
    blurb: "Most capable. Long multi-step work where getting it right matters most.", serverFallback: true,
  },
};

export const LADDER: ModelKey[] = ["haiku", "sonnet", "opus", "fable"];

/** Rough token estimate: ~4 characters per token for English text. */
export const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

export function estimateCost(model: ModelInfo, inputTokens: number, outputTokens = model.typicalOutputTokens) {
  return (inputTokens * model.inputPrice + outputTokens * model.outputPrice) / 1_000_000;
}

/**
 * If a model is overloaded or errors, which models do we try next, in order?
 * Step to the nearest neighbour first so quality changes as little as possible.
 */
export function fallbackChain(key: ModelKey): ModelKey[] {
  switch (key) {
    case "fable": return ["fable", "opus", "sonnet"];
    case "opus": return ["opus", "sonnet", "fable"];
    case "sonnet": return ["sonnet", "opus", "haiku"];
    case "haiku": return ["haiku", "sonnet"];
  }
}
