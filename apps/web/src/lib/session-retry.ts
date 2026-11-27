import {
  identityVerificationGeneration,
  isDocumentIdentityUnverified,
  isDocumentReplaced,
} from "./document-identity";

// One scheduler and one imperative check in flight for the whole document,
// shared by headers, the identity watcher, and manual Retry actions.
const clients = new Map<symbol, () => unknown>();
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight: Promise<boolean> | undefined;
let inFlightGeneration = 0;
let inFlightCancellable = false;
let nativeCheck: { generation: number; promise: Promise<boolean> } | undefined;
let failed = false;
let attempt = 0;
let notBefore = 0;

function available(): boolean {
  return (
    !isDocumentReplaced() && document.visibilityState !== "hidden" && navigator.onLine !== false
  );
}

function cancelTimer(): void {
  clearTimeout(timer);
  timer = undefined;
}

function schedule(): void {
  if (
    !clients.size ||
    (!failed && !isDocumentIdentityUnverified()) ||
    timer !== undefined ||
    inFlight ||
    nativeCheck ||
    !available()
  )
    return;
  const delay = Math.max(
    Math.min(2_000 * 2 ** Math.min(attempt, 5), 60_000),
    notBefore - Date.now(),
  );
  timer = setTimeout(() => {
    timer = undefined;
    const check = clients.values().next().value;
    if (check && available() && (failed || isDocumentIdentityUnverified()))
      void runSessionCheck(check, { automatic: true }).catch(() => {});
  }, delay);
}

/**
 * Coalesces checks; automatic callers respect Retry-After. Cancellation is
 * checked again after waiting and immediately before the callback starts.
 * False means no check ran.
 */
export function runSessionCheck(
  check: () => unknown,
  options: { automatic?: boolean; cancelled?: () => boolean } = {},
): Promise<boolean> {
  const { automatic = false, cancelled } = options;
  if (cancelled?.()) return Promise.resolve(false);
  if (inFlight) {
    // An older request cannot verify a newer invalidation across a remount.
    if (inFlightGeneration !== identityVerificationGeneration()) {
      return inFlight.then(() => runSessionCheck(check, options));
    }
    // A cancelled caller may have reserved the slot before its callback runs.
    // A live caller still needs its own probe if that callback never started.
    return inFlightCancellable
      ? inFlight.then((ran) => (ran ? true : runSessionCheck(check, options)))
      : inFlight;
  }
  if (nativeCheck) {
    // Native refreshes settle only after Better Auth updates its atom. A
    // watcher must await that answer instead of aborting it with refetch().
    if (nativeCheck.generation !== identityVerificationGeneration()) {
      return nativeCheck.promise.then(() => runSessionCheck(check, options));
    }
    return nativeCheck.promise;
  }
  if (isDocumentReplaced()) return Promise.resolve(false);
  if (automatic && Date.now() < notBefore) {
    schedule();
    return Promise.resolve(false);
  }
  cancelTimer();
  inFlightGeneration = identityVerificationGeneration();
  inFlightCancellable = cancelled !== undefined;
  let started = false;
  inFlight = Promise.resolve()
    .then(() => {
      if (cancelled?.()) return false;
      // A burst may invalidate the reserved slot before its callback starts.
      // Joiners must share the generation the actual probe checks.
      inFlightGeneration = identityVerificationGeneration();
      started = true;
      return Promise.resolve(check()).then(() => true);
    })
    .finally(() => {
      inFlight = undefined;
      if (failed && started) attempt++;
      schedule();
    });
  return inFlight;
}

/** Register a native refresh until its atom settles or its request is aborted. */
export function trackNativeSessionCheck(): () => void {
  let finish!: (ran: boolean) => void;
  const current = {
    generation: identityVerificationGeneration(),
    promise: new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  };
  nativeCheck = current;
  cancelTimer();
  return () => {
    if (nativeCheck === current) nativeCheck = undefined;
    finish(true);
    schedule();
  };
}

/** A peer hint joins a native check just as it joins a watcher-owned check. */
export function isNativeSessionCheckPending(): boolean {
  return nativeCheck !== undefined && nativeCheck.generation === identityVerificationGeneration();
}

/** Pending snapshots do not reset backoff; only a settled success/401 does. */
export function observeSessionRetry(error: unknown, pending: boolean): void {
  if (pending) return;
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  failed = error != null && status !== 401;
  if (!failed) {
    attempt = 0;
    notBefore = 0;
    cancelTimer();
  } else {
    schedule();
  }
}

/** Better Fetch exposes the HTTP response before its session atom updates. */
export function recordSessionRetryAfter(response: Response): void {
  if (response.status !== 429) return;
  const header = response.headers.get("Retry-After");
  const seconds = header === null ? Number.NaN : Number(header);
  const until = Number.isFinite(seconds) ? Date.now() + seconds * 1_000 : Date.parse(header ?? "");
  notBefore = Number.isFinite(until) ? Math.max(Date.now(), until) : Date.now() + 60_000;
  cancelTimer();
  schedule();
}

/**
 * Better Auth's native reconnect, storage and mount refreshes bypass the
 * coordinator. Gate their actual request too; cancellation must free the
 * timer because Better Auth aborts a fetch when another one supersedes it.
 */
export async function waitForSessionCooldown(signal?: AbortSignal | null): Promise<void> {
  // A native refresh already deferred by Retry-After remains automatic when
  // the deadline passes. Keep it pending if the document became unavailable.
  const deferred = Date.now() < notBefore;
  while (Date.now() < notBefore || (deferred && !available())) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        window.removeEventListener("online", resumeWhenAvailable);
        window.removeEventListener("focus", resumeWhenAvailable);
        document.removeEventListener("visibilitychange", resumeWhenAvailable);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason);
      };
      const resumeWhenAvailable = () => {
        if (available()) finish();
      };
      if (Date.now() < notBefore) timeout = setTimeout(finish, notBefore - Date.now());
      window.addEventListener("online", resumeWhenAvailable);
      window.addEventListener("focus", resumeWhenAvailable);
      document.addEventListener("visibilitychange", resumeWhenAvailable);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  signal?.throwIfAborted();
}

function resume(): void {
  cancelTimer();
  if ((!failed && !isDocumentIdentityUnverified()) || !available()) return;
  if (Date.now() < notBefore) {
    schedule();
    return;
  }
  const check = clients.values().next().value;
  if (check) void runSessionCheck(check, { automatic: true }).catch(() => {});
}

export function connectSessionRetry(check: () => unknown): () => void {
  const key = Symbol();
  if (!clients.size) {
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    document.addEventListener("visibilitychange", resume);
  }
  clients.set(key, check);
  schedule();
  return () => {
    clients.delete(key);
    if (clients.size) return;
    cancelTimer();
    window.removeEventListener("focus", resume);
    window.removeEventListener("online", resume);
    window.removeEventListener("offline", resume);
    document.removeEventListener("visibilitychange", resume);
  };
}

export function resetSessionRetryForTests(): void {
  cancelTimer();
  clients.clear();
  inFlight = undefined;
  nativeCheck = undefined;
  failed = false;
  attempt = 0;
  notBefore = 0;
}
