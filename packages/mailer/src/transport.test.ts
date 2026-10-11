import { describe, expect, it, vi } from "vitest";

const createTransport = vi.hoisted(() => vi.fn(() => ({ sendMail: vi.fn(async () => ({})) })));
vi.mock("nodemailer", () => ({ default: { createTransport } }));
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { SMTP_HOST: "smtp.example.com", SMTP_PORT: 587, SMTP_FROM: "noreply@example.com" },
}));

const { sendEmail, SMTP_CONNECTION_TIMEOUT_MS, SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS } =
  await import("./index");

describe("SMTP transport", () => {
  it("bounds connection, greeting and socket waits", async () => {
    await sendEmail({ to: "person@example.com", subject: "s", html: "h" });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
        greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
        socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      }),
    );
    expect(SMTP_SOCKET_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
