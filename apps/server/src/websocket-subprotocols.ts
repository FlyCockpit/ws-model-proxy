import { REALTIME_PATH, REALTIME_SUBPROTOCOL } from "./model-api/realtime/constants.js";
import { RELAY_SUBPROTOCOL } from "./relay/protocol.js";

/**
 * The shared upgrade server's subprotocol choice, by path (design §2):
 * - `/api/cli/ws` selects the relay protocol;
 * - `/v1/realtime` selects `realtime` when offered. A browser also offers
 *   `openai-insecure-api-key.<token>` as its credential; that one is never
 *   selected, so the key is never echoed back;
 * - everything else selects none.
 */
export function selectWebSocketSubprotocol(
  protocols: ReadonlySet<string>,
  requestUrl: string | undefined,
): string | false {
  const path = (requestUrl ?? "").split("?")[0];
  if (path === "/api/cli/ws") return protocols.has(RELAY_SUBPROTOCOL) ? RELAY_SUBPROTOCOL : false;
  if (path === REALTIME_PATH)
    return protocols.has(REALTIME_SUBPROTOCOL) ? REALTIME_SUBPROTOCOL : false;
  return false;
}
