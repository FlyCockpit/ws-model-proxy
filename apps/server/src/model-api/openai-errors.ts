import type { RelayFailure } from "../relay/protocol.js";

export type OpenAiErrorBody = {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
};

export function openAiErrorBody({
  message,
  type,
  param = null,
  code = null,
}: {
  message: string;
  type: string;
  param?: string | null;
  code?: string | null;
}): OpenAiErrorBody {
  return { error: { message, type, param, code } };
}

export function relayFailureHttpStatus(failure: RelayFailure): number {
  if (failure === "access_denied") return 401;
  if (failure === "cancelled") return 499;
  if (failure === "disconnected") return 503;
  if (failure === "not_found") return 404;
  if (failure === "protocol_error") return 502;
  if (failure === "rate_limited") return 429;
  if (failure === "request_too_large") return 429;
  if (failure === "timeout") return 504;
  if (failure === "unsupported_capability") return 400;
  if (failure === "upstream_4xx") return 400;
  if (failure === "upstream_5xx") return 502;
  if (failure === "transport") return 502;
  return 500;
}

function relayFailureMessage(failure: RelayFailure): string {
  if (failure === "access_denied") return "Access denied.";
  if (failure === "cancelled") return "Request was cancelled.";
  if (failure === "disconnected") return "The selected model endpoint is disconnected.";
  if (failure === "not_found") return "Model not found.";
  if (failure === "protocol_error") return "Relay protocol error.";
  if (failure === "rate_limited") return "Too many active model API requests.";
  if (failure === "request_too_large") return "Model API request body is too large.";
  if (failure === "timeout") return "Relay request timed out.";
  if (failure === "unsupported_capability")
    return "The selected model does not support this endpoint.";
  if (failure === "upstream_4xx") return "The upstream endpoint rejected the request.";
  if (failure === "upstream_5xx") return "The upstream endpoint failed.";
  if (failure === "transport") return "Relay transport failed.";
  return "Model relay failed.";
}

function openAiFailureResponse(failure: RelayFailure, message = relayFailureMessage(failure)) {
  return new Response(
    JSON.stringify(
      openAiErrorBody({
        message,
        type:
          failure === "access_denied"
            ? "authentication_error"
            : failure === "rate_limited"
              ? "rate_limit_error"
              : "api_error",
        code: failure,
      }),
    ),
    {
      status: relayFailureHttpStatus(failure),
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

export function openAiFailureJsonResponse(failure: RelayFailure, message?: string) {
  return openAiFailureResponse(failure, message);
}
