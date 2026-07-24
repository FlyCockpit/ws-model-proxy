import { z } from "zod";

export const RELAY_PROTOCOL_VERSION = "2.0";
export const RELAY_SUBPROTOCOL = "ws-model-proxy.relay.v2";

const RELAY_JSON_CONTROL_MAX_BYTES = 64 * 1024;
export const RELAY_BINARY_CHUNK_MAX_BYTES = 1024 * 1024;
// Request-body flow control window. The server may have at most this many
// request-body chunks in flight toward a CLI before it must wait for the CLI to
// acknowledge consumed chunks (`relay.request.body.ack`). It bounds CLI-side
// buffering to `RELAY_REQUEST_BODY_WINDOW_CHUNKS * RELAY_BINARY_CHUNK_MAX_BYTES`
// per request so large request bodies stream without full buffering while one
// slow upstream cannot stall sibling requests multiplexed on the same socket.
export const RELAY_REQUEST_BODY_WINDOW_CHUNKS = 16;
export const RELAY_STALE_AFTER_MS = 60_000;
export const RELAY_UNREGISTERED_STALE_AFTER_MS = 10_000;

const relayFailureSchema = z.enum([
  "transport",
  "timeout",
  "disconnected",
  "upstream_5xx",
  "upstream_4xx",
  "unsupported_capability",
  "not_found",
  "access_denied",
  "rate_limited",
  "request_too_large",
  "cancelled",
  "protocol_error",
  "unknown",
]);
export type RelayFailure = z.infer<typeof relayFailureSchema>;

const requestIdSchema = z.string().trim().min(1).max(128);
const headerNameSchema = z.string().trim().min(1).max(128);
const headerValueSchema = z.string().max(8192);
const headerSchema = z.record(headerNameSchema, headerValueSchema);

const booleanSupportSchema = z.boolean().optional();

export const openAiCompatibleCapabilitiesSchema = z
  .object({
    version: z.literal(1),
    protocol: z.literal("openai-compatible"),
    models: z
      .object({
        list: booleanSupportSchema,
      })
      .strict()
      .optional(),
    chatCompletions: z
      .object({
        supported: booleanSupportSchema,
        streaming: booleanSupportSchema,
        /** OpenAI-shaped `image_url` content parts. */
        vision: booleanSupportSchema,
        /**
         * OpenAI-shaped `video_url` content parts (e.g. MiMo / omni local models).
         * Distinct from dedicated media-store video; this is chat multimodal input.
         */
        video: booleanSupportSchema,
        /**
         * OpenAI-shaped `input_audio` content parts in chat.
         * Distinct from top-level `audio.transcriptions` / `translations` endpoints.
         */
        audio: booleanSupportSchema,
      })
      .strict()
      .optional(),
    completions: z
      .object({
        supported: booleanSupportSchema,
        streaming: booleanSupportSchema,
      })
      .strict()
      .optional(),
    embeddings: z
      .object({
        supported: booleanSupportSchema,
      })
      .strict()
      .optional(),
    responses: z
      .object({
        supported: booleanSupportSchema,
        streaming: booleanSupportSchema,
        statefulFollowUps: booleanSupportSchema,
        retrieve: booleanSupportSchema,
        delete: booleanSupportSchema,
        cancel: booleanSupportSchema,
        listInputItems: booleanSupportSchema,
        countTokens: booleanSupportSchema,
        compact: booleanSupportSchema,
      })
      .strict()
      .optional(),
    audio: z
      .object({
        transcriptions: booleanSupportSchema,
        translations: booleanSupportSchema,
        speech: booleanSupportSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type OpenAiCompatibleCapabilities = z.infer<typeof openAiCompatibleCapabilitiesSchema>;

const cliCapabilitiesSchema = z
  .object({
    protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    binaryFrames: z.literal(true),
    cancellation: z.literal(true),
    maxBinaryChunkBytes: z.literal(RELAY_BINARY_CHUNK_MAX_BYTES),
    requestBodyStreaming: z.literal(true),
    requestBodyWindowChunks: z.literal(RELAY_REQUEST_BODY_WINDOW_CHUNKS),
  })
  .strict();

const discoveredModelSchema = z
  .object({
    slug: z.string().trim().min(1).max(128).optional(),
    upstreamModelId: z.string().trim().min(1).max(512),
    capabilities: openAiCompatibleCapabilitiesSchema.optional(),
    capabilityOverrideMode: z.enum(["inherit", "override"]).default("inherit"),
    probeSuggestions: openAiCompatibleCapabilitiesSchema.optional(),
  })
  .strict();

const endpointInventorySchema = z
  .object({
    slug: z.string().trim().min(1).max(63),
    label: z.string().trim().min(1).max(160),
    kind: z.literal("openai-compatible"),
    status: z.enum(["unknown", "online", "degraded", "offline"]).default("unknown"),
    defaultCapabilities: openAiCompatibleCapabilitiesSchema,
    probeSuggestions: openAiCompatibleCapabilitiesSchema.optional(),
    models: z.array(discoveredModelSchema).max(1000).default([]),
  })
  .strict();

export type EndpointInventory = z.infer<typeof endpointInventorySchema>;

const relayClientControlMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      id: requestIdSchema,
      protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
      cli: z
        .object({
          slug: z.string().trim().min(1).max(63),
          label: z.string().trim().min(1).max(160),
          version: z.string().trim().max(80).optional(),
          capabilities: cliCapabilitiesSchema,
        })
        .strict(),
      endpoints: z.array(endpointInventorySchema).max(100).default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal("inventory.update"),
      id: requestIdSchema,
      endpoints: z.array(endpointInventorySchema).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("heartbeat"),
      id: requestIdSchema,
      sentAt: z.string().datetime().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.request.body.ack"),
      requestId: requestIdSchema,
      credits: z.number().int().min(1).max(RELAY_REQUEST_BODY_WINDOW_CHUNKS),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.response.headers"),
      requestId: requestIdSchema,
      status: z.number().int().min(100).max(599),
      headers: headerSchema.default({}),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.complete"),
      requestId: requestIdSchema,
      usage: z
        .object({
          promptTokens: z.number().int().min(0).optional(),
          completionTokens: z.number().int().min(0).optional(),
          totalTokens: z.number().int().min(0).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.error"),
      requestId: requestIdSchema,
      failure: relayFailureSchema,
      message: z.string().max(1000).optional(),
      upstreamStatusCode: z.number().int().min(100).max(599).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.cancelled"),
      requestId: requestIdSchema,
    })
    .strict(),
]);
export type RelayClientControlMessage = z.infer<typeof relayClientControlMessageSchema>;

export type RelayServerControlMessage =
  | { type: "hello.ok"; id: string; protocolVersion: typeof RELAY_PROTOCOL_VERSION }
  | { type: "heartbeat.pong"; id: string; receivedAt: string }
  | {
      type: "relay.request";
      requestId: string;
      family:
        | "chat.completions"
        | "completions"
        | "embeddings"
        | "responses"
        | "audio"
        | "images"
        | "generic";
      method: string;
      path: string;
      headers: Record<string, string>;
      timeoutMs: number;
      // Whether the CLI should expect streamed `relay.request.body` frames for
      // this request (true when the request carries a body). When false the CLI
      // forwards the request to upstream immediately with an empty body.
      expectBody: boolean;
    }
  | { type: "relay.cancel"; requestId: string; reason: RelayFailure }
  | { type: "protocol.error"; failure: "protocol_error"; message: string; requestId?: string };

export type RelayBinaryFrameMetadata = {
  type: "relay.request.body" | "relay.response.body";
  requestId: string;
  chunkId: string;
  final?: boolean;
};

const relayBinaryFrameMetadataSchema = z
  .object({
    type: z.enum(["relay.request.body", "relay.response.body"]),
    requestId: requestIdSchema,
    chunkId: z.string().trim().min(1).max(128),
    final: z.boolean().optional(),
  })
  .strict();

export function parseRelaySubprotocolHeader(header: string | undefined): {
  ok: boolean;
  supported: boolean;
  requestedMajorVersions: number[];
} {
  const requested = (header ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const requestedMajorVersions = requested
    .map((part) => /^ws-model-proxy\.relay\.v(\d+)$/.exec(part)?.[1])
    .filter((part): part is string => Boolean(part))
    .map((part) => Number.parseInt(part, 10));
  return {
    ok: requested.length > 0,
    supported: requested.includes(RELAY_SUBPROTOCOL),
    requestedMajorVersions,
  };
}

export function encodeRelayServerControlMessage(message: RelayServerControlMessage): string {
  return JSON.stringify(message);
}

export function parseRelayClientControlFrame(frame: string): RelayClientControlMessage {
  const bytes = new TextEncoder().encode(frame).byteLength;
  if (bytes > RELAY_JSON_CONTROL_MAX_BYTES) {
    throw new RelayProtocolError("JSON control frame exceeds 64 KiB.");
  }
  const parsed: unknown = JSON.parse(frame);
  return relayClientControlMessageSchema.parse(parsed);
}

class RelayProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayProtocolError";
  }
}

export function encodeRelayBinaryFrame(
  metadata: RelayBinaryFrameMetadata,
  body: Uint8Array,
): ArrayBuffer {
  if (body.byteLength > RELAY_BINARY_CHUNK_MAX_BYTES) {
    throw new RelayProtocolError("Binary body chunk exceeds 1 MiB.");
  }
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > RELAY_JSON_CONTROL_MAX_BYTES) {
    throw new RelayProtocolError("Binary frame metadata exceeds 64 KiB.");
  }
  const frame = new Uint8Array(4 + metadataBytes.byteLength + body.byteLength);
  new DataView(frame.buffer).setUint32(0, metadataBytes.byteLength, false);
  frame.set(metadataBytes, 4);
  frame.set(body, 4 + metadataBytes.byteLength);
  return frame.buffer;
}

export function parseRelayBinaryFrame(frame: ArrayBuffer): {
  metadata: RelayBinaryFrameMetadata;
  body: Uint8Array;
} {
  if (frame.byteLength < 4) {
    throw new RelayProtocolError("Binary frame is missing metadata length.");
  }
  const metadataLength = new DataView(frame).getUint32(0, false);
  if (metadataLength > RELAY_JSON_CONTROL_MAX_BYTES) {
    throw new RelayProtocolError("Binary frame metadata exceeds 64 KiB.");
  }
  const bodyLength = frame.byteLength - 4 - metadataLength;
  if (bodyLength < 0) {
    throw new RelayProtocolError("Binary frame metadata length is invalid.");
  }
  if (bodyLength > RELAY_BINARY_CHUNK_MAX_BYTES) {
    throw new RelayProtocolError("Binary body chunk exceeds 1 MiB.");
  }
  const metadataBytes = new Uint8Array(frame, 4, metadataLength);
  const metadataText = new TextDecoder().decode(metadataBytes);
  const metadata = relayBinaryFrameMetadataSchema.parse(JSON.parse(metadataText));
  const body = new Uint8Array(frame, 4 + metadataLength, bodyLength);
  return { metadata, body };
}
