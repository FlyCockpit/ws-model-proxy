export type PendingHandshakeRef = {
  localId: string;
  terminalId: string;
};

/**
 * Match a handshake reply only to the pending entry whose terminal id equals
 * the reply. Do not fall back to the only pending entry, and delete the key
 * that actually holds the match.
 */
export function takePendingByTerminalId<T extends PendingHandshakeRef>(
  pending: Map<string, T>,
  terminalId: string,
): T | null {
  if (terminalId.length === 0) return null;
  for (const [key, value] of pending) {
    if (value.terminalId !== terminalId) continue;
    pending.delete(key);
    return value;
  }
  return null;
}
