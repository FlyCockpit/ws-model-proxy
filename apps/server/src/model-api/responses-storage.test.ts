import { describe, expect, it } from "vitest";
import { storedResponseUnavailable, unsupportedCapabilityMessage } from "./responses-storage.js";

const now = new Date("2026-10-07T12:00:00Z");
const requester = { userId: "u", apiKeyId: "key" };
const record = {
  userId: "u",
  apiKeyId: "key",
  selectedTargetId: "target",
  expiresAt: new Date(now.getTime() + 60_000),
};

describe("GET/DELETE of a Responses id", () => {
  it("says a response that was never stored was not stored, not that it expired", () => {
    // `store` omitted, or a request translated for a wrap without stored responses: no record.
    for (const message of [
      storedResponseUnavailable(null, requester, now),
      storedResponseUnavailable(record, { ...requester, apiKeyId: "other" }, now),
    ]) {
      expect(message).toContain("not stored");
      expect(message).not.toContain("expired");
    }
  });

  it("says expired only for a stored response past its retention", () => {
    expect(
      storedResponseUnavailable(
        { ...record, expiresAt: new Date(now.getTime() - 1) },
        requester,
        now,
      ),
    ).toContain("expired");
    expect(storedResponseUnavailable(record, requester, now)).toBeNull();
  });

  it("explains a store: true create that no member can store", () => {
    expect(
      unsupportedCapabilityMessage({ family: "responses", contextInput: { store: true } }),
    ).toContain('"store": true');
    for (const contextInput of [{ store: false }, { store: true, previous_response_id: "r" }])
      expect(unsupportedCapabilityMessage({ family: "responses", contextInput })).toBeUndefined();
    expect(
      unsupportedCapabilityMessage({ family: "chat.completions", contextInput: { store: true } }),
    ).toBeUndefined();
  });
});
