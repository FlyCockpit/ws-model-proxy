import type { ContextCounter } from "./context.js";

export type RuntimeCounterIdentity = {
  runtimeIdentityKey: string;
  runtimeModel: string;
  runtimeRevision?: string | null;
  tokenizer?: string | null;
  tokenizerVersion?: string | null;
  template?: string | null;
  templateVersion?: string | null;
};

function key(identity: RuntimeCounterIdentity) {
  return JSON.stringify([
    identity.runtimeIdentityKey,
    identity.runtimeModel,
    identity.runtimeRevision ?? null,
    identity.tokenizer ?? null,
    identity.tokenizerVersion ?? null,
    identity.template ?? null,
    identity.templateVersion ?? null,
  ]);
}

/** Exact-match registry: a tokenizer/template is never reused across revisions. */
export class ContextCounterRegistry {
  private readonly counters = new Map<string, ContextCounter>();

  register(identity: RuntimeCounterIdentity, counter: ContextCounter): () => void {
    const identityKey = key(identity);
    this.counters.set(identityKey, counter);
    return () => {
      if (this.counters.get(identityKey) === counter) this.counters.delete(identityKey);
    };
  }

  resolve(identity: RuntimeCounterIdentity): ContextCounter | null {
    return this.counters.get(key(identity)) ?? null;
  }
}

/** Process-wide hook point for tokenizer/template implementations loaded by the server runtime. */
export const contextCounterRegistry = new ContextCounterRegistry();
