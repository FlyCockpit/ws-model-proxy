/**
 * OpenRouter privacy routing (fallback redesign decision D9).
 *
 * Requests WMP sends to an OpenRouter account carry OpenRouter's
 * provider-routing preference `provider: { data_collection: "deny" }` unless
 * the account owner turned on "Allow OpenRouter providers that may collect
 * data" (`ProviderAccount.allowDataCollection`). OpenRouter then routes only
 * to upstream providers that do not store or train on prompts.
 *
 * The rule applies to every body sent to such an account: owner-paid pool
 * fallback and a grantee's own key alike, native pass-through and adapted
 * renders alike. Other provider types never get the field.
 */

import { isOpenRouterProviderType } from "@ws-model-proxy/api/lib/provider-type";
import { openAiErrorBody } from "./openai-errors.js";

/** The value WMP forces into `provider.data_collection`, or null to leave the body alone. */
export type OpenRouterDataCollectionPolicy = "deny" | null;

/**
 * The policy for one provider account. Only `openrouter` accounts are
 * affected; the opt-out leaves the body as the caller or adapter rendered it.
 */
export function openRouterDataCollectionPolicy(account: {
  providerType: string;
  allowDataCollection: boolean;
}): OpenRouterDataCollectionPolicy {
  if (!isOpenRouterProviderType(account.providerType)) return null;
  return account.allowDataCollection ? null : "deny";
}

/** Thrown when a body that must carry the privacy preference cannot be rewritten. */
export class OpenRouterPrivacyRenderError extends Error {
  constructor() {
    super("OpenRouter request body is not a JSON object");
    this.name = "OpenRouterPrivacyRenderError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Set `provider.data_collection` on a rendered JSON request body.
 *
 * Merge rule: an existing `provider` object keeps every other key (`order`,
 * `only`, `ignore`, ...), but `data_collection` is always overwritten, so a
 * caller's `"allow"` can never relax the account's policy. A `provider` value
 * that is not an object is replaced. An empty body (no prompt) is returned
 * unchanged. Anything else that is not a JSON object fails closed: the caller
 * must not send it.
 */
export function applyOpenRouterDataCollection(
  body: Uint8Array,
  policy: OpenRouterDataCollectionPolicy,
): Uint8Array {
  if (policy === null || body.byteLength === 0) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new OpenRouterPrivacyRenderError();
  }
  if (!isPlainObject(parsed)) throw new OpenRouterPrivacyRenderError();
  const provider = isPlainObject(parsed.provider) ? parsed.provider : {};
  parsed.provider = { ...provider, data_collection: policy };
  return new TextEncoder().encode(JSON.stringify(parsed));
}

/** Largest OpenRouter error body inspected for the data-policy mapping. */
export const OPENROUTER_ERROR_INSPECT_MAX_BYTES = 64 * 1024;

/**
 * OpenRouter answers 404 "No endpoints found matching your data policy ..."
 * when no upstream provider of the model satisfies the privacy preference.
 * Checked against docs and public reports, not live.
 */
export function isOpenRouterDataPolicyRefusal(status: number, bodyText: string): boolean {
  if (status !== 404) return false;
  return /data polic(?:y|ies)/iu.test(bodyText);
}

/** Stable machine code for the mapped refusal. */
export const OPENROUTER_DATA_POLICY_ERROR_CODE = "provider_data_policy_unavailable";

/** Client-facing reason for the mapped refusal (every surface uses this text). */
export const OPENROUTER_DATA_POLICY_ERROR_MESSAGE =
  'No OpenRouter provider for this model accepts the data policy data_collection: "deny". The OpenRouter account allows only providers that do not store or train on prompts. Choose another model, or allow providers that may collect data in the provider account settings.';

/**
 * The clear 503 WMP returns instead of OpenRouter's bare 404. The HTTP route
 * layer re-renders it in the requested surface's error shape (it never
 * forwards non-success provider bodies), keyed on the typed `refused` flag of
 * {@link mapOpenRouterDataPolicyRefusal}, never on anything in this body.
 */
export function openRouterDataPolicyResponse(): Response {
  return new Response(
    JSON.stringify(
      openAiErrorBody({
        message: OPENROUTER_DATA_POLICY_ERROR_MESSAGE,
        type: "server_error",
        code: OPENROUTER_DATA_POLICY_ERROR_CODE,
      }),
    ),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

/**
 * Map OpenRouter's data-policy 404 to {@link openRouterDataPolicyResponse}
 * (`refused: true`). Other responses pass through unchanged (`refused:
 * false`): the inspected prefix (at most {@link OPENROUTER_ERROR_INSPECT_MAX_BYTES})
 * is replayed ahead of the rest of the body, so nothing is lost or reordered.
 * Reading the body drives the dispatcher's settlement exactly as a client
 * read would. `refused` is an in-process signal only: a provider cannot set
 * it through a header or body field.
 */
export async function mapOpenRouterDataPolicyRefusal(
  response: Response,
): Promise<{ response: Response; refused: boolean }> {
  if (response.status !== 404 || response.body === null) return { response, refused: false };
  const reader = response.body.getReader();
  const prefix: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  // A read failure is replayed to the client after the prefix, exactly where
  // the unmapped body would have failed.
  let failure: { error: unknown } | undefined;
  try {
    while (bytes <= OPENROUTER_ERROR_INSPECT_MAX_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        break;
      }
      prefix.push(chunk.value);
      bytes += chunk.value.byteLength;
    }
  } catch (error) {
    failure = { error };
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of prefix) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (done && isOpenRouterDataPolicyRefusal(response.status, new TextDecoder().decode(merged)))
    return { response: openRouterDataPolicyResponse(), refused: true };
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      if (merged.byteLength > 0) controller.enqueue(merged);
      if (failure) controller.error(failure.error);
      else if (done) controller.close();
    },
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return {
    response: new Response(replay, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    refused: false,
  };
}
