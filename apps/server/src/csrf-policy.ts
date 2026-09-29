/**
 * oRPC procedures (dotted router paths) that require the `x-csrf-token`
 * header even on a same-origin deployment, where the rest of `/rpc` relies on
 * CORS alone. Each one acts on the caller's session cookie and would
 * otherwise accept a headerless cross-origin POST (no preflight) from a
 * same-site sibling origin, whose request still carries the SameSite=Lax
 * cookie.
 *
 * - `cliCredentials.approveDeviceLogin`: binds a `wsmp login` code to the
 *   signed-in account. Better Auth's own `/device/approve`, which it replaces,
 *   refused cross-origin requests.
 */
export const ALWAYS_CSRF_PROTECTED_PROCEDURES: ReadonlySet<string> = new Set([
  "cliCredentials.approveDeviceLogin",
]);
