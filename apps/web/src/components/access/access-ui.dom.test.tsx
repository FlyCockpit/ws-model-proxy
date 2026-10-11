// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({ toast: { success: vi.fn() } }));

import { credentialStatus, expiryFromChoice } from "./credential-meta";
import { SecretReveal } from "./secret-reveal";

afterEach(cleanup);

describe("SecretReveal", () => {
  it("shows the secret once with a copy button and closes on I copied it", () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const onDone = vi.fn();
    render(<SecretReveal value="wsmp_key_secret" onDone={onDone} />);
    expect(screen.getByText("wsmp_key_secret")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "access:secret.copy" }));
    expect(writeText).toHaveBeenCalledWith("wsmp_key_secret");
    fireEvent.click(screen.getByRole("button", { name: "access:secret.done" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("credential helpers", () => {
  const base = { createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null };
  it("derives the status", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    expect(credentialStatus({ ...base, expiresAt: null, revokedAt: null }, now)).toBe("active");
    expect(
      credentialStatus({ ...base, expiresAt: "2026-05-01T00:00:00Z", revokedAt: null }, now),
    ).toBe("expired");
    expect(
      credentialStatus({ ...base, expiresAt: null, revokedAt: "2026-02-01T00:00:00Z" }, now),
    ).toBe("revoked");
  });

  it("keeps a one-year expiry inside the server's 365-day cap", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const year = Date.parse(expiryFromChoice("y1", now) ?? "") - now;
    expect(year).toBeLessThan(365 * 86_400_000);
    expect(expiryFromChoice("never", now)).toBeNull();
  });
});
