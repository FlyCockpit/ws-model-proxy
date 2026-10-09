import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    CORS_ORIGIN: undefined,
    WMP_RATE_LIMIT_SCALE: 1,
  },
}));

const { consumeInviteAccept } = await import("./invite-accept-limit");

describe("consumeInviteAccept", () => {
  it("allows 10 attempts a minute per user, then refuses that user only", async () => {
    for (let i = 0; i < 10; i += 1) await expect(consumeInviteAccept("u1")).resolves.toBe(true);
    await expect(consumeInviteAccept("u1")).resolves.toBe(false);
    await expect(consumeInviteAccept("u2")).resolves.toBe(true);
  });
});
