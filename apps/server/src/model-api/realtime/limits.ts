/**
 * Live transcription session caps (design §3, D6), separate from the HTTP
 * `ModelApiConcurrencyLimiter` so long sessions cannot use up a token's HTTP
 * budget. Acquired before the upgrade (and so before `createSttSession`);
 * released exactly once when the session ends. Never fails open.
 */
export const REALTIME_STT_SESSIONS_PER_TOKEN = 4;
export const REALTIME_STT_SESSIONS_PER_USER = 8;
export const REALTIME_STT_SESSIONS_SERVER_MAX = 256;

export type RealtimeAdmission = { release(): void };

export type RealtimeAdmissionResult =
  | { ok: true; admission: RealtimeAdmission }
  | { ok: false; scope: "token" | "user" | "server" };

export class RealtimeSessionCounters {
  private readonly byToken = new Map<string, number>();
  private readonly byUser = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly caps = {
      perToken: REALTIME_STT_SESSIONS_PER_TOKEN,
      perUser: REALTIME_STT_SESSIONS_PER_USER,
      server: REALTIME_STT_SESSIONS_SERVER_MAX,
    },
  ) {}

  acquire({ tokenId, userId }: { tokenId: string; userId: string }): RealtimeAdmissionResult {
    if (this.total >= this.caps.server) return { ok: false, scope: "server" };
    if ((this.byToken.get(tokenId) ?? 0) >= this.caps.perToken)
      return { ok: false, scope: "token" };
    if ((this.byUser.get(userId) ?? 0) >= this.caps.perUser) return { ok: false, scope: "user" };
    this.total += 1;
    this.byToken.set(tokenId, (this.byToken.get(tokenId) ?? 0) + 1);
    this.byUser.set(userId, (this.byUser.get(userId) ?? 0) + 1);
    let released = false;
    return {
      ok: true,
      admission: {
        release: () => {
          if (released) return;
          released = true;
          this.total -= 1;
          decrement(this.byToken, tokenId);
          decrement(this.byUser, userId);
        },
      },
    };
  }

  /** Live sessions of a token, user, or the server (tests and diagnostics). */
  count(scope: { tokenId: string } | { userId: string } | "server"): number {
    if (scope === "server") return this.total;
    if ("tokenId" in scope) return this.byToken.get(scope.tokenId) ?? 0;
    return this.byUser.get(scope.userId) ?? 0;
  }
}

function decrement(map: Map<string, number>, key: string) {
  const next = (map.get(key) ?? 0) - 1;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

export const realtimeSessionCounters = new RealtimeSessionCounters();
