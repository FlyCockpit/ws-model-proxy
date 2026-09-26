/**
 * OpenRouter public model catalog: a keyless outbound fetch with hard limits
 * and an in-process cache.
 *
 * - The fetch never carries a key, cookie, or any user/request data: it is a
 *   fixed GET to a fixed public URL through `providerHttpsRequest` in the
 *   `NONE`/`UNAUTHENTICATED_PROBE` auth mode (SSRF-checked DNS, no redirects).
 * - Limits: 4 MB body, 10 s overall deadline (connect + headers + body), zod
 *   validation with unknown fields dropped.
 * - Cache: fresh for 15 min; after a failed refresh the last good copy is
 *   served as stale for up to 6 h more; one refresh at a time (single flight);
 *   a failed refresh is not retried for 30 s so callers cannot hammer the host.
 * - The deployment switch `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` is read on every
 *   call. Off means no fetch and a stable `disabled` result (cached data is not
 *   served either).
 *
 * Ownership: the cache state below is owned by one `createProviderCatalog`
 * instance and only mutated inside `refresh` (success) or its catch (failure);
 * JavaScript's single thread makes each mutation atomic. `inflight` is the only
 * coordination point: callers that find it set await the same promise.
 */
import type { IncomingMessage } from "node:http";
import { type CatalogModel, parseCatalog } from "./provider-catalog-model";
import { providerHttpsRequest } from "./provider-egress";

export const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1/models";
export const CATALOG_MAX_BYTES = 4 * 1024 * 1024;
export const CATALOG_TIMEOUT_MS = 10_000;
export const CATALOG_TTL_MS = 15 * 60_000;
export const CATALOG_STALE_IF_ERROR_MS = 6 * 60 * 60_000;
export const CATALOG_FAILURE_BACKOFF_MS = 30_000;

export const CATALOG_DISABLED_REASON = "EXTERNAL_PROVIDERS_DISABLED";
export const CATALOG_UNAVAILABLE_REASON = "CATALOG_UNAVAILABLE";

export class ProviderCatalogFetchError extends Error {
  constructor() {
    super("Provider catalog request failed");
    this.name = "ProviderCatalogFetchError";
  }
}

export type ProviderCatalogResult =
  | {
      status: "ok";
      models: readonly CatalogModel[];
      fetchedAt: Date;
      stale: boolean;
    }
  | { status: "disabled"; reason: typeof CATALOG_DISABLED_REASON }
  | { status: "unavailable"; reason: typeof CATALOG_UNAVAILABLE_REASON };

const ACCEPTED_ENCODINGS = new Set(["", "identity"]);

/** Read a response body with a byte cap; aborting the signal fails the read. */
export function readCappedBody(
  response: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const fail = () => {
      cleanup();
      response.destroy();
      reject(new ProviderCatalogFetchError());
    };
    const status = response.statusCode ?? 0;
    const encoding = String(response.headers["content-encoding"] ?? "")
      .trim()
      .toLowerCase();
    const declared = Number(response.headers["content-length"] ?? Number.NaN);
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buffer.length;
      if (total > maxBytes) return fail();
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const cleanup = () => {
      response.off("data", onData);
      response.off("end", onEnd);
      response.off("error", fail);
      response.off("aborted", fail);
      signal.removeEventListener("abort", fail);
    };
    if (
      signal.aborted ||
      status !== 200 ||
      !ACCEPTED_ENCODINGS.has(encoding) ||
      (Number.isFinite(declared) && declared > maxBytes)
    ) {
      response.destroy();
      reject(new ProviderCatalogFetchError());
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
    response.on("data", onData);
    response.on("end", onEnd);
    response.on("error", fail);
    response.on("aborted", fail);
  });
}

/** One keyless GET of the public catalog. Returns the parsed JSON document. */
export async function fetchOpenRouterCatalogJson(
  signal: AbortSignal,
  options: { egressEnabled: boolean; maxBytes?: number; timeoutMs?: number },
): Promise<unknown> {
  const response = await providerHttpsRequest(
    OPENROUTER_CATALOG_URL,
    { method: "GET", headers: { accept: "application/json" }, signal },
    {
      // Fixed public host: private networks are never allowed for this fetch,
      // whatever the deployment's provider setting says.
      allowPrivateNetworks: false,
      egressEnabled: options.egressEnabled,
      timeoutMs: options.timeoutMs ?? CATALOG_TIMEOUT_MS,
    },
    "openai",
    { type: "NONE", purpose: "UNAUTHENTICATED_PROBE" },
  );
  const body = await readCappedBody(response, options.maxBytes ?? CATALOG_MAX_BYTES, signal);
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new ProviderCatalogFetchError();
  }
}

export interface ProviderCatalogOptions {
  /** Performs the outbound request; must honour `signal`. */
  fetchJson: (signal: AbortSignal) => Promise<unknown>;
  /** Deployment switch, read on every call. */
  egressEnabled: () => boolean;
  now?: () => number;
  ttlMs?: number;
  staleIfErrorMs?: number;
  failureBackoffMs?: number;
  timeoutMs?: number;
}

export interface ProviderCatalog {
  get(): Promise<ProviderCatalogResult>;
  /** Test/maintenance hook: drop cached state. Never called on request paths. */
  reset(): void;
}

export function createProviderCatalog(options: ProviderCatalogOptions): ProviderCatalog {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
  const staleMs = options.staleIfErrorMs ?? CATALOG_STALE_IF_ERROR_MS;
  const backoffMs = options.failureBackoffMs ?? CATALOG_FAILURE_BACKOFF_MS;
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS;
  let cached: { models: readonly CatalogModel[]; fetchedAt: number } | null = null;
  let lastFailureAt: number | null = null;
  let inflight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The deadline also bounds a fetch implementation that ignores the signal.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderCatalogFetchError());
      }, timeoutMs);
      if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
    });
    try {
      const json = await Promise.race([options.fetchJson(controller.signal), deadline]);
      const models = parseCatalog(json);
      cached = { models, fetchedAt: now() };
      lastFailureAt = null;
    } catch {
      lastFailureAt = now();
      throw new ProviderCatalogFetchError();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function snapshot(): ProviderCatalogResult | null {
    if (!cached) return null;
    const age = now() - cached.fetchedAt;
    if (age < 0 || age >= ttlMs + staleMs) return null;
    return {
      status: "ok",
      models: cached.models,
      fetchedAt: new Date(cached.fetchedAt),
      stale: age >= ttlMs,
    };
  }

  return {
    async get() {
      if (!options.egressEnabled()) return { status: "disabled", reason: CATALOG_DISABLED_REASON };
      const current = snapshot();
      if (current?.status === "ok" && !current.stale) return current;
      const inBackoff = lastFailureAt !== null && now() - lastFailureAt < backoffMs;
      if (!inBackoff) {
        if (!inflight) {
          inflight = refresh().finally(() => {
            inflight = null;
          });
        }
        try {
          await inflight;
        } catch {
          // Served from the stale copy below, or reported as unavailable.
        }
      }
      return snapshot() ?? { status: "unavailable", reason: CATALOG_UNAVAILABLE_REASON };
    },
    reset() {
      cached = null;
      lastFailureAt = null;
      inflight = null;
    },
  };
}
