export const ADAPTER_VERSION = "1.0.0" as const;

export type ProtocolSurface = "openai-chat" | "openai-responses" | "anthropic-messages";
export type InstructionRole = "system" | "developer";

export type CanonicalText = { type: "text"; text: string };
export type CanonicalImage = {
  type: "image";
  source:
    | { kind: "url"; url: string; detail?: "auto" | "low" | "high" }
    | {
        kind: "base64";
        mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
};
export type CanonicalContent = CanonicalText | CanonicalImage;

export type CanonicalInstruction = {
  role: InstructionRole;
  content: CanonicalText[];
  /** Stable source-order boundary; renderers must not merge or reorder entries. */
  boundary: { sourceIndex: number; sourceItemId?: string };
};

export type CanonicalToolCall = { type: "tool_call"; id: string; name: string; arguments: string };
export type CanonicalToolResult = {
  type: "tool_result";
  toolCallId: string;
  content: CanonicalText[];
  isError?: boolean;
};
export type CanonicalMessage = {
  role: "user" | "assistant";
  content: Array<CanonicalContent | CanonicalToolCall | CanonicalToolResult>;
  boundary: { sourceIndex: number; sourceItemId?: string };
};
export type CanonicalTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};
export type CanonicalToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "tool"; name: string };

export type CanonicalRequest = {
  adapterVersion: typeof ADAPTER_VERSION;
  source: ProtocolSurface;
  model: string;
  instructions: CanonicalInstruction[];
  messages: CanonicalMessage[];
  tools: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  /** Adapted paths deliberately force one tool call at a time. */
  parallelToolCalls: "single";
  stream: boolean;
  sampling: { temperature?: number; topP?: number; stop?: string[]; maxOutputTokens?: number };
  limitations: string[];
};

export type CanonicalResponse = {
  id: string;
  model?: string;
  items: Array<
    { type: "text"; text: string } | { type: "refusal"; text: string } | CanonicalToolCall
  >;
  usage?: CanonicalUsage;
  stopReason: "stop" | "length" | "tool" | "content_filter" | "unknown";
};

export type ProtocolResponseMetadata = {
  status: number;
  requestId?: string;
  retryAfter?: string;
  retryLimit?: string;
  retryRemaining?: string;
  retryReset?: string;
  tokenLimit?: string;
  tokenRemaining?: string;
  tokenReset?: string;
  resetFormat?: "duration" | "timestamp";
};

export type ParsedProtocolResponse =
  | { ok: true; metadata: ProtocolResponseMetadata; response: CanonicalResponse }
  | { ok: false; metadata: ProtocolResponseMetadata; error: CanonicalProtocolError };

export type CanonicalUsage = { inputTokens?: number; outputTokens?: number };
export type CanonicalEvent =
  | { type: "message_start"; id: string; model?: string; usage?: CanonicalUsage }
  | {
      type: "item_start";
      index: number;
      id: string;
      itemType: "text" | "tool_call" | "refusal" | "reasoning";
    }
  | { type: "text_delta"; index: number; delta: string }
  | { type: "refusal_delta"; index: number; delta: string }
  | { type: "reasoning_delta"; index: number; delta: string }
  | { type: "tool_arguments_delta"; index: number; id: string; name?: string; delta: string }
  | { type: "item_complete"; index: number }
  | { type: "usage"; usage: CanonicalUsage }
  | { type: "stop"; reason: "stop" | "length" | "tool" | "content_filter" | "unknown" }
  | { type: "complete" }
  | { type: "error"; error: CanonicalProtocolError };

export type CanonicalProtocolError = {
  code: string;
  message: string;
  parameter?: string;
  upstreamStatus?: number;
  requestId?: string;
  retryAfter?: string;
  retryLimit?: string;
  retryRemaining?: string;
  retryReset?: string;
  tokenLimit?: string;
  tokenRemaining?: string;
  tokenReset?: string;
  resetFormat?: "duration" | "timestamp";
};
