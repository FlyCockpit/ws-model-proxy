import { describe, expect, it } from "vitest";
import {
  isEngineContextOverflow,
  relayOperationRetrySafety,
  shouldRetryRelayOperation,
} from "./relay-retry-policy.js";

const failures = [
  "precommit_5xx",
  "precommit_transport",
  "precommit_content_type_mismatch",
  "precommit_context_exceeded",
] as const;

describe("relay retry policy", () => {
  it.each(failures)("never retries previous_response_id follow-ups for %s", (failure) => {
    const operation = {
      family: "responses",
      capability: "responses.create",
      additionalCapabilities: ["responses.statefulFollowUps"],
    };
    expect(relayOperationRetrySafety(operation)).toBe("never");
    expect(shouldRetryRelayOperation(operation, failure)).toBe(false);
  });

  it.each(["responses.statefulFollowUps"])("never retries %s", (capability) => {
    for (const failure of failures)
      expect(shouldRetryRelayOperation({ family: "responses", capability }, failure)).toBe(false);
  });

  it.each([
    ["responses.retrieve", "idempotent"],
    ["responses.delete", "idempotent"],
    ["responses.listInputItems", "idempotent"],
    ["responses.countTokens", "idempotent"],
    ["responses.create", "pre_commit_only"],
    ["responses.cancel", "pre_commit_only"],
    ["responses.compact", "pre_commit_only"],
    ["chat.create", "pre_commit_only"],
  ] as const)("allows safe precommit retry for %s", (capability, safety) => {
    const operation = {
      family: capability === "chat.create" ? "chat.completions" : "responses",
      capability,
    };
    expect(relayOperationRetrySafety(operation)).toBe(safety);
    for (const failure of failures)
      expect(shouldRetryRelayOperation(operation, failure)).toBe(true);
  });

  it.each([
    [400, "This model's maximum context length is 32768 tokens", true],
    [400, "exceed_context_size_error", true],
    [400, "context_length_exceeded", true],
    [413, "the input length exceeds the context window", true],
    [400, "Requested token count exceeds the limit", true],
    [400, "unrelated bad request", false],
    [500, "maximum context length", false],
    [200, "maximum context length", false],
  ] as const)("classifies engine context overflow %s %s", (status, body, expected) => {
    expect(isEngineContextOverflow(status, body)).toBe(expected);
  });
});
