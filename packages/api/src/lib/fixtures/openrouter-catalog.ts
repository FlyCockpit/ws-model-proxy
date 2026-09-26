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

/**
 * The first two entries are copied from the live `/api/v1/models` document
 * (2026-09-26) with descriptions and parameter lists shortened; the third uses
 * price keys seen live on other entries. They carry the shapes the first parser missed:
 * a `~` floating alias id, `pricing.overrides` tiers (by prompt length, and by
 * time of day with extra `utc_*` keys), non-token price keys (`web_search`,
 * `input_cache_write_1h`, `audio`), and extra top-level fields
 * (`alias_target`, `reasoning`, `benchmarks`).
 */
export function liveShapedCatalogEntries() {
  return [
    {
      id: "~openai/gpt-luna-latest",
      canonical_slug: "~openai/gpt-luna-latest",
      alias_target: { name: "OpenAI: GPT-6 Luna", slug: "openai/gpt-6-luna" },
      hugging_face_id: null,
      name: "OpenAI: GPT Luna Latest",
      created: 1_789_130_922,
      description: "This model always redirects to the latest model in the GPT Luna family.",
      context_length: 1_050_000,
      architecture: {
        modality: "text+image+file->text",
        input_modalities: ["file", "image", "text"],
        output_modalities: ["text"],
        tokenizer: "Router",
        instruct_type: null,
      },
      pricing: {
        prompt: "0.0000001",
        completion: "0.0000005",
        web_search: "0.01",
        input_cache_read: "0.00000001",
        input_cache_write: "0.000000125",
        overrides: [
          {
            min_prompt_tokens: 272_000,
            prompt: "0.0000002",
            completion: "0.00000075",
            input_cache_read: "0.00000002",
            input_cache_write: "0.00000025",
          },
        ],
      },
      top_provider: {
        context_length: 1_050_000,
        max_completion_tokens: 128_000,
        is_moderated: true,
      },
      per_request_limits: null,
      supported_parameters: ["include_reasoning", "reasoning", "response_format", "tools"],
      default_parameters: { temperature: null, top_p: null },
      supported_voices: null,
      knowledge_cutoff: null,
      expiration_date: null,
      links: { details: "/api/v1/models/~openai/gpt-luna-latest/endpoints" },
      reasoning: { mandatory: false, default_enabled: true, supported_efforts: ["high", "low"] },
    },
    {
      id: "tencent/hy3",
      canonical_slug: "tencent/hy3-20260706",
      hugging_face_id: "tencent/Hy3",
      name: "Tencent: Hy3",
      created: 1_783_344_048,
      description: "Hy3 is a 295B-parameter Mixture-of-Experts model.",
      context_length: 262_144,
      architecture: {
        modality: "text->text",
        input_modalities: ["text"],
        output_modalities: ["text"],
        tokenizer: "Other",
        instruct_type: null,
      },
      pricing: {
        prompt: "0.0000000825",
        completion: "0.00000033",
        input_cache_read: "0.000000020625",
        overrides: [
          {
            utc_start: 0,
            utc_end: 1600,
            prompt: "0.000000132",
            completion: "0.000000528",
            input_cache_read: "0.000000033",
          },
          {
            utc_start: 1600,
            utc_end: 0,
            prompt: "0.0000000825",
            completion: "0.00000033",
            input_cache_read: "0.000000020625",
          },
        ],
      },
      top_provider: {
        context_length: 262_144,
        max_completion_tokens: 128_000,
        is_moderated: false,
      },
      supported_parameters: ["include_reasoning", "reasoning", "tools"],
      expiration_date: null,
      benchmarks: { design_arena: [{ arena: "models", category: "3d", elo: 1199 }] },
      reasoning: { mandatory: false },
    },
    {
      id: "anthropic/claude-sonnet-5",
      name: "Anthropic: Claude Sonnet 5",
      context_length: 1_000_000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: {
        prompt: "0.000003",
        completion: "0.000015",
        input_cache_read: "0.0000003",
        input_cache_write: "0.00000375",
        input_cache_write_1h: "0.000006",
        audio: "0.00001",
        web_search: "0.01",
      },
      top_provider: {
        context_length: 1_000_000,
        max_completion_tokens: 64_000,
        is_moderated: true,
      },
      supported_parameters: ["tools", "reasoning"],
      expiration_date: null,
    },
  ];
}
