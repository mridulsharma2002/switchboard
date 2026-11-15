import type { z } from "zod";
import type { ModelInfo } from "./models";

export interface Usage { inputTokens: number; outputTokens: number }
export interface CompleteResult extends Usage {
  text: string;
  /** Model that actually answered (differs from the request if a server-side fallback ran). */
  servedBy: string;
  refused: boolean;
}

export interface CompleteRequest {
  model: ModelInfo;
  system: string;
  prompt: string;
  maxTokens: number;
  onText?: (delta: string) => void;
}

export interface StructuredRequest<T> {
  model: ModelInfo;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}

/** Everything the engine needs from a model provider. Swappable so tests can run offline. */
export interface LLM {
  complete(req: CompleteRequest): Promise<CompleteResult>;
  structured<T>(req: StructuredRequest<T>): Promise<{ data: T } & Usage>;
}

/** Errors worth retrying on another model: overloaded, rate limited, server errors, network. */
export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === undefined) return (err as Error)?.name?.includes("Connection") ?? false;
  return status === 429 || status === 529 || status >= 500;
}
