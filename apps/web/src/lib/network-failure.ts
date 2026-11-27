/**
 * Classify a failure as "the network did it" so the UI can say what to do
 * ("You're offline…") instead of the generic "Something went wrong". See
 * docs/ui.md § Offline and network failures.
 *
 * `navigator.onLine === false` is reliable; `true` only means "a network
 * interface is up", so an online fetch TypeError is reported as "couldn't
 * reach the server", never as offline.
 */

/** Messages browsers use for a fetch that never got a response. */
const FETCH_FAILURE = [
  /^Failed to fetch(?! dynamically)/, // Chromium
  /^NetworkError when attempting to fetch resource/, // Firefox
  /^Load failed$/, // Safari
  /^The network connection was lost/, // Safari
  /^Network request failed/, // polyfills, React Native
];

export function isBrowserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function messageOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("message" in error)) return undefined;
  return typeof error.message === "string" ? error.message : undefined;
}

/** Walk `cause` a few levels: a wrapper (oRPC, a loader) may carry the fetch error. */
function matchesChain(error: unknown, patterns: readonly RegExp[]): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const message = messageOf(current);
    if (message && patterns.some((pattern) => pattern.test(message))) return true;
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

export function isFetchFailure(error: unknown): boolean {
  return matchesChain(error, FETCH_FAILURE);
}
