import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { CompleteRequest, CompleteResult, LLM, StructuredRequest } from "./llm";

/** Real provider backed by the Claude API. */
export class AnthropicLLM implements LLM {
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      apiKey,
      // The demo site is bring-your-own-key: the key lives only in the visitor's browser.
      dangerouslyAllowBrowser: typeof window !== "undefined",
      maxRetries: 1, // the router does its own fallback across models
    });
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    // Thinking is adaptive by default on every 5.x model; effort sets the depth.
    const stream = this.client.beta.messages.stream({
      model: req.model.id,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      output_config: { effort: req.model.effort },
      // Server-side refusal fallback, where the model supports it. The router's own
      // fallback chain covers everything else (overload, rate limits, errors).
      ...(req.model.serverFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    if (req.onText) {
      stream.on("text", (delta) => req.onText!(delta));
    }
    const msg = await stream.finalMessage();
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return {
      text,
      servedBy: msg.model,
      refused: msg.stop_reason === "refusal",
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
    };
  }

  async structured<T>(req: StructuredRequest<T>) {
    const msg = await this.client.messages.parse({
      model: req.model.id,
      max_tokens: 4000,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      output_config: { effort: "low", format: zodOutputFormat(req.schema as never) },
    });
    if (msg.stop_reason === "refusal" || !msg.parsed_output) {
      throw new Error(`Structured call on ${req.model.name} returned no usable output (${msg.stop_reason}).`);
    }
    return {
      data: msg.parsed_output as T,
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
    };
  }
}
