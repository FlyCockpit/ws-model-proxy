import { SUPPORTED_LOCALES } from "@ws-model-proxy/config/locales";
import { env } from "@ws-model-proxy/env/server";
import { PUBLIC_PATHS } from "./seo.js";

type CacheEntry = {
  status: number;
  headers: [string, string][];
  body: string;
  nonce: string | null;
  expiresAt: number;
};

type SsrCacheOptions = {
  nonce?: string | null;
};

const MAX_ENTRIES = 100;
const cache = new Map<string, CacheEntry>();

const publicPaths = new Set(
  SUPPORTED_LOCALES.flatMap((locale) =>
    PUBLIC_PATHS.map((entry) => `/${locale}${entry.path}`.replace(/\/$/, "") || `/${locale}`),
  ),
);

function normalizedPath(pathname: string): string {
  const normalized = pathname.replace(/\/$/, "");
  return normalized || "/";
}

function isAnonymous(request: Request): boolean {
  return !request.headers.get("cookie") && !request.headers.get("authorization");
}

function isCacheableRequest(request: Request): boolean {
  if (env.SSR_CACHE_TTL_SECONDS <= 0) return false;
  if (request.method !== "GET") return false;
  if (!isAnonymous(request)) return false;
  const url = new URL(request.url);
  return publicPaths.has(normalizedPath(url.pathname));
}

function headersForStorage(headers: Headers): [string, string][] {
  const stored: [string, string][] = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    stored.push([key, value]);
  });
  return stored;
}

function touch(key: string, entry: CacheEntry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (!first) break;
    cache.delete(first);
  }
}

export function clearSsrCache(): void {
  cache.clear();
}

export async function getOrSetSsrCache(
  request: Request,
  render: () => Promise<Response>,
  options: SsrCacheOptions = {},
): Promise<Response> {
  if (!isCacheableRequest(request)) return render();

  const key = new URL(request.url).pathname;
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) {
    touch(key, existing);
    const body =
      existing.nonce && options.nonce
        ? existing.body.replaceAll(`nonce="${existing.nonce}"`, `nonce="${options.nonce}"`)
        : existing.body;
    return new Response(body, {
      status: existing.status,
      headers: [...existing.headers, ["X-SSR-Cache", "hit"]],
    });
  }
  if (existing) cache.delete(key);

  const response = await render();
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
    return response;
  }

  const body = await response.text();
  const entry: CacheEntry = {
    status: response.status,
    headers: headersForStorage(response.headers),
    body,
    nonce: options.nonce ?? null,
    expiresAt: now + env.SSR_CACHE_TTL_SECONDS * 1000,
  };
  touch(key, entry);

  return new Response(body, {
    status: entry.status,
    headers: [...entry.headers, ["X-SSR-Cache", "miss"]],
  });
}
