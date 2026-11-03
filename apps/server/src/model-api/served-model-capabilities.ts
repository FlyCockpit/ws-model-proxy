import { parseEmbeddingContract } from "@ws-model-proxy/api/lib/embedding-contract";
import {
  type OpenAiCompatibleCapabilities,
  openAiCapabilitiesFromCoarse,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import type { SurfaceRequestRequirements } from "@ws-model-proxy/api/lib/surface-capabilities";
import { transcriptionProfileSchema } from "@ws-model-proxy/api/lib/transcription-profile";

/**
 * A served model's request capabilities: its effective coarse capabilities (the owner's
 * override, else detected), with its embedding vector-space contract and, for speech-to-text,
 * for a TRANSCRIPTION model, the transcription profile its runtime definition declares (`models[].transcription`: the
 * language hints, response formats, streaming and so on requests are routed by). A declared
 * profile means the model serves `/v1/audio/transcriptions` even without `audio_input`, and its
 * `realtime` block is what `/v1/models` advertises as live (sessions route through
 * `realtime/routing.ts`, which reads the same profile).
 * The owner's `tools` / `reasoning` declarations apply to the Chat Completions and Responses
 * surfaces; null (undeclared) stays unknown, which routing lets through.
 * Surface-level (v3/v4) metadata such as Anthropic Messages is not modelled on RuntimeModel yet.
 */
export function servedModelCapabilities(model: {
  capabilities: readonly string[];
  /** RuntimeModel.type: only a TRANSCRIPTION model's profile counts. */
  type?: string;
  embeddingContract?: unknown;
  transcriptionProfile?: unknown;
  /** RuntimeModel.declaredTools: null or absent is unknown. */
  tools?: boolean | null;
  /** RuntimeModel.declaredReasoning: null or absent is unknown. */
  reasoning?: boolean | null;
}): OpenAiCompatibleCapabilities {
  let capabilities = openAiCapabilitiesFromCoarse(model.capabilities);
  const contract = parseEmbeddingContract(model.embeddingContract);
  if (capabilities.version === 1 && capabilities.embeddings && contract)
    capabilities = { ...capabilities, embeddings: { ...capabilities.embeddings, contract } };
  const profile =
    model.type === "TRANSCRIPTION"
      ? transcriptionProfileSchema.safeParse(model.transcriptionProfile)
      : null;
  if (capabilities.version === 1 && profile?.success) {
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
  return withDeclaredFeatures(capabilities, model.tools ?? undefined, model.reasoning ?? undefined);
}

function withDeclaredFeatures(
  capabilities: OpenAiCompatibleCapabilities,
  tools: boolean | undefined,
  reasoning: boolean | undefined,
): OpenAiCompatibleCapabilities {
  if (tools === undefined && reasoning === undefined) return capabilities;
  // Coarse capabilities always build version 1 or 2.
  if (capabilities.version !== 1 && capabilities.version !== 2) return capabilities;
  const declared = {
    ...(tools === undefined ? {} : { tools }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
  return {
    ...capabilities,
    ...(capabilities.chatCompletions
      ? { chatCompletions: { ...capabilities.chatCompletions, ...declared } }
      : {}),
    ...(capabilities.responses ? { responses: { ...capabilities.responses, ...declared } } : {}),
  };
}

/**
 * How many of the request's tool and reasoning needs this served model is not declared to
 * meet (0, 1 or 2). Pools route to the lowest count first, so a member declared to take tools
 * wins over an unknown one; a member declared without them never gets here (routing refuses it).
 */
export function undeclaredRequestedFeatures(
  capabilities: OpenAiCompatibleCapabilities | null | undefined,
  request: Pick<SurfaceRequestRequirements, "tools" | "reasoning"> | undefined,
): number {
  if (!request || (!request.tools && !request.reasoning)) return 0;
  const surfaces =
    capabilities && (capabilities.version === 1 || capabilities.version === 2)
      ? [capabilities.chatCompletions, capabilities.responses].filter(
          (surface) => surface?.supported === true,
        )
      : [];
  let undeclared = 0;
  for (const key of ["tools", "reasoning"] as const) {
    if (request[key] && !surfaces.some((surface) => surface?.[key] === true)) undeclared += 1;
  }
  return undeclared;
}
