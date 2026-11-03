/**
 * Pure state machines for the three two-factor UI flows:
 *
 * - the sign-in 2FA challenge (`components/auth/sign-in-card.tsx`),
 * - TOTP enrollment (`hooks/use-totp-enrollment.ts`, rendered by
 *   `settings/security.tsx` and the forced-setup screen in `_auth.tsx`),
 * - disabling 2FA (`settings/security.tsx`).
 *
 * Each flow is one discriminated union plus a transition function. A
 * transition that does not apply returns the SAME state object, so a caller
 * can tell an accepted event from a rejected one by identity (see
 * `useGuardedMachine`). Every async operation carries an `attempt` id: its
 * completion event applies only while the state still shows that exact
 * attempt in flight, so a completion that arrives after Back/Cancel (or after
 * a newer attempt started) is dropped instead of moving the flow.
 */

export const TWO_FACTOR_CODE_LENGTH = 6;

function isCompleteCode(code: string): boolean {
  return code.length === TWO_FACTOR_CODE_LENGTH;
}

// ---------------------------------------------------------------------------
// Sign-in 2FA challenge
// ---------------------------------------------------------------------------

/** Which endpoint verifies the code: the authenticator app, or an emailed OTP. */
export type TwoFactorMethod = "totp" | "email";

export type ChallengeActivity =
  | { kind: "idle" }
  | { kind: "sending"; attempt: number }
  | { kind: "verifying"; attempt: number }
  /** Verified; the page is navigating away. Nothing else may start. */
  | { kind: "redirecting" };

export type SignInTwoFactorState =
  | { kind: "password" }
  | {
      kind: "challenge";
      method: TwoFactorMethod;
      code: string;
      activity: ChallengeActivity;
    };

export type SignInTwoFactorEvent =
  | { type: "required" }
  | { type: "back" }
  | { type: "codeChanged"; code: string }
  | { type: "sendStarted"; attempt: number }
  | { type: "sendSucceeded"; attempt: number }
  | { type: "sendFailed"; attempt: number }
  | { type: "verifyStarted"; attempt: number }
  | { type: "verifySucceeded"; attempt: number }
  | { type: "verifyFailed"; attempt: number };

export const initialSignInTwoFactorState: SignInTwoFactorState = { kind: "password" };

function isAttempt(
  activity: ChallengeActivity,
  kind: "sending" | "verifying",
  attempt: number,
): boolean {
  return activity.kind === kind && activity.attempt === attempt;
}

export function signInTwoFactorTransition(
  state: SignInTwoFactorState,
  event: SignInTwoFactorEvent,
): SignInTwoFactorState {
  if (state.kind === "password") {
    if (event.type === "required") {
      return { kind: "challenge", method: "totp", code: "", activity: { kind: "idle" } };
    }
    return state;
  }

  const { activity } = state;
  switch (event.type) {
    case "required":
      return state;
    case "back":
      // A verify in flight may already have minted the session, and a
      // redirect is underway: leaving then would strand a signed-in user on
      // the password form. A pending email send is safe to abandon.
      if (activity.kind === "verifying" || activity.kind === "redirecting") return state;
      return initialSignInTwoFactorState;
    case "codeChanged":
      return { ...state, code: event.code };
    case "sendStarted":
      if (activity.kind !== "idle") return state;
      return { ...state, activity: { kind: "sending", attempt: event.attempt } };
    case "sendSucceeded":
      if (!isAttempt(activity, "sending", event.attempt)) return state;
      return { ...state, method: "email", code: "", activity: { kind: "idle" } };
    case "sendFailed":
      if (!isAttempt(activity, "sending", event.attempt)) return state;
      return { ...state, activity: { kind: "idle" } };
    case "verifyStarted":
      if (activity.kind !== "idle" || !isCompleteCode(state.code)) return state;
      return { ...state, activity: { kind: "verifying", attempt: event.attempt } };
    case "verifySucceeded":
      if (!isAttempt(activity, "verifying", event.attempt)) return state;
      return { ...state, activity: { kind: "redirecting" } };
    case "verifyFailed":
      if (!isAttempt(activity, "verifying", event.attempt)) return state;
      return { ...state, activity: { kind: "idle" } };
  }
}

// ---------------------------------------------------------------------------
// TOTP enrollment
// ---------------------------------------------------------------------------

export type EnrollmentPasswordActivity = { kind: "idle" } | { kind: "enabling"; attempt: number };

export type EnrollmentVerifyActivity =
  | { kind: "idle" }
  | { kind: "verifying"; attempt: number }
  /** Verified; the page is reloading. Nothing else may start. */
  | { kind: "done" };

export type TotpEnrollmentState =
  | { kind: "idle" }
  | { kind: "password"; password: string; activity: EnrollmentPasswordActivity }
  /** Enrollment data shown; waiting for the user to confirm they saved the backup codes. */
  | { kind: "setup"; totpURI: string; backupCodes: string[] }
  | {
      kind: "verify";
      totpURI: string;
      backupCodes: string[];
      code: string;
      activity: EnrollmentVerifyActivity;
    };

export type TotpEnrollmentEvent =
  | { type: "start" }
  | { type: "cancel" }
  | { type: "passwordChanged"; password: string }
  | { type: "enableStarted"; attempt: number }
  | {
      type: "enableSucceeded";
      attempt: number;
      totpURI: string;
      backupCodes: string[];
      /** true: show a "saved my backup codes" step before the code entry. */
      confirmBackupCodes: boolean;
    }
  | { type: "enableFailed"; attempt: number }
  | { type: "backupCodesSaved" }
  | { type: "codeChanged"; code: string }
  | { type: "verifyStarted"; attempt: number }
  | { type: "verifySucceeded"; attempt: number }
  | { type: "verifyFailed"; attempt: number };

export const initialTotpEnrollmentState: TotpEnrollmentState = { kind: "idle" };

function isEnabling(state: TotpEnrollmentState, attempt: number): boolean {
  return (
    state.kind === "password" &&
    state.activity.kind === "enabling" &&
    state.activity.attempt === attempt
  );
}

function isVerifyingEnrollment(state: TotpEnrollmentState, attempt: number): boolean {
  return (
    state.kind === "verify" &&
    state.activity.kind === "verifying" &&
    state.activity.attempt === attempt
  );
}

export function totpEnrollmentTransition(
  state: TotpEnrollmentState,
  event: TotpEnrollmentEvent,
): TotpEnrollmentState {
  switch (event.type) {
    case "start":
      if (state.kind !== "idle") return state;
      return { kind: "password", password: "", activity: { kind: "idle" } };
    case "cancel":
      // Cancelling drops the typed password and any in-flight enable: its
      // completion no longer matches and is ignored.
      if (state.kind !== "password") return state;
      return initialTotpEnrollmentState;
    case "passwordChanged":
      if (state.kind !== "password") return state;
      return { ...state, password: event.password };
    case "enableStarted":
      if (state.kind !== "password" || state.activity.kind !== "idle" || !state.password) {
        return state;
      }
      return { ...state, activity: { kind: "enabling", attempt: event.attempt } };
    case "enableSucceeded":
      if (!isEnabling(state, event.attempt)) return state;
      if (event.confirmBackupCodes) {
        return { kind: "setup", totpURI: event.totpURI, backupCodes: event.backupCodes };
      }
      return {
        kind: "verify",
        totpURI: event.totpURI,
        backupCodes: event.backupCodes,
        code: "",
        activity: { kind: "idle" },
      };
    case "enableFailed":
      if (state.kind !== "password" || !isEnabling(state, event.attempt)) return state;
      return { ...state, activity: { kind: "idle" } };
    case "backupCodesSaved":
      if (state.kind !== "setup") return state;
      return { ...state, kind: "verify", code: "", activity: { kind: "idle" } };
    case "codeChanged":
      if (state.kind !== "verify") return state;
      return { ...state, code: event.code };
    case "verifyStarted":
      if (
        state.kind !== "verify" ||
        state.activity.kind !== "idle" ||
        !isCompleteCode(state.code)
      ) {
        return state;
      }
      return { ...state, activity: { kind: "verifying", attempt: event.attempt } };
    case "verifySucceeded":
      if (state.kind !== "verify" || !isVerifyingEnrollment(state, event.attempt)) return state;
      return { ...state, activity: { kind: "done" } };
    case "verifyFailed":
      if (state.kind !== "verify" || !isVerifyingEnrollment(state, event.attempt)) return state;
      return { ...state, activity: { kind: "idle" } };
  }
}

// ---------------------------------------------------------------------------
// Disable 2FA
// ---------------------------------------------------------------------------

export type DisableTwoFactorActivity =
  | { kind: "idle" }
  | { kind: "disabling"; attempt: number }
  /** Disabled; the page is reloading. Nothing else may start. */
  | { kind: "done" };

export type DisableTwoFactorState =
  | { kind: "closed" }
  | { kind: "confirm"; password: string; activity: DisableTwoFactorActivity };

export type DisableTwoFactorEvent =
  | { type: "open" }
  | { type: "cancel" }
  | { type: "passwordChanged"; password: string }
  | { type: "disableStarted"; attempt: number }
  | { type: "disableSucceeded"; attempt: number }
  | { type: "disableFailed"; attempt: number };

export const initialDisableTwoFactorState: DisableTwoFactorState = { kind: "closed" };

function isDisabling(state: DisableTwoFactorState, attempt: number): boolean {
  return (
    state.kind === "confirm" &&
    state.activity.kind === "disabling" &&
    state.activity.attempt === attempt
  );
}

export function disableTwoFactorTransition(
  state: DisableTwoFactorState,
  event: DisableTwoFactorEvent,
): DisableTwoFactorState {
  switch (event.type) {
    case "open":
      if (state.kind !== "closed") return state;
      return { kind: "confirm", password: "", activity: { kind: "idle" } };
    case "cancel":
      // A disable in flight cannot be taken back server-side, so the flow
      // stays put until it settles (success reloads the page).
      if (state.kind !== "confirm" || state.activity.kind !== "idle") return state;
      return initialDisableTwoFactorState;
    case "passwordChanged":
      if (state.kind !== "confirm") return state;
      return { ...state, password: event.password };
    case "disableStarted":
      if (state.kind !== "confirm" || state.activity.kind !== "idle" || !state.password) {
        return state;
      }
      return { ...state, activity: { kind: "disabling", attempt: event.attempt } };
    case "disableSucceeded":
      if (state.kind !== "confirm" || !isDisabling(state, event.attempt)) return state;
      return { ...state, activity: { kind: "done" } };
    case "disableFailed":
      if (state.kind !== "confirm" || !isDisabling(state, event.attempt)) return state;
      return { ...state, activity: { kind: "idle" } };
  }
}
