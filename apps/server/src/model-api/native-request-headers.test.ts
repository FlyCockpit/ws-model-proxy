import { describe, expect, it } from "vitest";
import { anthropicRelayHeaders } from "./anthropic-protocol";
import { nativeRequestHeaders } from "./native-request-headers";

describe("nativeRequestHeaders", () => {
  it("forwards only explicit OpenAI protocol headers, case-insensitively", () => {
    const request = new Request("https://wsmp.test/v1/responses", {
      method: "POST",
      headers: {
        ACCEPT: "text/event-stream",
        "Content-Type": "application/json",
        "Idempotency-Key": "retry-1",
        "OpenAI-Beta": "responses=v1",
        "OpenAI-Organization": "org_1",
        "OPENAI-PROJECT": "project_1",
        Authorization: "Bearer wsmp-secret",
        Cookie: "session=private",
        "Proxy-Authorization": "Basic private",
        "X-Provider-Account-Id": "provider-private",
        "X-Unrelated": "not-protocol-owned",
      },
    });
    expect(Object.fromEntries(nativeRequestHeaders(request, "openai"))).toEqual({
      accept: "text/event-stream",
      "content-type": "application/json",
      "idempotency-key": "retry-1",
      "openai-beta": "responses=v1",
      "openai-organization": "org_1",
      "openai-project": "project_1",
    });
  });

  it("rejects Connection-nominated fields and preserves required Anthropic fields", () => {
    const request = new Request("https://wsmp.test/v1/messages", {
      method: "POST",
      headers: {
        Connection: "keep-alive, AnThRoPiC-BeTa, request-id, ANTHROPIC-VERSION",
        "Anthropic-Version": "2023-06-01",
        "ANTHROPIC-BETA": "unsafe-client-beta",
        "Request-Id": "unsafe-client-request",
        Accept: "application/json",
        "X-Api-Key": "provider-secret",
        "Transfer-Encoding": "chunked",
      },
    });
    expect(Object.fromEntries(nativeRequestHeaders(request, "anthropic"))).toEqual({
      accept: "application/json",
      "content-type": "application/json",
    });
    expect(
      Object.fromEntries(
        anthropicRelayHeaders(request, {
          version: "2023-06-01",
          betaFeatures: ["server-validated-beta"],
        }),
      ),
    ).toEqual({
      accept: "application/json",
      "anthropic-beta": "server-validated-beta",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
  });
});
