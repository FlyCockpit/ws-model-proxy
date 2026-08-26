import { describe, expect, it } from "vitest";
import { relayOperationRetrySafety, shouldRetryRelayOperation } from "./relay-retry-policy.js";

const failures = [
  "precommit_5xx",
  "precommit_transport",
  "precommit_content_type_mismatch",
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
});
