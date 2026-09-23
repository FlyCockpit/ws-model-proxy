import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";

import type { AttachmentModalities, AttachmentModality } from "@/lib/image-attachments";

export type VisibleModels = Awaited<
  ReturnType<AppRouterClient["forwarderManagement"]["visibleModels"]>
>;

export type ModelOption = {
  id: string;
  modelId: string;
  label: string;
  kind: "DIRECT_MODEL" | "MODEL_POOL";
  attachmentModalities: AttachmentModalities;
  maxAttachmentBytes: number | null;
  reasoning: VisibleModels["directModels"][number]["reasoning"];
  compatibility?: VisibleModels["modelPools"][number]["compatibility"];
  /** Present for pools. True when requests may leave the deployment. */
  effectiveProviderEgress?: boolean;
};

export type ChatTestRoutingMode = "PREFER_NATIVE" | "REQUIRE_NATIVE" | "REQUIRE_ADAPTED";
export type ChatTestSurface = "OPENAI_CHAT_COMPLETIONS" | "OPENAI_RESPONSES" | "ANTHROPIC_MESSAGES";
export type ChatTestSurfaceSelection = "PREFERRED" | ChatTestSurface;
export type ChatRole = "user" | "assistant";
type ChatMessageStatus = "ready" | "streaming" | "error" | "stopped";

type ChatAttachmentBase = {
  id: string;
  name: string;
  modality: AttachmentModality;
  sizeBytes: number;
  expired?: boolean;
};
type ChatAttachmentData = ChatAttachmentBase & { kind: "data"; dataUrl: string };
type ChatAttachmentMedia = ChatAttachmentBase & {
  kind: "media";
  mediaId: string;
  previewUrl: string;
};
export type ChatAttachment = ChatAttachmentData | ChatAttachmentMedia;

export type ChatTimingMetrics = {
  ttftMs?: number;
  completionTokens?: number;
  tokensPerSecond?: number;
};

export type TransformDebug = {
  modelId: string;
  latencyMs: number;
  cacheHit: boolean;
  includePrimaryTools: boolean;
  toolCount: number;
  envelope: string | null;
  error: string | null;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  status: ChatMessageStatus;
  sourceUserMessageId?: string;
  errorMessage?: string;
  attachments?: ChatAttachment[];
  metrics?: ChatTimingMetrics;
  transformDebug?: TransformDebug;
  thinking?: string;
};

export type RelayContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } }
  | { type: "input_audio_url"; input_audio: { url: string } };
export type RelayChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | RelayContentPart[];
};
