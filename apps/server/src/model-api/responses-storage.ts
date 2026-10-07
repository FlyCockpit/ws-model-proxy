/**
 * Stored Responses (docs/external-fallback.md, "Stored responses"): only a response created
 * with `store: true` on a model that stores responses natively (RESPONSES_API) is kept, as its
 * routing, for 7 days (a follow-up's routing is kept too, so the chain continues). Anything
 * else, a request translated for a model without stored responses included, was never stored,
 * and GET/DELETE of its id says so rather than "expired". Expired routing is pruned hourly,
 * after which the answer is the not-stored one.
 */
/**
 * A pool's Responses create with `store: true` (not a follow-up) that no member can take: a
 * member reached by translation (no native Responses) cannot store it, so say so.
 */
export function unsupportedCapabilityMessage(operation: {
  family: string;
  contextInput?: unknown;
}): string | undefined {
  const body = operation.contextInput;
  if (operation.family !== "responses" || typeof body !== "object" || body === null)
    return undefined;
  const request = body as { store?: unknown; previous_response_id?: unknown };
  return request.store === true && request.previous_response_id === undefined
    ? 'No member of this pool can take this request. "store": true needs a model that stores responses natively, so a member reached by translation cannot store it; without store the response is not stored and cannot be retrieved later.'
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

/** GET/DELETE of a response id this proxy keeps no routing for (for this API key). */
export const RESPONSE_NOT_STORED_MESSAGE =
  'This response is not stored here for this API key. Responses are kept only when created with "store": true on a model that stores responses natively, and for 7 days; others cannot be retrieved or deleted.';
/** GET/DELETE of a stored response whose routing is past its retention. */
const RESPONSE_EXPIRED_MESSAGE =
  "This stored response has expired: the proxy keeps a stored response's routing for 7 days.";
