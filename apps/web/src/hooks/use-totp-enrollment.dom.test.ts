// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const enableMock = vi.hoisted(() => vi.fn());
const verifyTotpMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-client", () => ({
  authClient: { twoFactor: { enable: enableMock, verifyTotp: verifyTotpMock } },
}));

vi.mock("@ws-model-proxy/ui/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "@ws-model-proxy/ui/lib/toast";

import { useTotpEnrollment } from "./use-totp-enrollment";

const toastError = vi.mocked(toast.error);
const toastSuccess = vi.mocked(toast.success);

// The two production call sites (`_auth.tsx` forced-setup flow and
// `settings/security.tsx` Enable2FASection) delegate their entire enrollment
// flow to this hook; only the messages, log prefix, and whether a
// backup-code confirmation step comes first differ. Each variant is
// exercised against every Better Auth 1.7 outcome.
const callSites = [
  {
    name: "_auth.tsx TwoFactorSetupRequired flow (advances to verify)",
    logPrefix: "_auth.twoFactor",
    message: "auth:twoFactor.couldNotStartSetup",
    confirmBackupCodes: false,
    enrolledKind: "verify",
  },
  {
    name: "settings/security.tsx Enable2FASection flow (advances to setup)",
    logPrefix: "settings.security.twoFactor",
    message: "settings:security.couldNotStartSetup",
    confirmBackupCodes: true,
    enrolledKind: "setup",
  },
] as const;

const TOTP_RESULT = {
  data: {
    method: "totp",
    totpURI: "otpauth://totp/WS%20Model%20Proxy?secret=JBSWY3DPEHPK3PXP",
    backupCodes: ["code-a", "code-b", "code-c"],
  },
  error: null,
};

function mountEnrollment(logPrefix: string, message: string, confirmBackupCodes: boolean) {
  const onVerified = vi.fn();
  const hook = renderHook(() =>
    useTotpEnrollment({
      messages: { couldNotStartSetup: message, invalidCode: "invalid", enabled: "enabled" },
      logPrefix,
      confirmBackupCodes,
      onVerified,
    }),
  );
  return { hook, onVerified };
}

type Hook = ReturnType<typeof mountEnrollment>["hook"];

function typePassword(hook: Hook) {
  act(() => {
    hook.result.current.start();
  });
  act(() => {
    hook.result.current.setPassword("correct horse battery");
  });
}

async function enrollWithPassword(logPrefix: string, message: string, confirmBackupCodes = false) {
  const mounted = mountEnrollment(logPrefix, message, confirmBackupCodes);
  typePassword(mounted.hook);
  await act(async () => {
    await mounted.hook.result.current.enable();
  });
  return mounted;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  enableMock.mockReset();
  verifyTotpMock.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  vi.restoreAllMocks();
});

describe.each(callSites)(
  "useTotpEnrollment — $name",
  ({ logPrefix, message, confirmBackupCodes, enrolledKind }) => {
    const enroll = () => enrollWithPassword(logPrefix, message, confirmBackupCodes);
    const expectNoAdvance = (hook: Hook) => {
      expect(hook.result.current.state).toEqual({
        kind: "password",
        password: "correct horse battery",
        activity: { kind: "idle" },
      });
    };

    it('requests method "totp" and stores URI/backup codes on the "totp" discriminant', async () => {
      enableMock.mockResolvedValue(TOTP_RESULT);

      const { hook } = await enroll();

      expect(enableMock).toHaveBeenCalledTimes(1);
      expect(enableMock).toHaveBeenCalledWith({
        password: "correct horse battery",
        method: "totp",
      });
      expect(hook.result.current.state).toMatchObject({
        kind: enrolledKind,
        totpURI: "otpauth://totp/WS%20Model%20Proxy?secret=JBSWY3DPEHPK3PXP",
        backupCodes: ["code-a", "code-b", "code-c"],
      });
      expect(toastError).not.toHaveBeenCalled();
    });

    it('rejects the "otp" discriminant with an error and no state advance', async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      enableMock.mockResolvedValue({ data: { method: "otp" }, error: null });

      const { hook } = await enroll();

      expectNoAdvance(hook);
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError).toHaveBeenCalledWith(message);
      expect(consoleError).toHaveBeenCalledWith(`[${logPrefix}.enable] unexpected method`, "otp");
    });

    it("rejects a missing method (data present without a discriminant)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      enableMock.mockResolvedValue({ data: {}, error: null });

      const { hook } = await enroll();

      expectNoAdvance(hook);
      expect(toastError).toHaveBeenCalledWith(message);
    });

    it("rejects undefined data with an error and no state advance", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      enableMock.mockResolvedValue({ data: undefined, error: null });

      const { hook } = await enroll();

      expectNoAdvance(hook);
      expect(toastError).toHaveBeenCalledWith(message);
    });

    it("surfaces a request failure (result.error) without advancing state", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      enableMock.mockResolvedValue({
        data: null,
        error: { code: "INVALID_PASSWORD", message: "Invalid password" },
      });

      const { hook } = await enroll();

      expectNoAdvance(hook);
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError).toHaveBeenCalledWith(message);
      expect(console.error).toHaveBeenCalledWith(`[${logPrefix}.enable]`, {
        code: "INVALID_PASSWORD",
        message: "Invalid password",
      });
    });

    it("catches a thrown request error without advancing state", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      enableMock.mockRejectedValue(new Error("network down"));

      const { hook } = await enroll();

      expectNoAdvance(hook);
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError).toHaveBeenCalledWith(message);
    });

    it("sends one enable request for a double submit in the same tick", async () => {
      const pending = deferred<typeof TOTP_RESULT>();
      enableMock.mockReturnValue(pending.promise);
      const { hook } = mountEnrollment(logPrefix, message, confirmBackupCodes);
      typePassword(hook);

      let first: Promise<void> | undefined;
      let second: Promise<void> | undefined;
      act(() => {
        // Enter and click before React re-renders: both see the stale closure.
        first = hook.result.current.enable();
        second = hook.result.current.enable();
      });
      expect(enableMock).toHaveBeenCalledTimes(1);
      expect(hook.result.current.state).toMatchObject({ activity: { kind: "enabling" } });

      await act(async () => {
        pending.resolve(TOTP_RESULT);
        await Promise.all([first, second]);
      });
      expect(hook.result.current.state.kind).toBe(enrolledKind);
    });

    it("refuses cancel while an enable is in flight, so two enables never race", async () => {
      const pending = deferred<typeof TOTP_RESULT>();
      enableMock.mockReturnValue(pending.promise);
      const { hook } = mountEnrollment(logPrefix, message, confirmBackupCodes);
      typePassword(hook);

      let inFlight: Promise<void> | undefined;
      act(() => {
        inFlight = hook.result.current.enable();
      });
      act(() => {
        hook.result.current.cancel();
        hook.result.current.start();
      });
      expect(hook.result.current.state).toMatchObject({
        kind: "password",
        activity: { kind: "enabling" },
      });
      await act(async () => {
        pending.resolve(TOTP_RESULT);
        await inFlight;
      });

      expect(enableMock).toHaveBeenCalledTimes(1);
      expect(hook.result.current.state.kind).toBe(enrolledKind);
    });

    it("cancel after a failed enable drops the password", async () => {
      enableMock.mockResolvedValue({ data: null, error: { message: "nope" } });
      const { hook } = mountEnrollment(logPrefix, message, confirmBackupCodes);
      typePassword(hook);
      await act(async () => {
        await hook.result.current.enable();
      });
      act(() => {
        hook.result.current.cancel();
      });
      expect(hook.result.current.state).toEqual({ kind: "idle" });
      act(() => {
        hook.result.current.start();
      });
      expect(hook.result.current.state).toMatchObject({ kind: "password", password: "" });
    });

    it("verifies the code once, toasts success, and runs onVerified", async () => {
      enableMock.mockResolvedValue(TOTP_RESULT);
      verifyTotpMock.mockResolvedValue({ data: {}, error: null });
      const { hook, onVerified } = await enroll();
      if (confirmBackupCodes) {
        act(() => {
          hook.result.current.saveBackupCodes();
        });
      }
      act(() => {
        hook.result.current.setCode("123456");
      });

      await act(async () => {
        await Promise.all([hook.result.current.verify(), hook.result.current.verify()]);
      });

      expect(verifyTotpMock).toHaveBeenCalledTimes(1);
      expect(verifyTotpMock).toHaveBeenCalledWith({ code: "123456" });
      expect(toastSuccess).toHaveBeenCalledWith("enabled");
      expect(onVerified).toHaveBeenCalledTimes(1);
      expect(hook.result.current.state).toMatchObject({
        kind: "verify",
        activity: { kind: "done" },
      });
    });

    it("returns to code entry after an invalid code", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      enableMock.mockResolvedValue(TOTP_RESULT);
      verifyTotpMock.mockResolvedValue({ data: null, error: { code: "INVALID_CODE" } });
      const { hook, onVerified } = await enroll();
      if (confirmBackupCodes) {
        act(() => {
          hook.result.current.saveBackupCodes();
        });
      }
      act(() => {
        hook.result.current.setCode("000000");
      });
      await act(async () => {
        await hook.result.current.verify();
      });

      expect(toastError).toHaveBeenCalledWith("invalid");
      expect(console.error).toHaveBeenCalledWith(`[${logPrefix}.verifyTotp]`, {
        code: "INVALID_CODE",
      });
      expect(onVerified).not.toHaveBeenCalled();
      expect(hook.result.current.state).toMatchObject({
        kind: "verify",
        code: "000000",
        activity: { kind: "idle" },
      });
    });
  },
);
