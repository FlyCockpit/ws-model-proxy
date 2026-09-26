/** Trimmed OpenRouter `/api/v1/models` entry (shape verified live 2026-09-26). */
export function catalogEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "qwen/qwen3-coder",
    canonical_slug: "qwen/qwen3-coder-2507",
    name: "Qwen: Qwen3 Coder",
    description: "long text that must be dropped",
    created: 1_790_000_000,
    context_length: 262_144,
    architecture: {
      modality: "text->text",
      input_modalities: ["text"],
      output_modalities: ["text"],
      tokenizer: "Qwen",
    },
    pricing: {
      prompt: "0.0000002",
      completion: "0.0000008",
      input_cache_read: "0.00000002",
      web_search: "0.01",
    },
    top_provider: { context_length: 262_144, max_completion_tokens: 65_536, is_moderated: false },
    supported_parameters: ["tools", "tool_choice", "reasoning", "response_format"],
    expiration_date: null,
    links: { details: "/api/v1/models/qwen/qwen3-coder/endpoints" },
    ...overrides,
  };
}
