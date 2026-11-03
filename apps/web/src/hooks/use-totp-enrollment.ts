import { toast } from "@ws-model-proxy/ui/lib/toast";

import { useGuardedMachine } from "@/hooks/use-guarded-machine";
import { authClient } from "@/lib/auth-client";
import {
  initialTotpEnrollmentState,
  type TotpEnrollmentEvent,
  type TotpEnrollmentState,
  totpEnrollmentTransition,
} from "@/lib/two-factor-state";

type UseTotpEnrollmentOptions = {
  /**
   * Pre-translated messages. The two enrollment flows (`_auth.tsx` forced
   * setup and `settings/security.tsx`) live in different locale namespaces,
   * so the caller resolves the keys and passes the strings.
   */
  messages: {
    couldNotStartSetup: string;
    invalidCode: string;
    enabled: string;
  };
  /** Console-error prefix identifying the calling flow, e.g. `_auth.twoFactor`. */
  logPrefix: string;
  /**
   * true: after enabling, show the enrollment data on its own step and wait
   * for `saveBackupCodes()` before the code entry (`"setup"` → `"verify"`).
   * false: go straight to `"verify"`, which also carries the enrollment data.
   */
  confirmBackupCodes: boolean;
  /** Runs once the code verified (both flows reload the page). */
  onVerified: () => void;
};

export type TotpEnrollment = ReturnType<typeof useTotpEnrollment>;

/**
 * The whole TOTP enrollment flow for the two `twoFactor.enable` call sites,
 * as one `TotpEnrollmentState` (see `lib/two-factor-state.ts`); the callers
 * only render it. Better Auth 1.7 can resolve `method: "totp"` (URI + backup
 * codes) or `method: "otp"` (immediate email/SMS enablement with no
 * enrollment data); only the `"totp"` discriminant is usable by these flows,
 * and every other outcome is an enrollment error that must not advance the
 * flow.
 */
export function useTotpEnrollment({
  messages,
  logPrefix,
  confirmBackupCodes,
  onVerified,
}: UseTotpEnrollmentOptions) {
  const { state, send, nextAttempt, current } = useGuardedMachine<
    TotpEnrollmentState,
    TotpEnrollmentEvent
  >(initialTotpEnrollmentState, totpEnrollmentTransition);

  const enable = async () => {
    const before = current();
    if (before.kind !== "password") return;
    const attempt = nextAttempt();
    // Rejected while another enable is in flight or the password is empty:
    // one click/Enter, one secret.
    if (!send({ type: "enableStarted", attempt })) return;
    const label = `[${logPrefix}.enable]`;
    const fail = () => {
      // A cancelled or superseded attempt stays silent.
      if (send({ type: "enableFailed", attempt })) toast.error(messages.couldNotStartSetup);
    };
    try {
      const result = await authClient.twoFactor.enable({
        password: before.password,
        // Explicit TOTP: Better Auth 1.7 can also return `{ method: "otp" }`
        // (immediate email/SMS enablement with no URI/codes). Only the
        // "totp" discriminant carries enrollment data these flows can use.
        method: "totp",
      });
      if (result.error) {
        console.error(label, result.error);
        fail();
        return;
      }
      if (result.data?.method !== "totp") {
        // "otp", absent, or unknown discriminants are enrollment errors here.
        console.error(`[${logPrefix}.enable] unexpected method`, result.data?.method);
        fail();
        return;
      }
      send({
        type: "enableSucceeded",
        attempt,
        totpURI: result.data.totpURI,
        backupCodes: result.data.backupCodes,
        confirmBackupCodes,
      });
    } catch (err) {
      console.error(label, err);
      fail();
    }
  };

  const verify = async () => {
    const before = current();
    if (before.kind !== "verify") return;
    const attempt = nextAttempt();
    if (!send({ type: "verifyStarted", attempt })) return;
    const label = `[${logPrefix}.verifyTotp]`;
    const fail = () => {
      if (send({ type: "verifyFailed", attempt })) toast.error(messages.invalidCode);
    };
    try {
      const result = await authClient.twoFactor.verifyTotp({ code: before.code });
      if (result.error) {
        console.error(label, result.error);
        fail();
        return;
      }
      if (!send({ type: "verifySucceeded", attempt })) return;
      toast.success(messages.enabled);
      onVerified();
    } catch (err) {
      console.error(label, err);
      fail();
    }
  };

  return {
    state,
    start: () => send({ type: "start" }),
    cancel: () => send({ type: "cancel" }),
    setPassword: (password: string) => send({ type: "passwordChanged", password }),
    enable,
    saveBackupCodes: () => send({ type: "backupCodesSaved" }),
    setCode: (code: string) => send({ type: "codeChanged", code }),
    verify,
  };
}
