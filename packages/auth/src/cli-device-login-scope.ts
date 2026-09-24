import { cliSlugFromDeviceLoginScope } from "@ws-model-proxy/config/cli-device-login";
import { APIError } from "better-auth/api";

/**
 * `onDeviceAuthRequest` for the deviceAuthorization plugin. `wsmp login` is the
 * only device-flow client and every request must name exactly one CLI slug
 * (`scope = "cli-slug:<slug>"`), so the approval page can show what approving
 * authorizes and the exchange can mint for that slug only.
 */
export function requireCliDeviceLoginScope(_clientId: string, scope: string | undefined): void {
  if (cliSlugFromDeviceLoginScope(scope) !== null) return;
  throw new APIError("BAD_REQUEST", {
    error: "invalid_scope",
    error_description:
      "Device authorization must name one CLI slug as `cli-slug:<slug>`; upgrade wsmp.",
  });
}

/**
 * Better Auth paths turned off with `disabledPaths` (404 before any handler
 * runs). `/device/token` would redeem an approved `wsmp login` code for a full
 * browser session (Better Auth's RFC 8628 token endpoint), which is not what
 * the approval page describes. The only redemption is
 * `cliCredentials.exchangeDeviceCode`, which mints the one device credential
 * the approver saw.
 */
export const DISABLED_DEVICE_AUTHORIZATION_PATHS: readonly string[] = ["/device/token"];
