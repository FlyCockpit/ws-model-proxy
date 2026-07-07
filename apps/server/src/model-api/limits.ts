import type { RelayFailure } from "../relay/protocol.js";

export const MODEL_API_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
export const MODEL_API_RELAY_TIMEOUT_MS = 15 * 60 * 1000;
const MODEL_API_MAX_ACTIVE_PER_TOKEN = 8;
const MODEL_API_MAX_ACTIVE_PER_CLI = 16;
const MODEL_API_MAX_ACTIVE_PER_USER = 32;

export class ModelApiLimitError extends Error {
  readonly failure: RelayFailure = "rate_limited";

  constructor(message: string) {
    super(message);
    this.name = "ModelApiLimitError";
  }
}

export type ModelApiLimitLease = {
  release(): void;
};

export class ModelApiConcurrencyLimiter {
  private activeByTokenId = new Map<string, number>();
  private activeByCliDeviceId = new Map<string, number>();
  private activeByUserId = new Map<string, number>();

  acquireGlobal({ tokenId, userId }: { tokenId: string; userId: string }): ModelApiLimitLease {
    this.assertBelowLimit(this.activeByTokenId, tokenId, MODEL_API_MAX_ACTIVE_PER_TOKEN);
    this.assertBelowLimit(this.activeByUserId, userId, MODEL_API_MAX_ACTIVE_PER_USER);
    this.increment(this.activeByTokenId, tokenId);
    this.increment(this.activeByUserId, userId);

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.decrement(this.activeByTokenId, tokenId);
        this.decrement(this.activeByUserId, userId);
      },
    };
  }

  acquireCli(cliDeviceId: string): ModelApiLimitLease {
    this.assertBelowLimit(this.activeByCliDeviceId, cliDeviceId, MODEL_API_MAX_ACTIVE_PER_CLI);
    this.increment(this.activeByCliDeviceId, cliDeviceId);

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.decrement(this.activeByCliDeviceId, cliDeviceId);
      },
    };
  }

  private assertBelowLimit(map: Map<string, number>, key: string, limit: number) {
    if ((map.get(key) ?? 0) >= limit) {
      throw new ModelApiLimitError("Too many active model API requests.");
    }
  }

  private increment(map: Map<string, number>, key: string) {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  private decrement(map: Map<string, number>, key: string) {
    const next = (map.get(key) ?? 0) - 1;
    if (next <= 0) {
      map.delete(key);
      return;
    }
    map.set(key, next);
  }
}

export const modelApiConcurrencyLimiter = new ModelApiConcurrencyLimiter();
