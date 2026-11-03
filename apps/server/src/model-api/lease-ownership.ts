/**
 * Who is responsible for releasing a lease.
 * - `owned`: this holder must release it.
 * - `transferred`: handed to another holder, which now releases it; never released here.
 * - `released`: already released here.
 */
export type LeaseOwnershipState = "owned" | "transferred" | "released";

export type LeaseOwnership<R> = {
  readonly state: LeaseOwnershipState;
  /** Releases an owned lease exactly once; a no-op once released or transferred. */
  release(): R | undefined;
  /**
   * Hands an owned lease to another holder. Returns false (and changes nothing) when the
   * lease is no longer owned here, so a released lease is never handed on.
   */
  transfer(): boolean;
};

export function leaseOwnership<R>(releaseLease: () => R): LeaseOwnership<R> {
  let state: LeaseOwnershipState = "owned";
  return {
    get state() {
      return state;
    },
    release() {
      switch (state) {
        case "owned":
          state = "released";
          return releaseLease();
        case "transferred":
          // The new holder owns the release.
          return undefined;
        case "released":
          return undefined;
      }
    },
    transfer() {
      if (state !== "owned") return false;
      state = "transferred";
      return true;
    },
  };
}
