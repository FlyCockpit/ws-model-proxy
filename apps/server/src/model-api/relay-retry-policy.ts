import {
  type ResponsesOperation,
  responsesOperationRetrySafety,
} from "@ws-model-proxy/api/lib/surface-capabilities";

export type RelayRetryOperation = {
  family: string;
  capability: string;
  additionalCapabilities?: readonly string[];
};

export type RelayRetryFailureCategory =
  | "precommit_5xx"
  | "precommit_transport"
  | "precommit_content_type_mismatch"
  | "precommit_context_exceeded";

const OVERFLOW_CODES = new Set(["context_length_exceeded", "exceed_context_size_error"]);

const OVERFLOW_MESSAGE_START = [
  /^(this model's )?maximum context length/i,
  /^prompt is too long/i,
  /^the input \(\d+ tokens\) is longer than the model's context length/i,
  /^requested token count exceeds/i,
  /^the input length exceeds the context window/i,
  /^exceed_context_size_error/i,
  /^'max_tokens' or 'max_completion_tokens' is too large/i,
  /^the decoder prompt \(length \d+\)/i,
];

const OVERFLOW_MESSAGE_BROAD = [
  /maximum context length is \d+/i,
  /max_model_len/i,
  /maximum model length/i,
];

export type EngineContextOverflowClassification = {
  overflow: boolean;
  promptTokens: number | null;
  requestedTokens: number | null;
  contextLength: number | null;
  snippet: string;
};

function jsonErrorFields(bodyText: string): {
  code?: string;
  type?: string;
  message?: string;
  detail?: string;
} {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    const nested =
      record.error !== null && typeof record.error === "object"
        ? (record.error as Record<string, unknown>)
        : undefined;
    const read = (value: unknown) => (typeof value === "string" ? value : undefined);
    return {
      code:
        read(nested?.code) ?? (typeof nested?.code === "number" ? undefined : read(record.code)),
      type: read(nested?.type) ?? read(record.type),
      message: read(nested?.message) ?? read(record.message),
      detail: read(nested?.detail) ?? read(record.detail),
    };
  } catch {
    return { message: bodyText };
  }
}

function firstLine(text: string): string {
  return text.replace(/^\s+/, "").split(/\r?\n/, 1)[0] ?? "";
}

function extractOverflowTokenCounts(text: string): {
  promptTokens: number | null;
  requestedTokens: number | null;
  contextLength: number | null;
} {
  const splitMatch = text.match(
    /you requested (\d+) tokens \((\d+) in the messages, (\d+) in the completion\)/i,
  );
  const messagesOnly = text.match(/you requested (\d+) tokens in the messages/i);
  const requestedOnly = text.match(/you requested (\d+) tokens/i);
  const decoderPrompt = text.match(/decoder prompt \(length (\d+)\)/i);
  const inputTokens = text.match(/has (\d+) input tokens/i);
  const inputParen = text.match(/input \((\d+) tokens\)/i);
  const contextMatch =
    text.match(/context length(?: is)? \((\d+) tokens\)/i) ??
    text.match(/maximum context length is (\d+)/i) ??
    text.match(/maximum context length of (\d+)/i) ??
    text.match(/maximum model length of (\d+)/i) ??
    text.match(/context length(?: is)? (\d+)/i);
  const promptTokens = parseCount(
    splitMatch?.[2] ??
      decoderPrompt?.[1] ??
      inputTokens?.[1] ??
      inputParen?.[1] ??
      messagesOnly?.[1],
  );
  const requestedTokens = parseCount(splitMatch?.[1] ?? requestedOnly?.[1] ?? messagesOnly?.[1]);
  return {
    promptTokens,
    requestedTokens,
    contextLength: parseCount(contextMatch?.[1]),
  };
}

function parseCount(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function sanitizeEngineOverflowSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** Engine 4xx that means the prompt did not fit this member's context. */
export function classifyEngineContextOverflow(
  status: number,
  bodyText: string,
): EngineContextOverflowClassification {
  const empty = {
    overflow: false,
    promptTokens: null,
    requestedTokens: null,
    contextLength: null,
    snippet: "",
  };
  if (!Number.isInteger(status) || status < 400 || status >= 500) return empty;
  const fields = jsonErrorFields(bodyText);
  const code = fields.code?.toLowerCase();
  const type = fields.type?.toLowerCase();
  const message = fields.message ?? "";
  const detail = fields.detail ?? "";
  const haystack = `${message} ${detail}`;
  const byCode =
    (code !== undefined && OVERFLOW_CODES.has(code)) ||
    (type !== undefined && OVERFLOW_CODES.has(type));
  const byMessage =
    OVERFLOW_MESSAGE_START.some(
      (pattern) => pattern.test(firstLine(message)) || pattern.test(firstLine(detail)),
    ) || OVERFLOW_MESSAGE_BROAD.some((pattern) => pattern.test(haystack));
  if (!byCode && !byMessage) return empty;
  const counts = extractOverflowTokenCounts(haystack);
  return {
    overflow: true,
    promptTokens: counts.promptTokens,
    requestedTokens: counts.requestedTokens,
    contextLength: counts.contextLength,
    snippet: sanitizeEngineOverflowSnippet(message || detail || bodyText),
  };
}

export function isEngineContextOverflow(status: number, bodyText: string): boolean {
  return classifyEngineContextOverflow(status, bodyText).overflow;
}

export function relayOperationRetrySafety(
  operation: RelayRetryOperation,
): "pre_commit_only" | "idempotent" | "never" {
  if (operation.family !== "responses") return "pre_commit_only";
  const responsesOperation = responsesOperationForRelay(operation);
  return responsesOperationRetrySafety(responsesOperation);
}

function responsesOperationForRelay(operation: RelayRetryOperation): ResponsesOperation {
  if (operation.additionalCapabilities?.includes("responses.statefulFollowUps"))
    return "statefulFollowUps";
  const capability = operation.capability.replace("responses.", "");
  if (capability === "statefulFollowUps") return "statefulFollowUps";
  if (capability === "retrieve") return "retrieve";
  if (capability === "delete") return "delete";
  if (capability === "cancel") return "cancel";
  if (capability === "listInputItems") return "listInputItems";
  if (capability === "countTokens") return "countTokens";
  if (capability === "compact") return "compact";
  return "create";
}

export function shouldRetryRelayOperation(
  operation: RelayRetryOperation,
  _failure: RelayRetryFailureCategory,
): boolean {
  return relayOperationRetrySafety(operation) !== "never";
}
