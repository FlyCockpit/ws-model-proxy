/**
 * What a runtime's served model can do, as the node serves it. Pure: contracts are also bundled
 * for the browser.
 */
type ModelType = "LLM" | "EMBEDDINGS" | "TRANSCRIPTION";
type Capability =
  | "TEXT_GENERATION"
  | "VISION_INPUT"
  | "VIDEO_INPUT"
  | "EMBEDDING"
  | "AUDIO_INPUT"
  | "AUDIO_OUTPUT"
  | "RESPONSES_API";

/**
 * The capabilities of a served model whose definition declares none: its type's, as the node
 * serves it (`model_capabilities` in the CLI's `runtimes/endpoints.rs`).
 */
export function typeDefaultCapabilities(type: ModelType): Capability[] {
  switch (type) {
    case "EMBEDDINGS":
      return ["EMBEDDING"];
    case "TRANSCRIPTION":
      return ["AUDIO_INPUT"];
    case "LLM":
      return ["TEXT_GENERATION"];
  }
}

/**
 * A served model's capabilities: the owner's override when set, else what its definition or
 * discovery gave it, else its type's default (models saved before definitions stored the
 * default have none, and the node serves those as their type).
 */
export function effectiveModelCapabilities<C extends Capability>(model: {
  type: ModelType;
  detectedCapabilities: C[];
  capabilities: C[];
  capabilitiesOverridden: boolean;
}): Capability[] {
  if (model.capabilitiesOverridden) return model.capabilities;
  return model.detectedCapabilities.length > 0
    ? model.detectedCapabilities
    : typeDefaultCapabilities(model.type);
}
