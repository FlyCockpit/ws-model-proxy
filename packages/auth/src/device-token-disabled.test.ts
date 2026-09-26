import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { deviceAuthorization } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import {
  DISABLED_DEVICE_AUTHORIZATION_PATHS,
  requireCliDeviceLoginScope,
} from "./cli-device-login-scope";

/**
 * Behavioral proof that an approved `wsmp login` code cannot be redeemed for a
 * browser session through Better Auth's `/device/token`. Drives a real
 * `betterAuth` instance with the same deviceAuthorization options and
 * `disabledPaths` as `index.ts`, backed by the in-memory adapter (no database).
 */

const BASE_URL = "http://localhost:3000";

type Row = Record<string, unknown>;

function buildAuth(disabledPaths: string[]) {
  const db: Record<string, Row[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    deviceCode: [],
  };
  const auth = betterAuth({
    baseURL: BASE_URL,
    secret: "device-token-disabled-test-secret-at-least-32-chars",
    database: memoryAdapter(db),
    disabledPaths,
    plugins: [
      deviceAuthorization({
        expiresIn: "30m",
        interval: "5s",
        onDeviceAuthRequest: requireCliDeviceLoginScope,
        schema: undefined,
      }),
    ],
  });
  return { auth, db };
}

async function approvedDeviceCode(setup: ReturnType<typeof buildAuth>) {
  const started = await setup.auth.handler(
    new Request(`${BASE_URL}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "ws-model-proxy", scope: "cli-slug:desk-01" }),
    }),
  );
  expect(started.status).toBe(200);
  const { device_code: deviceCode } = (await started.json()) as { device_code: string };
  const now = new Date();
  setup.db.user?.push({
    id: "user-1",
    name: "Owner",
    email: "owner@example.test",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const row = setup.db.deviceCode?.find((candidate) => candidate.deviceCode === deviceCode);
  if (!row) throw new Error("device code row missing");
  // What the approval page leaves behind: claimed and approved by the owner.
  row.userId = "user-1";
  row.status = "approved";
  return deviceCode;
}

function redeem(setup: ReturnType<typeof buildAuth>, deviceCode: string, path = "/device/token") {
  return setup.auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: "ws-model-proxy",
      }),
    }),
  );
}

describe("Better Auth /device/token", () => {
  it("is disabled", () => {
    expect(DISABLED_DEVICE_AUTHORIZATION_PATHS).toContain("/device/token");
  });

  it("mints a session from an approved code when left enabled (control)", async () => {
    const setup = buildAuth([]);
    const deviceCode = await approvedDeviceCode(setup);

    const response = await redeem(setup, deviceCode);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token_type: "Bearer" });
    expect(setup.db.session).toHaveLength(1);
  });

  it.each(["/device/token", "/device/token/"])(
    "refuses to redeem an approved code at %s and leaves the code for the CLI exchange",
    async (path) => {
      const setup = buildAuth([...DISABLED_DEVICE_AUTHORIZATION_PATHS]);
      const deviceCode = await approvedDeviceCode(setup);

      const response = await redeem(setup, deviceCode, path);

      expect(response.status).toBe(404);
      expect(setup.db.session).toHaveLength(0);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(setup.db.deviceCode?.find((row) => row.deviceCode === deviceCode)?.status).toBe(
        "approved",
      );
    },
  );

  it("still serves the device-code request the CLI uses", async () => {
    const setup = buildAuth([...DISABLED_DEVICE_AUTHORIZATION_PATHS]);
    await expect(approvedDeviceCode(setup)).resolves.toEqual(expect.any(String));
  });
});
