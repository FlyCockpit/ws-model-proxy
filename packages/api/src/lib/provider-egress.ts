import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";

export type ProviderProtocol = "openai" | "anthropic";

const COMMON_REQUEST_HEADERS = new Set(["accept", "content-type"]);
const PROTOCOL_REQUEST_HEADERS: Record<ProviderProtocol, ReadonlySet<string>> = {
  openai: new Set(),
  anthropic: new Set(["anthropic-beta", "anthropic-version"]),
};

const SENSITIVE_HEADER = /(?:authorization|api[-_]?key|cookie|proxy|secret|token)/iu;

export interface ProviderEgressPolicy {
  allowPrivateNetworks: boolean;
  egressEnabled?: boolean;
  timeoutMs?: number;
}

export class ProviderEgressError extends Error {
  constructor() {
    super("Provider request failed");
    this.name = "ProviderEgressError";
  }
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;
}

export function isPrivateOrSpecialAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    const inRange = (base: string, bits: number) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4Number(base) & mask);
    };
    return (
      inRange("0.0.0.0", 8) ||
      inRange("10.0.0.0", 8) ||
      inRange("100.64.0.0", 10) ||
      inRange("127.0.0.0", 8) ||
      inRange("169.254.0.0", 16) ||
      inRange("172.16.0.0", 12) ||
      inRange("192.0.0.0", 24) ||
      inRange("192.0.2.0", 24) ||
      inRange("192.168.0.0", 16) ||
      inRange("198.18.0.0", 15) ||
      inRange("198.51.100.0", 24) ||
      inRange("203.0.113.0", 24) ||
      inRange("224.0.0.0", 4) ||
      inRange("240.0.0.0", 4)
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase().split("%")[0] ?? "";
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/u.test(normalized))
      return true;
    if (normalized.startsWith("ff") || normalized.startsWith("2001:db8:")) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
    return mapped ? isPrivateOrSpecialAddress(mapped) : false;
  }
  return true;
}

export function assertResolvedAddressesSafe(
  addresses: readonly Pick<LookupAddress, "address">[],
  policy: ProviderEgressPolicy,
): void {
  if (addresses.length === 0) throw new ProviderEgressError();
  if (
    !policy.allowPrivateNetworks &&
    addresses.some(({ address }) => isPrivateOrSpecialAddress(address))
  ) {
    throw new ProviderEgressError();
  }
}

export function validateProviderBaseUrl(rawUrl: string, policy: ProviderEgressPolicy): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Provider base URL is invalid");
  }
  if (url.protocol !== "https:" && !(policy.allowPrivateNetworks && url.protocol === "http:")) {
    throw new Error("Provider base URL must use HTTPS");
  }
  if (url.username || url.password)
    throw new Error("Provider base URL must not contain credentials");
  if (url.hash || url.search)
    throw new Error("Provider base URL must not contain query or fragment components");
  if (
    isIP(url.hostname) &&
    !policy.allowPrivateNetworks &&
    isPrivateOrSpecialAddress(url.hostname)
  ) {
    throw new Error("Provider base URL resolves to a private or special network");
  }
  return url;
}

export async function resolveAndValidateProviderUrl(
  rawUrl: string | URL,
  policy: ProviderEgressPolicy,
): Promise<URL> {
  const url = validateProviderBaseUrl(String(rawUrl), policy);
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    dnsLookup(url.hostname, { all: true, verbatim: true }, (error, result) =>
      error ? reject(error) : resolve(result),
    );
  });
  assertResolvedAddressesSafe(addresses, policy);
  return url;
}

export function sanitizeProviderHeaders(
  headers: Headers | Record<string, string>,
  protocol: ProviderProtocol,
): Record<string, string> {
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  const sanitized: Record<string, string> = {};
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (COMMON_REQUEST_HEADERS.has(name) || PROTOCOL_REQUEST_HEADERS[protocol].has(name)) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

export function redactProviderError(value: unknown): string {
  void value;
  return "Provider request failed";
}

export function assertSafeProviderHeaders(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    if (SENSITIVE_HEADER.test(name)) {
      throw new Error("Unsafe provider request header");
    }
  }
}

/**
 * Low-level egress primitive. DNS validation occurs in the socket's lookup
 * callback, closing the validation/connect rebinding gap. Redirects are not
 * followed by Node and callers must re-enter this function for every Location.
 */
export async function providerHttpsRequest(
  rawUrl: string,
  options: Omit<RequestOptions, "hostname" | "host" | "port" | "protocol" | "lookup">,
  policy: ProviderEgressPolicy,
  protocol: ProviderProtocol,
  providerAuthHeaders: { authorization?: string; "x-api-key"?: string } = {},
) {
  if (policy.egressEnabled !== true) throw new ProviderEgressError();
  const url = validateProviderBaseUrl(rawUrl, policy);
  const headers = {
    ...sanitizeProviderHeaders((options.headers ?? {}) as Record<string, string>, protocol),
    ...providerAuthHeaders,
  };
  return new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const requestFunction = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requestFunction(url, {
      ...options,
      headers,
      lookup(hostname, lookupOptions, callback) {
        dnsLookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
          if (error) return callback(error, "", 0);
          const resolved = Array.isArray(addresses) ? addresses : [addresses];
          try {
            assertResolvedAddressesSafe(resolved, policy);
          } catch (validationError) {
            return callback(validationError as Error, "", 0);
          }
          const selected = resolved[0];
          if (!selected) return callback(new Error("Provider hostname did not resolve"), "", 0);
          callback(null, selected.address, selected.family);
        });
      },
    });
    const timeoutMs = policy.timeoutMs ?? 10_000;
    request.setTimeout(timeoutMs, () => request.destroy(new ProviderEgressError()));
    const abort = () => request.destroy(new ProviderEgressError());
    options.signal?.addEventListener("abort", abort, { once: true });
    request.once("response", (response) => {
      options.signal?.removeEventListener("abort", abort);
      if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
        response.resume();
        reject(new ProviderEgressError());
        return;
      }
      resolve(response);
    });
    request.once("error", () => {
      options.signal?.removeEventListener("abort", abort);
      reject(new ProviderEgressError());
    });
    request.end();
  });
}
