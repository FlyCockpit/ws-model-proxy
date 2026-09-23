import { describe, expect, it, vi } from "vitest";

import { warnMissingProviderCredentialKeyring } from "./provider-keyring-startup";

describe("warnMissingProviderCredentialKeyring", () => {
  it("logs once when egress is on and the keyring is missing", () => {
    const log = vi.fn();
    expect(
      warnMissingProviderCredentialKeyring({ egressEnabled: true, keyring: undefined }, log),
    ).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain("WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS");
    expect(message).toContain("missing");
    expect(message).not.toMatch(/v1:/);

    const blank = vi.fn();
    expect(
      warnMissingProviderCredentialKeyring({ egressEnabled: true, keyring: "   " }, blank),
    ).toBe(true);
    expect(blank).toHaveBeenCalledTimes(1);
  });

  it("does not log when the keyring is set or egress is off", () => {
    const log = vi.fn();
    const sentinel = "configured-keyring-sentinel";
    expect(
      warnMissingProviderCredentialKeyring({ egressEnabled: true, keyring: sentinel }, log),
    ).toBe(false);
    expect(
      warnMissingProviderCredentialKeyring({ egressEnabled: false, keyring: undefined }, log),
    ).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
  });
});
