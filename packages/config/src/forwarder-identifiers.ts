export const FORWARDER_SLUG_MIN_LENGTH = 3;
export const FORWARDER_SLUG_MAX_LENGTH = 63;

export const RESERVED_FORWARDER_SLUGS = [
  "api",
  "v1",
  "admin",
  "auth",
  "login",
  "logout",
  "signup",
  "settings",
  "dashboard",
  "health",
  "models",
  "model",
  "cli",
  "clis",
  "endpoint",
  "endpoints",
  "pool",
  "pools",
  "token",
  "tokens",
] as const;

const RESERVED_FORWARDER_SLUG_SET = new Set<string>(RESERVED_FORWARDER_SLUGS);

export const FORWARDER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,61}[a-z0-9]$/;
export const FORWARDER_POOL_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|[.-](?=[a-z0-9])){1,61}[a-z0-9]$/;

export type ForwarderSlugValidationResult =
  | { ok: true; value: string }
  | { ok: false; reason: "format" | "reserved" };

export function validateForwarderSlug(value: string): ForwarderSlugValidationResult {
  if (!FORWARDER_SLUG_PATTERN.test(value)) {
    return { ok: false, reason: "format" };
  }
  if (RESERVED_FORWARDER_SLUG_SET.has(value)) {
    return { ok: false, reason: "reserved" };
  }
  return { ok: true, value };
}

export function validateForwarderPoolSlug(value: string): ForwarderSlugValidationResult {
  if (!FORWARDER_POOL_SLUG_PATTERN.test(value)) {
    return { ok: false, reason: "format" };
  }
  if (RESERVED_FORWARDER_SLUG_SET.has(value)) {
    return { ok: false, reason: "reserved" };
  }
  return { ok: true, value };
}

export function isValidForwarderSlug(value: string): boolean {
  return validateForwarderSlug(value).ok;
}

export function isValidForwarderPoolSlug(value: string): boolean {
  return validateForwarderPoolSlug(value).ok;
}

export function slugifyForwarderSeed(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, FORWARDER_SLUG_MAX_LENGTH)
    .replace(/^-|-$/g, "");

  if (slug.length >= FORWARDER_SLUG_MIN_LENGTH && !RESERVED_FORWARDER_SLUG_SET.has(slug)) {
    return slug;
  }
  return fallback;
}

export function encodeUpstreamModelId(upstreamModelId: string): string {
  return encodeURIComponent(upstreamModelId).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function decodeUpstreamModelId(encodedModelId: string): string {
  return decodeURIComponent(encodedModelId);
}

export function directModelId({
  userSlug,
  cliSlug,
  endpointSlug,
  upstreamModelId,
}: {
  userSlug: string;
  cliSlug: string;
  endpointSlug: string;
  upstreamModelId: string;
}): string {
  return `${userSlug}/${cliSlug}/${endpointSlug}/${encodeUpstreamModelId(upstreamModelId)}`;
}

export function parseDirectModelId(value: string): {
  userSlug: string;
  cliSlug: string;
  endpointSlug: string;
  upstreamModelId: string;
} | null {
  const parts = value.split("/");
  if (parts.length !== 4) return null;
  const [userSlug, cliSlug, endpointSlug, encodedModelId] = parts;
  if (
    !userSlug ||
    !cliSlug ||
    !endpointSlug ||
    !encodedModelId ||
    !isValidForwarderSlug(userSlug) ||
    !isValidForwarderSlug(cliSlug) ||
    !isValidForwarderSlug(endpointSlug)
  ) {
    return null;
  }
  return {
    userSlug,
    cliSlug,
    endpointSlug,
    upstreamModelId: decodeUpstreamModelId(encodedModelId),
  };
}

export function poolModelId({
  userSlug,
  poolSlug,
}: {
  userSlug: string;
  poolSlug: string;
}): string {
  return `${userSlug}/${poolSlug}`;
}
