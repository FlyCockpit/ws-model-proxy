import {
  CLI_DEVICE_LOGIN_UPGRADE_DEVICE_CODE,
  CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE,
} from "@ws-model-proxy/config/cli-device-login";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { deviceCodeUpgradeGate } from "./device-code-upgrade-gate.js";

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

  it("uses an upgrade message that a 0.3.x login prints instead of retrying", () => {
    const lower = CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE.toLowerCase();
    for (const word of ["pending", "denied", "expired", "polling too fast"]) {
      expect(lower).not.toContain(word);
    }
    expect(CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE).toContain("wsmp 0.4.0 or newer");
  });
});
