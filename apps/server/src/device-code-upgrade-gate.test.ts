import {
  CLI_DEVICE_LOGIN_UPGRADE_DEVICE_CODE,
  CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE,
} from "@ws-model-proxy/config/cli-device-login";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { deviceAuthorization } from "better-auth/plugins";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { DEVICE_CODE_BODY_MAX_BYTES, deviceCodeUpgradeGate } from "./device-code-upgrade-gate.js";

function app() {
  const reached = vi.fn();
  const types: Array<string | undefined> = [];
  const hono = new Hono();
  hono.use("/api/auth/device/code", deviceCodeUpgradeGate);
  hono.post("/api/auth/device/code", async (c) => {
    types.push(c.req.header("content-type"));
    reached(await c.req.text());
    return c.json({ device_code: "real", user_code: "ABCD-EFGH" });
  });
  return { hono, reached, types };
}

const CLI_JSON = JSON.stringify({ client_id: "ws-model-proxy", scope: "cli-slug:desk-01" });
const CLI_FORM = "client_id=ws-model-proxy&scope=cli-slug%3Adesk-01";

describe("device-code upgrade gate", () => {
  it.each([
    ["JSON", "application/json", JSON.stringify({ client_id: "ws-model-proxy" })],
    ["form", "application/x-www-form-urlencoded", "client_id=ws-model-proxy"],
    ["JSON with a blank scope", "application/json", JSON.stringify({ scope: "  " })],
  ])("answers a %s request without a scope with the upgrade device code", async (_, type, body) => {
    const { hono, reached } = app();
    const response = await hono.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": type },
      body,
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      device_code: CLI_DEVICE_LOGIN_UPGRADE_DEVICE_CODE,
      verification_uri: null,
      verification_uri_complete: null,
      error: "invalid_scope",
      error_description: CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE,
    });
    expect(typeof json.user_code).toBe("string");
    expect(reached).not.toHaveBeenCalled();
  });

  // What reaches Better Auth: only client_id and scope, as JSON under exactly
  // application/json, however the caller encoded or disguised the request.
  it.each([
    ["the CLI's own request", "application/json", CLI_JSON, CLI_JSON],
    [
      "an invalid scope (Better Auth answers it)",
      "application/json",
      JSON.stringify({ client_id: "ws-model-proxy", scope: "not-a-slug-scope" }),
      JSON.stringify({ client_id: "ws-model-proxy", scope: "not-a-slug-scope" }),
    ],
    ["a form", "application/x-www-form-urlencoded", CLI_FORM, CLI_JSON],
    [
      "a form with a charset",
      "application/x-www-form-urlencoded; charset=UTF-8",
      CLI_FORM,
      CLI_JSON,
    ],
    [
      "a mixed-case form type",
      "Application/X-Www-Form-Urlencoded",
      `${CLI_FORM}&user_id=victim`,
      CLI_JSON,
    ],
    ["a form user_id", "application/x-www-form-urlencoded", `${CLI_FORM}&user_id=victim`, CLI_JSON],
    [
      "a percent-encoded form key",
      "application/x-www-form-urlencoded",
      `${CLI_FORM}&user%5Fid=victim`,
      CLI_JSON,
    ],
    [
      "a repeated form key",
      "application/x-www-form-urlencoded",
      `${CLI_FORM}&user_id=a&user_id=b`,
      CLI_JSON,
    ],
    [
      "a repeated form scope (first wins)",
      "application/x-www-form-urlencoded",
      `${CLI_FORM}&scope=cli-slug%3Aother`,
      CLI_JSON,
    ],
    [
      "a JSON user_id",
      "application/json",
      JSON.stringify({ client_id: "ws-model-proxy", scope: "cli-slug:desk-01", user_id: "victim" }),
      CLI_JSON,
    ],
    [
      "an escaped JSON key",
      "application/json",
      '{"client_id":"ws-model-proxy","scope":"cli-slug:desk-01","user\\u005fid":"victim"}',
      CLI_JSON,
    ],
    [
      "a repeated JSON key",
      "application/json",
      '{"client_id":"ws-model-proxy","scope":"cli-slug:desk-01","user_id":"a","user_id":"b"}',
      CLI_JSON,
    ],
    [
      "a nested user_id",
      "application/json",
      JSON.stringify({
        client_id: "ws-model-proxy",
        scope: "cli-slug:desk-01",
        extra: { user_id: "victim" },
      }),
      CLI_JSON,
    ],
    [
      "a __proto__ key",
      "application/json",
      '{"client_id":"ws-model-proxy","scope":"cli-slug:desk-01","__proto__":{"user_id":"victim"}}',
      CLI_JSON,
    ],
    [
      "a form hidden in a JSON string under a type that names both",
      "application/json; x=application/x-www-form-urlencoded",
      JSON.stringify({
        client_id: "ws-model-proxy",
        scope: "cli-slug:desk-01",
        extra: "&user_id=victim&x=",
      }),
      CLI_JSON,
    ],
    ["an upper-case JSON type", "APPLICATION/JSON", CLI_JSON, CLI_JSON],
    ["a +json type", "application/vnd.wsmp+json", CLI_JSON, CLI_JSON],
    [
      "a non-string client_id",
      "application/json",
      JSON.stringify({ client_id: 7, scope: "cli-slug:desk-01" }),
      JSON.stringify({ scope: "cli-slug:desk-01" }),
    ],
    ["a whitespace-padded body", "application/json", `  ${CLI_JSON}\n`, CLI_JSON],
  ])("forwards only client_id and scope for %s", async (_label, type, body, forwarded) => {
    const { hono, reached, types } = app();
    const response = await hono.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": type },
      body,
    });
    expect(await response.json()).toMatchObject({ device_code: "real" });
    expect(reached).toHaveBeenLastCalledWith(forwarded);
    expect(types).toEqual(["application/json"]);
  });

  it.each([
    ["an array", "application/json", "[1,2]", 400],
    ["malformed JSON", "application/json", '{"scope":', 400],
    ["a JSON string", "application/json", '"cli-slug:desk-01"', 400],
    ["multipart", "multipart/form-data; boundary=x", CLI_FORM, 415],
    ["text", "text/plain", CLI_JSON, 415],
  ])("refuses %s before Better Auth", async (_label, type, body, status) => {
    const { hono, reached } = app();
    const response = await hono.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": type },
      body,
    });
    expect(response.status).toBe(status);
    expect(reached).not.toHaveBeenCalled();
  });

  /** A body with no Content-Length that yields 1 KiB chunks on demand. */
  function endlessBody(maxChunks: number) {
    const chunk = new TextEncoder().encode(`{"scope":"${"x".repeat(1024 - 11)}`.slice(0, 1024));
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > maxChunks) controller.close();
        else controller.enqueue(chunk);
      },
    });
    return { stream, pulls: () => pulls };
  }

  it("refuses an unlength'd oversized body at the cap without reading the rest (f3-F2)", async () => {
    const { hono, reached } = app();
    // 10 MiB offered; the gate must stop just past 16 KiB.
    const body = endlessBody(10 * 1024);
    const response = await hono.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body.stream,
      duplex: "half",
    } as RequestInit);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(reached).not.toHaveBeenCalled();
    // 16 chunks fill the cap, the 17th crosses it; the stream queues read
    // ahead by a few chunks. Buffering the whole body would pull all 10240.
    expect(body.pulls()).toBeLessThanOrEqual(DEVICE_CODE_BODY_MAX_BYTES / 1024 + 4);
  });

  it("refuses a declared oversized body without reading it", async () => {
    const { hono, reached } = app();
    const response = await hono.request("/api/auth/device/code", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(DEVICE_CODE_BODY_MAX_BYTES + 1),
      },
      body: "x".repeat(DEVICE_CODE_BODY_MAX_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(reached).not.toHaveBeenCalled();
  });

  it("passes an unlength'd body at the cap on to Better Auth", async () => {
    const { hono, reached } = app();
    const text = JSON.stringify({ scope: "cli-slug:desk-01", pad: "" });
    const padded = JSON.stringify({
      scope: "cli-slug:desk-01",
      pad: "p".repeat(DEVICE_CODE_BODY_MAX_BYTES - text.length),
    });
    expect(new TextEncoder().encode(padded).byteLength).toBe(DEVICE_CODE_BODY_MAX_BYTES);
    const bytes = new TextEncoder().encode(padded);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 1000)
          controller.enqueue(bytes.slice(offset, offset + 1000));
        controller.close();
      },
    });
    const response = await hono.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(await response.json()).toMatchObject({ device_code: "real" });
    expect(reached).toHaveBeenLastCalledWith(JSON.stringify({ scope: "cli-slug:desk-01" }));
  });

  it("uses an upgrade message that a 0.3.x login prints instead of retrying", () => {
    const lower = CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE.toLowerCase();
    for (const word of ["pending", "denied", "expired", "polling too fast"]) {
      expect(lower).not.toContain(word);
    }
    expect(CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE).toContain("wsmp 0.4.0 or newer");
  });
});

/**
 * End-to-end proof against the REAL deviceAuthorization plugin (in-memory
 * adapter, no database): a caller-supplied `user_id` never reaches the created
 * `DeviceCode` row. Better Auth stores `userId: request.user_id || null`
 * (plugins/device-authorization/routes.mjs), so this asserts the gate's strip
 * ahead of that handler.
 */
describe("device-code upgrade gate + Better Auth /device/code", () => {
  function buildHandler() {
    const db: Record<string, Record<string, unknown>[]> = { user: [], deviceCode: [] };
    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "device-code-user-id-strip-test-secret-32",
      database: memoryAdapter(db),
      plugins: [deviceAuthorization({ schema: undefined })],
    });
    const hono = new Hono();
    hono.use("/api/auth/device/code", deviceCodeUpgradeGate);
    hono.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
    return { hono, db };
  }

  it("creates the code with userId null even when user_id is supplied", async () => {
    const { hono, db } = buildHandler();
    const response = await hono.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "ws-model-proxy",
        scope: "cli-slug:desk-01",
        user_id: "victim-account",
      }),
    });
    expect(response.status).toBe(200);
    const { device_code: deviceCode } = (await response.json()) as { device_code: string };
    const row = db.deviceCode?.find((candidate) => candidate.deviceCode === deviceCode);
    expect(row).toBeDefined();
    expect(row?.userId ?? null).toBeNull();
  });

  const FORM = "client_id=ws-model-proxy&scope=cli-slug%3Adesk-01";
  const JSON_START = '{"client_id":"ws-model-proxy","scope":"cli-slug:desk-01"';
  it.each([
    ["mixed-case form type", "Application/X-Www-Form-Urlencoded", `${FORM}&user_id=victim-account`],
    ["upper-case form type", "APPLICATION/X-WWW-FORM-URLENCODED", `${FORM}&user_id=victim-account`],
    [
      "form type with parameters",
      "application/x-www-form-urlencoded; charset=UTF-8",
      `${FORM}&user_id=victim-account`,
    ],
    [
      "percent-encoded form key",
      "application/x-www-form-urlencoded",
      `${FORM}&user%5Fid=victim-account`,
    ],
    [
      "repeated form key",
      "application/x-www-form-urlencoded",
      `${FORM}&user_id=victim-account&user_id=victim-account`,
    ],
    ["mixed-case JSON type", "Application/JSON", `${JSON_START},"user_id":"victim-account"}`],
    ["escaped JSON key", "application/json", `${JSON_START},"user\\u005fid":"victim-account"}`],
    [
      "JSON type that also names the form type (Better Auth re-reads it as a form)",
      "application/json; note=application/x-www-form-urlencoded",
      `${JSON_START},"extra":"&client_id=ws-model-proxy&scope=cli-slug:desk-01&user_id=victim-account&x="}`,
    ],
    ["+json type", "application/vnd.wsmp+json", `${JSON_START},"user_id":"victim-account"}`],
    [
      "repeated JSON key",
      "application/json",
      `${JSON_START},"user_id":"victim-account","user_id":"victim-account"}`,
    ],
  ])("never binds a code to a supplied user_id: %s", async (_, type, body) => {
    const { hono, db } = buildHandler();
    const response = await hono.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": type },
      body,
    });
    expect(response.status).toBe(200);
    const { device_code: deviceCode } = (await response.json()) as { device_code: string };
    const row = db.deviceCode?.find((candidate) => candidate.deviceCode === deviceCode);
    expect(row?.scope).toBe("cli-slug:desk-01");
    expect(row?.userId ?? null).toBeNull();
  });

  it.each([
    ["multipart", "multipart/form-data; boundary=x"],
    ["text", "text/plain"],
    ["none", ""],
  ])("refuses a %s body with 415 and creates nothing", async (_, type) => {
    const { hono, db } = buildHandler();
    const response = await hono.request("/api/auth/device/code", {
      method: "POST",
      headers: type ? { "content-type": type } : {},
      // Bytes, so no Content-Type is implied when the case sends none.
      body: new TextEncoder().encode(`${FORM}&user_id=victim-account`),
    });
    expect(response.status).toBe(415);
    expect(db.deviceCode).toHaveLength(0);
  });

  it("refuses a body that is not a JSON object with 400 and creates nothing", async () => {
    const { hono, db } = buildHandler();
    for (const body of ["[1,2]", "not json", '"cli-slug:desk-01"']) {
      const response = await hono.request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status, body).toBe(400);
    }
    expect(db.deviceCode).toHaveLength(0);
  });
});
