import { z } from "zod";

/** Why a relayed request or session failed; Rust `protocol::RelayFailure`. */
export const relayFailureSchema = z.enum([
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
