import { parseEmbeddingContract } from "@ws-model-proxy/api/lib/embedding-contract";
import {
  type OpenAiCompatibleCapabilities,
  openAiCapabilitiesFromCoarse,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import { transcriptionProfileSchema } from "@ws-model-proxy/api/lib/transcription-profile";

/**
 * A served model's request capabilities: its effective coarse capabilities (the owner's
 * override, else detected), with its embedding vector-space contract and, for speech-to-text,
 * the transcription profile its runtime definition declares (`models[].transcription`: the
 * language hints, response formats, streaming and so on requests are routed by). A declared
 * profile means the model serves `/v1/audio/transcriptions` even without `audio_input`, and its
 * `realtime` block is what `/v1/models` advertises as live (sessions route through
 * `realtime/routing.ts`, which reads the same profile).
 * Surface-level (v3/v4) metadata such as Anthropic Messages is not modelled on RuntimeModel yet.
 */
export function servedModelCapabilities(model: {
  capabilities: readonly string[];
  embeddingContract?: unknown;
  transcriptionProfile?: unknown;
}): OpenAiCompatibleCapabilities {
  let capabilities = openAiCapabilitiesFromCoarse(model.capabilities);
  const contract = parseEmbeddingContract(model.embeddingContract);
  if (capabilities.version === 1 && capabilities.embeddings && contract)
    capabilities = { ...capabilities, embeddings: { ...capabilities.embeddings, contract } };
  const profile = transcriptionProfileSchema.safeParse(model.transcriptionProfile);
  if (capabilities.version === 1 && profile.success) {
    const { realtime, ...file } = profile.data;
    // Version 2 carries a transcription profile (version 1 only booleans).
    const { audio, ...rest } = capabilities;
    capabilities = {
      ...rest,
      version: 2,
      audio: {
        transcriptions: {
          supported: true,
          ...file,
          ...(realtime ? { realtime: { supported: true, ...realtime } } : {}),
        },
        ...(audio?.speech === true ? { speech: true } : {}),
      },
    };
  }
  return capabilities;
}
