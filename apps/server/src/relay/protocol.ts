/**
 * The relay 3.0 codec around the frame contract (`./frames.ts`): parse node frames, encode
 * server frames, binary framing (4-byte metadata length + JSON metadata + body), the websocket
 * subprotocol, and parse-error descriptions that never echo a value.
 *
 * Every outbound control frame is checked against `serverToNodeControlFrameSchema` before it
 * is framed, so the server can never send something the node would drop undecoded; anything
 * logged goes through {@link redactFrameForLog} (a `secret.set` value never reaches a log).
 */
import { z } from "zod";

export { type OpenAiCompatibleCapabilities } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";

import {
  type NodeToServerControlFrame,
  nodeToServerBinaryMetadataSchema,
  nodeToServerControlFrameSchema,
  RELAY_BINARY_CHUNK_MAX_BYTES,
  RELAY_JSON_CONTROL_MAX_BYTES,
  RELAY_PROTOCOL_ERROR_CODES,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  redactFrameForLog,
  type ServerToNodeControlFrame,
  serverToNodeBinaryMetadataSchema,
  serverToNodeControlFrameSchema,
} from "./frames.js";
import type { RelayFailure } from "./relay-failure.js";
import { STT_AUDIO_FRAME_MAX_BYTES, sttAudioBodyValid } from "./stt-protocol.js";
import { stringifyWellFormed } from "./wire-text.js";

export type { NodeToServerControlFrame, ServerToNodeControlFrame };
export {
  RELAY_BINARY_CHUNK_MAX_BYTES,
  RELAY_JSON_CONTROL_MAX_BYTES,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  type RelayFailure,
};
/** Kept names for the model API (the 2.x types were `RelayClient/ServerControlMessage`). */
export type RelayClientControlMessage = NodeToServerControlFrame;
export type RelayServerControlMessage = ServerToNodeControlFrame;

export type RelayProtocolErrorCode = (typeof RELAY_PROTOCOL_ERROR_CODES)[number];

/** The one protocol this server speaks (3.0 is a clean bump: no capability flags). */
export const RELAY_PROTOCOL_VERSIONS = [RELAY_PROTOCOL_VERSION] as const;

export const RELAY_UPGRADE_REQUIRED_MESSAGE = `This server requires relay protocol ${RELAY_PROTOCOL_VERSION}. Upgrade wsmp and restart it.`;
export const RELAY_SERVER_UPGRADE_REQUIRED_MESSAGE =
  "This wsmp speaks a newer relay protocol than the server. Upgrade WS Model Proxy and restart wsmp.";

/** 4-byte metadata length + 64 KiB metadata + 1 MiB body. Shared by both sockets. */
export const RELAY_WS_MAX_PAYLOAD_BYTES =
  4 + RELAY_JSON_CONTROL_MAX_BYTES + RELAY_BINARY_CHUNK_MAX_BYTES;
/** Request-body flow-control window, in chunks (`relay.request.body.ack` returns credits). */
export { RELAY_REQUEST_BODY_WINDOW_CHUNKS } from "./frames.js";
export const RELAY_STALE_AFTER_MS = 60_000;
export const RELAY_UNREGISTERED_STALE_AFTER_MS = 10_000;

export type ServerBinaryMetadata = z.infer<typeof serverToNodeBinaryMetadataSchema>;
export type NodeBinaryMetadata = z.infer<typeof nodeToServerBinaryMetadataSchema>;
export type TerminalSealedMetadata = Extract<NodeBinaryMetadata, { type: "term.sealed" }>;
export type RelayResponseBodyMetadata = Extract<
  NodeBinaryMetadata,
  { type: "relay.response.body" }
>;

export class RelayProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayProtocolError";
  }
}

const OVERSIZE_MESSAGE = "JSON control frame exceeds 64 KiB.";

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

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

export function protocolErrorMessage(input: {
  code: RelayProtocolErrorCode;
  message: string;
  requestId?: string;
}): Extract<ServerToNodeControlFrame, { type: "protocol.error" }> {
  return {
    type: "protocol.error",
    failure: "protocol_error",
    code: input.code,
    message: input.message,
    supportedVersions: [...RELAY_PROTOCOL_VERSIONS],
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  };
}

/** The paths of the first failed checks, for logs and errors (never the values). */
function issuePaths(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => issue.path.join(".") || "(root)")
    .join(", ");
}

/**
 * Encode one server frame. Throws {@link RelayProtocolError} (and sends nothing) when the
 * frame fails the 3.0 contract, is over 64 KiB, or holds text the node cannot read.
 */
export function encodeRelayServerControlMessage(frame: ServerToNodeControlFrame): string {
  const checked = serverToNodeControlFrameSchema.safeParse(frame);
  if (!checked.success) {
    throw new RelayProtocolError(
      `${frame.type} fails the relay 3.0 contract at ${issuePaths(checked.error)}.`,
    );
  }
  const encoded = stringifyWellFormed(frame);
  if (utf8Length(encoded) > RELAY_JSON_CONTROL_MAX_BYTES) {
    throw new RelayProtocolError(`${frame.type} exceeds 64 KiB.`);
  }
  return encoded;
}

/** Parse one node control frame (size cap, JSON, strict 3.0 schema). */
export function parseRelayClientControlFrame(frame: string): NodeToServerControlFrame {
  if (utf8Length(frame) > RELAY_JSON_CONTROL_MAX_BYTES) {
    throw new RelayProtocolError(OVERSIZE_MESSAGE);
  }
  const parsed: unknown = JSON.parse(frame);
  return nodeToServerControlFrameSchema.parse(parsed);
}

/**
 * True for a hello that is not 3.0 (an older or newer wsmp). Checked before the strict schema
 * so such a node gets a coded `protocol.error` it can print instead of "malformed message".
 */
export function helloNeedsUpgrade(frame: string): boolean {
  if (utf8Length(frame) > RELAY_JSON_CONTROL_MAX_BYTES) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  return record.type === "hello" && record.protocolVersion !== RELAY_PROTOCOL_VERSION;
}

/** `major.minor`, the only shape stored for a refused hello. */
const REJECTED_PROTOCOL_PATTERN = /^\d{1,4}\.\d{1,4}$/;
/** Semver (`1.2.3`, `1.2.3-rc.1+build`), at most 32 characters. */
const REJECTED_CLI_VERSION_PATTERN =
  /^(?=.{1,32}$)\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function versionField(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

/**
 * The protocol and wsmp versions a refused hello claimed (2.x hellos carry `cli.version`, 3.0
 * ones `node.version`). Anything that is not a short version-shaped string is dropped.
 */
export function rejectedHelloFacts(frame: string): {
  protocolVersion: string | null;
  cliVersion: string | null;
} {
  const none = { protocolVersion: null, cliVersion: null };
  if (utf8Length(frame) > RELAY_JSON_CONTROL_MAX_BYTES) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return none;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return none;
  const record = parsed as Record<string, unknown>;
  const holder = [record.node, record.cli].find(
    (value): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return {
    protocolVersion: versionField(record.protocolVersion, REJECTED_PROTOCOL_PATTERN),
    cliVersion: holder ? versionField(holder.version, REJECTED_CLI_VERSION_PATTERN) : null,
  };
}

/** Whether a protocol claimed by a refused hello is newer than this server speaks. */
export function refusedRelayProtocolReason(
  protocolVersion: string | null | undefined,
): "cli_too_old" | "cli_too_new" {
  const match = /^(\d{1,4})\.(\d{1,4})$/.exec(protocolVersion ?? "");
  const ours = /^(\d{1,4})\.(\d{1,4})$/.exec(RELAY_PROTOCOL_VERSION);
  if (!match || !ours) return "cli_too_old";
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const [ourMajor, ourMinor] = [Number(ours[1]), Number(ours[2])];
  const newer = major !== ourMajor ? major > ourMajor : minor > ourMinor;
  return newer ? "cli_too_new" : "cli_too_old";
}

const RELAY_CONTROL_PARSE_ISSUE_LIMIT = 20;

export type RelayControlParseErrorDescription =
  | { kind: "oversize" }
  | { kind: "json" }
  | { kind: "schema"; issues: Array<{ path: string; code: string }> }
  | { kind: "unknown"; name: string };

/** What failed, without any value from the frame (paths and issue codes only). */
export function describeRelayControlParseError(error: unknown): RelayControlParseErrorDescription {
  if (error instanceof RelayProtocolError) {
    if (error.message === OVERSIZE_MESSAGE) return { kind: "oversize" };
    return { kind: "unknown", name: error.name };
  }
  if (error instanceof SyntaxError) return { kind: "json" };
  if (error instanceof z.ZodError) {
    return {
      kind: "schema",
      issues: error.issues.slice(0, RELAY_CONTROL_PARSE_ISSUE_LIMIT).map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    };
  }
  if (error instanceof Error) return { kind: "unknown", name: error.name };
  return { kind: "unknown", name: "Error" };
}

/** A frame safe to log (secret values replaced). */
export function frameForLog(frame: ServerToNodeControlFrame | NodeToServerControlFrame): unknown {
  return redactFrameForLog(frame);
}

export function encodeRelayBinaryFrame(
  metadata: ServerBinaryMetadata,
  body: Uint8Array,
): ArrayBuffer {
  if (body.byteLength > RELAY_BINARY_CHUNK_MAX_BYTES) {
    throw new RelayProtocolError("Binary body chunk exceeds 1 MiB.");
  }
  if (!serverToNodeBinaryMetadataSchema.safeParse(metadata).success) {
    throw new RelayProtocolError(`${metadata.type} metadata fails the relay 3.0 contract.`);
  }
  if (metadata.type === "stt.audio" && !sttAudioBodyValid(body.byteLength)) {
    throw new RelayProtocolError(
      `stt.audio carries 1 to ${STT_AUDIO_FRAME_MAX_BYTES} bytes of whole samples.`,
    );
  }
  const metadataBytes = new TextEncoder().encode(stringifyWellFormed(metadata));
  if (metadataBytes.byteLength > RELAY_JSON_CONTROL_MAX_BYTES) {
    throw new RelayProtocolError("Binary frame metadata exceeds 64 KiB.");
  }
  const frame = new Uint8Array(4 + metadataBytes.byteLength + body.byteLength);
  new DataView(frame.buffer).setUint32(0, metadataBytes.byteLength, false);
  frame.set(metadataBytes, 4);
  frame.set(body, 4 + metadataBytes.byteLength);
  return frame.buffer;
}

/** The metadata length prefix and JSON of a binary frame, before the strict schema. */
function splitBinaryFrame(frame: ArrayBuffer): { metadataText: string; body: Uint8Array } {
  if (frame.byteLength < 4) {
    throw new RelayProtocolError("Binary frame is missing metadata length.");
  }
  const metadataLength = new DataView(frame).getUint32(0, false);
  if (metadataLength > RELAY_JSON_CONTROL_MAX_BYTES) {
    throw new RelayProtocolError("Binary frame metadata exceeds 64 KiB.");
  }
  const bodyLength = frame.byteLength - 4 - metadataLength;
  if (bodyLength < 0) throw new RelayProtocolError("Binary frame metadata length is invalid.");
  if (bodyLength > RELAY_BINARY_CHUNK_MAX_BYTES) {
    throw new RelayProtocolError("Binary body chunk exceeds 1 MiB.");
  }
  const metadataText = new TextDecoder().decode(new Uint8Array(frame, 4, metadataLength));
  return { metadataText, body: new Uint8Array(frame, 4 + metadataLength, bodyLength) };
}

/** Parse one node binary frame (node → server metadata only). */
export function parseRelayBinaryFrame(frame: ArrayBuffer): {
  metadata: NodeBinaryMetadata;
  body: Uint8Array;
} {
  const { metadataText, body } = splitBinaryFrame(frame);
  const metadata = nodeToServerBinaryMetadataSchema.parse(JSON.parse(metadataText));
  return { metadata, body };
}

/** The raw metadata `type` and id fields of a binary frame that failed the strict schema. */
export function binaryFrameTarget(
  frame: ArrayBuffer,
): { type: string; terminalId?: string; opId?: string; requestId?: string } | null {
  try {
    const { metadataText } = splitBinaryFrame(frame);
    const parsed: unknown = JSON.parse(metadataText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.type !== "string") return null;
    const text = (key: string): string | undefined => {
      const value = record[key];
      return typeof value === "string" ? value : undefined;
    };
    return {
      type: record.type,
      ...(text("terminalId") ? { terminalId: text("terminalId") } : {}),
      ...(text("opId") ? { opId: text("opId") } : {}),
      ...(text("requestId") ? { requestId: text("requestId") } : {}),
    };
  } catch {
    return null;
  }
}
