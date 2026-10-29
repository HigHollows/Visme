import { AIError, type AIProvider } from "../types";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import type { FetchFn } from "./sse";

export interface ProviderConfig {
  kind: "anthropic" | "openai" | "openai_compatible";
  baseUrl?: string;
}

export function createProvider(id: string, cfg: ProviderConfig, apiKey: string, fetchFn?: FetchFn): AIProvider {
  switch (cfg.kind) {
    case "anthropic":
      return new AnthropicProvider({ apiKey, baseUrl: cfg.baseUrl, fetch: fetchFn });
    case "openai":
      return new OpenAIProvider({ apiKey, id, baseUrl: cfg.baseUrl, fetch: fetchFn });
    case "openai_compatible":
      if (!cfg.baseUrl) throw new AIError("baseUrl requise pour un endpoint compatible OpenAI", "other");
      return new OpenAIProvider({ apiKey, id, baseUrl: cfg.baseUrl, fetch: fetchFn });
  }
}
