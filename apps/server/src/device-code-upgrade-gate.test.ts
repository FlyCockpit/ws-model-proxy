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
  const hono = new Hono();
  hono.use("/api/auth/device/code", deviceCodeUpgradeGate);
  hono.post("/api/auth/device/code", async (c) => {
    reached(await c.req.text());
    return c.json({ device_code: "real", user_code: "ABCD-EFGH" });
  });
  return { hono, reached };
}

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

  it("passes a request with a scope (valid or not) to Better Auth with its body intact", async () => {
    const { hono, reached } = app();
    for (const scope of ["cli-slug:desk-01", "not-a-slug-scope"]) {
      const body = JSON.stringify({ client_id: "ws-model-proxy", scope });
      const response = await hono.request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(await response.json()).toMatchObject({ device_code: "real" });
      expect(reached).toHaveBeenLastCalledWith(body);
    }
    const form = "client_id=ws-model-proxy&scope=cli-slug%3Adesk-01";
    await hono.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    expect(reached).toHaveBeenLastCalledWith(form);
  });

  it("strips a caller-supplied user_id so a public caller cannot pre-bind a code", async () => {
    const { hono, reached } = app();
    // JSON.
    let response = await hono.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "ws-model-proxy",
        scope: "cli-slug:desk-01",
        user_id: "victim-account",
      }),
    });
    expect(await response.json()).toMatchObject({ device_code: "real" });
    expect(reached).toHaveBeenLastCalledWith(
      JSON.stringify({ client_id: "ws-model-proxy", scope: "cli-slug:desk-01" }),
    );
    // Form-urlencoded.
    response = await hono.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "client_id=ws-model-proxy&scope=cli-slug%3Adesk-01&user_id=victim-account",
    });
    expect(await response.json()).toMatchObject({ device_code: "real" });
    expect(reached).toHaveBeenLastCalledWith("client_id=ws-model-proxy&scope=cli-slug%3Adesk-01");
  });

  it("does not rewrite a body that carries no user_id", async () => {
    const { hono, reached } = app();
    // Non-canonical JSON spacing must survive untouched when there is nothing
    // to strip.
    const body = '{ "client_id": "ws-model-proxy", "scope": "cli-slug:desk-01" }';
    const response = await hono.request("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(await response.json()).toMatchObject({ device_code: "real" });
    expect(reached).toHaveBeenLastCalledWith(body);
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

  it("passes an unlength'd body at the cap to Better Auth intact", async () => {
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
    expect(reached).toHaveBeenLastCalledWith(padded);
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
});
