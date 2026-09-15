// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const enableMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-client", () => ({
  authClient: { twoFactor: { enable: enableMock } },
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "@ws-model-proxy/ui/components/sileo";

import { useTotpEnrollment } from "./use-totp-enrollment";

const toastError = vi.mocked(toast.error);

// The two production call sites (`_auth.tsx` forced-setup flow and
// `settings/security.tsx` Enable2FASection) delegate their entire enrollment
// decision to this hook; only the error message, log label, and success step
// differ. Each variant is exercised against every Better Auth 1.7 outcome.
const callSites = [
  {
    name: "_auth.tsx TwoFactorSetupRequired flow (advances to verify)",
    logLabel: "_auth.twoFactor.enable",
    message: "auth:twoFactor.couldNotStartSetup",
  },
  {
    name: "settings/security.tsx Enable2FASection flow (advances to setup)",
    logLabel: "settings.security.twoFactor.enable",
    message: "settings:security.couldNotStartSetup",
  },
] as const;

function mountEnrollment(logLabel: string, message: string) {
  const onEnabled = vi.fn();
  const hook = renderHook(() =>
    useTotpEnrollment({ couldNotStartSetupMessage: message, logLabel, onEnabled }),
  );
  return { hook, onEnabled };
}

async function enrollWithPassword(logLabel: string, message: string) {
  const { hook, onEnabled } = mountEnrollment(logLabel, message);
  act(() => hook.result.current.setPassword("correct horse battery"));
  await act(async () => {
    await hook.result.current.enable();
  });
  return { hook, onEnabled };
}

afterEach(() => {
  cleanup();
  enableMock.mockReset();
  toastError.mockReset();
  vi.restoreAllMocks();
});

describe.each(callSites)("useTotpEnrollment — $name", ({ logLabel, message }) => {
  it('requests method "totp" and stores URI/backup codes on the "totp" discriminant', async () => {
    enableMock.mockResolvedValue({
      data: {
        method: "totp",
        totpURI: "otpauth://totp/WS%20Model%20Proxy?secret=JBSWY3DPEHPK3PXP",
        backupCodes: ["code-a", "code-b", "code-c"],
      },
      error: null,
    });

    const { hook, onEnabled } = await enrollWithPassword(logLabel, message);

    expect(enableMock).toHaveBeenCalledTimes(1);
    expect(enableMock).toHaveBeenCalledWith({
      password: "correct horse battery",
      method: "totp",
    });
    expect(hook.result.current.totpURI).toBe(
      "otpauth://totp/WS%20Model%20Proxy?secret=JBSWY3DPEHPK3PXP",
    );
    expect(hook.result.current.backupCodes).toEqual(["code-a", "code-b", "code-c"]);
    expect(onEnabled).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('rejects the "otp" discriminant with an error and no state advance', async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    enableMock.mockResolvedValue({ data: { method: "otp" }, error: null });

    const { hook, onEnabled } = await enrollWithPassword(logLabel, message);

    expect(hook.result.current.totpURI).toBe("");
    expect(hook.result.current.backupCodes).toEqual([]);
    expect(onEnabled).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(message);
    expect(consoleError).toHaveBeenCalledWith(`[${logLabel}] unexpected method`, "otp");
    expect(hook.result.current.isLoading).toBe(false);
  });

  it("rejects a missing method (data present without a discriminant)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enableMock.mockResolvedValue({ data: {}, error: null });

    const { hook, onEnabled } = await enrollWithPassword(logLabel, message);

    expect(hook.result.current.totpURI).toBe("");
    expect(hook.result.current.backupCodes).toEqual([]);
    expect(onEnabled).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(message);
    expect(hook.result.current.isLoading).toBe(false);
  });

  it("rejects undefined data with an error and no state advance", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enableMock.mockResolvedValue({ data: undefined, error: null });

    const { hook, onEnabled } = await enrollWithPassword(logLabel, message);

    expect(hook.result.current.totpURI).toBe("");
    expect(hook.result.current.backupCodes).toEqual([]);
    expect(onEnabled).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(message);
    expect(hook.result.current.isLoading).toBe(false);
  });

  it("surfaces a request failure (result.error) without advancing state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enableMock.mockResolvedValue({
      data: null,
      error: { code: "INVALID_PASSWORD", message: "Invalid password" },
    });

    const { hook, onEnabled } = await enrollWithPassword(logLabel, message);

    expect(hook.result.current.totpURI).toBe("");
    expect(hook.result.current.backupCodes).toEqual([]);
    expect(onEnabled).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(message);
    expect(console.error).toHaveBeenCalledWith(`[${logLabel}]`, {
      code: "INVALID_PASSWORD",
      message: "Invalid password",
    });
    expect(hook.result.current.isLoading).toBe(false);
  });

  it("catches a thrown request error without advancing state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enableMock.mockRejectedValue(new Error("network down"));

    const { hook, onEnabled } = await enrollWithPassword(logLabel, message);

    expect(hook.result.current.totpURI).toBe("");
    expect(hook.result.current.backupCodes).toEqual([]);
    expect(onEnabled).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(message);
    expect(hook.result.current.isLoading).toBe(false);
  });
});
