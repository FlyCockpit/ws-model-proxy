import { describe, expect, it } from "vitest";

import {
  type DisableTwoFactorEvent,
  type DisableTwoFactorState,
  disableTwoFactorTransition,
  initialDisableTwoFactorState,
  initialSignInTwoFactorState,
  initialTotpEnrollmentState,
  type SignInTwoFactorEvent,
  type SignInTwoFactorState,
  signInTwoFactorTransition,
  type TotpEnrollmentEvent,
  type TotpEnrollmentState,
  totpEnrollmentTransition,
} from "./two-factor-state";

function run<S, E>(transition: (s: S, e: E) => S, initial: S, events: E[]): S {
  return events.reduce(transition, initial);
}

const signIn = (events: SignInTwoFactorEvent[], from = initialSignInTwoFactorState) =>
  run<SignInTwoFactorState, SignInTwoFactorEvent>(signInTwoFactorTransition, from, events);

const enrollment = (events: TotpEnrollmentEvent[], from = initialTotpEnrollmentState) =>
  run<TotpEnrollmentState, TotpEnrollmentEvent>(totpEnrollmentTransition, from, events);

const disable = (events: DisableTwoFactorEvent[], from = initialDisableTwoFactorState) =>
  run<DisableTwoFactorState, DisableTwoFactorEvent>(disableTwoFactorTransition, from, events);

describe("signInTwoFactorTransition", () => {
  const challenge = signIn([{ type: "required" }]);
  const withCode = signIn([{ type: "codeChanged", code: "123456" }], challenge);

  it("opens a TOTP challenge with an empty code", () => {
    expect(challenge).toEqual({
      kind: "challenge",
      method: "totp",
      code: "",
      activity: { kind: "idle" },
    });
  });

  it("ignores challenge events while on the password form", () => {
    const state = initialSignInTwoFactorState;
    for (const event of [
      { type: "back" },
      { type: "codeChanged", code: "1" },
      { type: "sendStarted", attempt: 1 },
      { type: "verifyStarted", attempt: 1 },
    ] satisfies SignInTwoFactorEvent[]) {
      expect(signInTwoFactorTransition(state, event)).toBe(state);
    }
  });

  it("switches to email mode and clears the code when a send succeeds", () => {
    const state = signIn(
      [
        { type: "sendStarted", attempt: 1 },
        { type: "sendSucceeded", attempt: 1 },
      ],
      withCode,
    );
    expect(state).toEqual({
      kind: "challenge",
      method: "email",
      code: "",
      activity: { kind: "idle" },
    });
  });

  it("stays in TOTP mode when a send fails", () => {
    const state = signIn(
      [
        { type: "sendStarted", attempt: 1 },
        { type: "sendFailed", attempt: 1 },
      ],
      withCode,
    );
    expect(state).toEqual({ ...withCode, activity: { kind: "idle" } });
  });

  it("bug: Back during an in-flight send, then a late success, does not open the next challenge in email mode", () => {
    const backedOut = signIn([{ type: "sendStarted", attempt: 1 }, { type: "back" }], withCode);
    expect(backedOut).toEqual({ kind: "password" });
    const afterLateSuccess = signIn([{ type: "sendSucceeded", attempt: 1 }], backedOut);
    expect(afterLateSuccess).toBe(backedOut);
    // Even if the late success lands after the user re-entered the challenge.
    const reentered = signIn(
      [{ type: "required" }, { type: "sendSucceeded", attempt: 1 }],
      backedOut,
    );
    expect(reentered).toMatchObject({ method: "totp", activity: { kind: "idle" } });
  });

  it("bug: a stale send completion does not finish a newer send", () => {
    const state = signIn(
      [
        { type: "sendStarted", attempt: 1 },
        { type: "back" },
        { type: "required" },
        { type: "sendStarted", attempt: 2 },
        { type: "sendFailed", attempt: 1 },
      ],
      withCode,
    );
    expect(state).toMatchObject({ activity: { kind: "sending", attempt: 2 } });
  });

  it("bug: verify cannot start while a send is in flight, and vice versa", () => {
    const sending = signIn([{ type: "sendStarted", attempt: 1 }], withCode);
    expect(signInTwoFactorTransition(sending, { type: "verifyStarted", attempt: 2 })).toBe(sending);
    const verifying = signIn([{ type: "verifyStarted", attempt: 1 }], withCode);
    expect(signInTwoFactorTransition(verifying, { type: "sendStarted", attempt: 2 })).toBe(
      verifying,
    );
  });

  it("bug: a second verify (Enter + click) is rejected while one is in flight", () => {
    const verifying = signIn([{ type: "verifyStarted", attempt: 1 }], withCode);
    expect(signInTwoFactorTransition(verifying, { type: "verifyStarted", attempt: 2 })).toBe(
      verifying,
    );
  });

  it("rejects verify without a complete 6-digit code", () => {
    const partial = signIn([{ type: "codeChanged", code: "123" }], challenge);
    expect(signInTwoFactorTransition(partial, { type: "verifyStarted", attempt: 1 })).toBe(partial);
  });

  it("returns to idle after a failed verify and redirects after a successful one", () => {
    const failed = signIn(
      [
        { type: "verifyStarted", attempt: 1 },
        { type: "verifyFailed", attempt: 1 },
      ],
      withCode,
    );
    expect(failed).toEqual(withCode);
    const done = signIn(
      [
        { type: "verifyStarted", attempt: 2 },
        { type: "verifySucceeded", attempt: 2 },
      ],
      withCode,
    );
    expect(done).toMatchObject({ activity: { kind: "redirecting" } });
    expect(signInTwoFactorTransition(done, { type: "verifyStarted", attempt: 3 })).toBe(done);
    expect(signInTwoFactorTransition(done, { type: "sendStarted", attempt: 3 })).toBe(done);
  });

  it("blocks Back while verifying or redirecting", () => {
    const verifying = signIn([{ type: "verifyStarted", attempt: 1 }], withCode);
    expect(signInTwoFactorTransition(verifying, { type: "back" })).toBe(verifying);
    const redirecting = signIn([{ type: "verifySucceeded", attempt: 1 }], verifying);
    expect(signInTwoFactorTransition(redirecting, { type: "back" })).toBe(redirecting);
  });

  it("verifies against the email method after a code was sent", () => {
    const email = signIn(
      [
        { type: "sendStarted", attempt: 1 },
        { type: "sendSucceeded", attempt: 1 },
        { type: "codeChanged", code: "654321" },
        { type: "verifyStarted", attempt: 2 },
      ],
      challenge,
    );
    expect(email).toEqual({
      kind: "challenge",
      method: "email",
      code: "654321",
      activity: { kind: "verifying", attempt: 2 },
    });
  });
});

describe("totpEnrollmentTransition", () => {
  const typed = enrollment([{ type: "start" }, { type: "passwordChanged", password: "pw" }]);
  const enabling = enrollment([{ type: "enableStarted", attempt: 1 }], typed);
  const success = (attempt: number, confirmBackupCodes: boolean): TotpEnrollmentEvent => ({
    type: "enableSucceeded",
    attempt,
    totpURI: "otpauth://totp/x?secret=ABC",
    backupCodes: ["a", "b"],
    confirmBackupCodes,
  });

  it("starts at the password step with an empty password", () => {
    expect(enrollment([{ type: "start" }])).toEqual({
      kind: "password",
      password: "",
      activity: { kind: "idle" },
    });
  });

  it("rejects enable with an empty password", () => {
    const empty = enrollment([{ type: "start" }]);
    expect(totpEnrollmentTransition(empty, { type: "enableStarted", attempt: 1 })).toBe(empty);
  });

  it("bug: a second enable (Enter + click) is rejected while one is in flight", () => {
    expect(totpEnrollmentTransition(enabling, { type: "enableStarted", attempt: 2 })).toBe(
      enabling,
    );
  });

  it("goes to the backup-code step, then verify, when confirming backup codes", () => {
    const setup = enrollment([success(1, true)], enabling);
    expect(setup).toEqual({
      kind: "setup",
      totpURI: "otpauth://totp/x?secret=ABC",
      backupCodes: ["a", "b"],
    });
    expect(enrollment([{ type: "backupCodesSaved" }], setup)).toEqual({
      kind: "verify",
      totpURI: "otpauth://totp/x?secret=ABC",
      backupCodes: ["a", "b"],
      code: "",
      activity: { kind: "idle" },
    });
  });

  it("goes straight to verify (with the enrollment data) otherwise", () => {
    expect(enrollment([success(1, false)], enabling)).toEqual({
      kind: "verify",
      totpURI: "otpauth://totp/x?secret=ABC",
      backupCodes: ["a", "b"],
      code: "",
      activity: { kind: "idle" },
    });
  });

  it("keeps the password and returns to idle activity after a failed enable", () => {
    expect(enrollment([{ type: "enableFailed", attempt: 1 }], enabling)).toEqual(typed);
  });

  it("bug: cancel is refused while an enable is in flight", () => {
    // The server writes a secret for the in-flight enable regardless; a cancel and
    // restart could race two enables and show codes for the overwritten secret.
    expect(totpEnrollmentTransition(enabling, { type: "cancel" })).toBe(enabling);
    expect(enrollment([success(1, true)], enabling)).toMatchObject({ kind: "setup" });
  });

  it("a late completion for an attempt that is no longer in flight is ignored", () => {
    const failed = enrollment([{ type: "enableFailed", attempt: 1 }], enabling);
    expect(totpEnrollmentTransition(failed, success(1, true))).toBe(failed);
  });

  it("bug: cancel clears the typed password", () => {
    const reopened = enrollment([{ type: "cancel" }, { type: "start" }], typed);
    expect(reopened).toMatchObject({ kind: "password", password: "" });
  });

  it("only cancels from the password step", () => {
    const setup = enrollment([success(1, true)], enabling);
    expect(totpEnrollmentTransition(setup, { type: "cancel" })).toBe(setup);
  });

  it("guards verify: full code required, no double submit, done is terminal", () => {
    const verify = enrollment([success(1, false)], enabling);
    expect(totpEnrollmentTransition(verify, { type: "verifyStarted", attempt: 2 })).toBe(verify);
    const verifying = enrollment(
      [
        { type: "codeChanged", code: "123456" },
        { type: "verifyStarted", attempt: 2 },
      ],
      verify,
    );
    expect(verifying).toMatchObject({ activity: { kind: "verifying", attempt: 2 } });
    expect(totpEnrollmentTransition(verifying, { type: "verifyStarted", attempt: 3 })).toBe(
      verifying,
    );
    expect(enrollment([{ type: "verifyFailed", attempt: 2 }], verifying)).toMatchObject({
      code: "123456",
      activity: { kind: "idle" },
    });
    const done = enrollment([{ type: "verifySucceeded", attempt: 2 }], verifying);
    expect(done).toMatchObject({ activity: { kind: "done" } });
    expect(totpEnrollmentTransition(done, { type: "verifyStarted", attempt: 4 })).toBe(done);
  });
});

describe("disableTwoFactorTransition", () => {
  const typed = disable([{ type: "open" }, { type: "passwordChanged", password: "pw" }]);
  const disabling = disable([{ type: "disableStarted", attempt: 1 }], typed);

  it("opens with an empty password and cancels back to closed", () => {
    expect(disable([{ type: "open" }])).toEqual({
      kind: "confirm",
      password: "",
      activity: { kind: "idle" },
    });
    expect(disable([{ type: "cancel" }], typed)).toEqual({ kind: "closed" });
  });

  it("rejects disable with an empty password", () => {
    const empty = disable([{ type: "open" }]);
    expect(disableTwoFactorTransition(empty, { type: "disableStarted", attempt: 1 })).toBe(empty);
  });

  it("bug: a second disable (Enter + click) is rejected while one is in flight", () => {
    expect(disableTwoFactorTransition(disabling, { type: "disableStarted", attempt: 2 })).toBe(
      disabling,
    );
  });

  it("does not cancel while a disable is in flight or done", () => {
    expect(disableTwoFactorTransition(disabling, { type: "cancel" })).toBe(disabling);
    const done = disable([{ type: "disableSucceeded", attempt: 1 }], disabling);
    expect(done).toMatchObject({ activity: { kind: "done" } });
    expect(disableTwoFactorTransition(done, { type: "cancel" })).toBe(done);
  });

  it("returns to idle (keeping the password) after a failure; ignores stale attempts", () => {
    expect(disable([{ type: "disableFailed", attempt: 2 }], disabling)).toBe(disabling);
    expect(disable([{ type: "disableFailed", attempt: 1 }], disabling)).toEqual(typed);
  });
});
