/**
 * Stored Responses (docs/external-fallback.md, "Stored responses"): only a response created
 * with `store: true` on a model that stores responses natively (RESPONSES_API) is kept, as its
 * routing, for 7 days. Anything else, a request translated for a model without stored
 * responses included, was never stored, and GET/DELETE of its id says so rather than
 * "expired".
 */
/**
 * A Responses create with `store: true` that no member can store: say why, so the caller knows
 * to drop `store` (the response is then not retrievable later).
 */
export function unsupportedCapabilityMessage(operation: {
  family: string;
  responseStickiness?: unknown;
}): string | undefined {
  return operation.family === "responses" && operation.responseStickiness
    ? '"store": true needs a model that stores responses natively, and this one does not. Send the request without store; it is then not stored and cannot be retrieved later.'
    : undefined;
}

/**
 * Why GET/DELETE of a response id cannot be served from what this proxy stored, as the
 * caller's message, or null when the stored routing is usable.
 */
export function storedResponseUnavailable(
  record: {
    userId: string;
    apiKeyId: string | null;
    selectedTargetId: string | null;
    expiresAt: Date | null;
  } | null,
  requester: { userId: string; apiKeyId: string | null },
  now: Date,
): string | null {
  if (
    !record ||
    record.userId !== requester.userId ||
    record.apiKeyId !== requester.apiKeyId ||
    !record.selectedTargetId
  )
    return RESPONSE_NOT_STORED_MESSAGE;
  if (record.expiresAt !== null && record.expiresAt <= now) return RESPONSE_EXPIRED_MESSAGE;
  return null;
}

/** GET/DELETE of a response id this proxy never stored (for this API key). */
export const RESPONSE_NOT_STORED_MESSAGE =
  'This response was not stored, or not with this API key. Responses are kept only when created with "store": true on a model that stores responses natively; others cannot be retrieved or deleted.';
/** GET/DELETE of a stored response whose routing is past its retention. */
const RESPONSE_EXPIRED_MESSAGE =
  "This stored response has expired: the proxy keeps a stored response's routing for 7 days.";
