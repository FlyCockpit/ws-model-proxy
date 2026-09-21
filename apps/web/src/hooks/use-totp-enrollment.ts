import { toast } from "@ws-model-proxy/ui/components/sileo";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

type UseTotpEnrollmentOptions = {
  /**
   * Pre-translated "could not start setup" message. The two enrollment flows
   * (`_auth.tsx` forced setup and `settings/security.tsx`) live in different
   * locale namespaces, so the caller resolves the key and passes the string.
   */
  couldNotStartSetupMessage: string;
  /** Console-error prefix identifying the calling flow in logs. */
  logLabel: string;
  /**
   * Runs only after a `"totp"` result has been stored. The flows advance to
   * different steps (`"verify"` vs `"setup"`), so the step transition stays
   * with the caller; everything else about enrollment lives here.
   */
  onEnabled: () => void;
};

/**
 * Shared TOTP enrollment state for the two `twoFactor.enable` call sites.
 * Better Auth 1.7 can resolve `method: "totp"` (URI + backup codes) or
 * `method: "otp"` (immediate email/SMS enablement with no enrollment data);
 * only the `"totp"` discriminant is usable by these flows, and every other
 * outcome is an enrollment error that must not advance any flow state.
 */
export function useTotpEnrollment({
  couldNotStartSetupMessage,
  logLabel,
  onEnabled,
}: UseTotpEnrollmentOptions) {
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const enable = async () => {
    setIsLoading(true);
    try {
      const result = await authClient.twoFactor.enable({
        password,
        // Explicit TOTP: Better Auth 1.7 can also return `{ method: "otp" }`
        // (immediate email/SMS enablement with no URI/codes). Only the
        // "totp" discriminant carries enrollment data these flows can use.
        method: "totp",
      });
      if (result.error) {
        console.error(`[${logLabel}]`, result.error);
        toast.error(couldNotStartSetupMessage);
        return;
      }
      if (result.data?.method !== "totp") {
        // "otp", absent, or unknown discriminants are enrollment errors here.
        console.error(`[${logLabel}] unexpected method`, result.data?.method);
        toast.error(couldNotStartSetupMessage);
        return;
      }
      setTotpURI(result.data.totpURI);
      setBackupCodes(result.data.backupCodes);
      onEnabled();
    } catch (err) {
      console.error(`[${logLabel}]`, err);
      toast.error(couldNotStartSetupMessage);
    } finally {
      setIsLoading(false);
    }
  };

  return { password, setPassword, totpURI, backupCodes, isLoading, enable };
}
