import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type TcpSocketConnectOpts } from "node:net";
import type { ProviderProtocol } from "./provider-protocol";

export type { ProviderProtocol } from "./provider-protocol";

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

/** Stable oRPC `data.reason` when a literal private or loopback provider URL is rejected. */
export const PROVIDER_PRIVATE_NETWORK_REJECTED = "PROVIDER_PRIVATE_NETWORK_REJECTED";

export class ProviderBaseUrlError extends Error {
  readonly reason: typeof PROVIDER_PRIVATE_NETWORK_REJECTED;

  constructor(message: string, reason: typeof PROVIDER_PRIVATE_NETWORK_REJECTED) {
    super(message);
    this.name = "ProviderBaseUrlError";
    this.reason = reason;
  }
}

export type ProviderEgressAuth =
  | { type: "API_KEY"; apiKey: string }
  | { type: "BEARER"; token: string }
  | { type: "NONE"; purpose: "UNAUTHENTICATED_PROBE" };

function providerAuthHeaders(auth: ProviderEgressAuth): Record<string, string> {
  if (!auth || typeof auth !== "object") throw new ProviderEgressError();
  const keys = Object.keys(auth).sort();
  if (
    auth.type === "API_KEY" &&
    keys.join(",") === "apiKey,type" &&
    typeof auth.apiKey === "string" &&
    auth.apiKey.length > 0
  )
    return { "x-api-key": auth.apiKey };
  if (
    auth.type === "BEARER" &&
    keys.join(",") === "token,type" &&
    typeof auth.token === "string" &&
    auth.token.length > 0
  )
    return { authorization: `Bearer ${auth.token}` };
  if (
    auth.type === "NONE" &&
    keys.join(",") === "purpose,type" &&
    auth.purpose === "UNAUTHENTICATED_PROBE"
  )
    return {};
  throw new ProviderEgressError();
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

function stripIpBrackets(address: string): string {
  const withoutZone = address.split("%")[0] ?? "";
  return withoutZone.startsWith("[") && withoutZone.endsWith("]")
    ? withoutZone.slice(1, -1)
    : withoutZone;
}

function ipv6Bytes(address: string): Uint8Array | null {
  const literal = stripIpBrackets(address).toLowerCase();
  if (isIP(literal) !== 6) return null;
  const dottedIndex = literal.lastIndexOf(":");
  let hexadecimal = literal;
  if (literal.includes(".")) {
    const dotted = literal.slice(dottedIndex + 1);
    if (isIP(dotted) !== 4) return null;
    const octets = dotted.split(".").map(Number);
    hexadecimal = `${literal.slice(0, dottedIndex)}:${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`;
  }
  const halves = hexadecimal.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (words.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (const [index, word] of words.entries()) {
    const value = Number.parseInt(word, 16);
    bytes[index * 2] = value >>> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function bytesInPrefix(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const wholeBytes = Math.floor(bits / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== (prefix[index] ?? 0)) return false;
  }
  const remaining = bits % 8;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return ((bytes[wholeBytes] ?? 0) & mask) === ((prefix[wholeBytes] ?? 0) & mask);
}

export function isPrivateOrSpecialAddress(address: string): boolean {
  const literal = stripIpBrackets(address);
  const family = isIP(literal);
  if (family === 4) {
    const value = ipv4Number(literal);
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
      inRange("192.88.99.2", 32) || // non-global 6a44 relay anycast
      inRange("192.168.0.0", 16) ||
      inRange("198.18.0.0", 15) ||
      inRange("198.51.100.0", 24) ||
      inRange("203.0.113.0", 24) ||
      inRange("224.0.0.0", 4) ||
      inRange("240.0.0.0", 4)
    );
  }
  if (family === 6) {
    const bytes = ipv6Bytes(literal);
    if (!bytes) return true;
    const prefix = (...values: number[]) => values;
    // IPv4-compatible and IPv4-mapped forms must be classified by the embedded
    // address, including compressed and all-hex spellings.
    const firstTenZero = bytes.slice(0, 10).every((value) => value === 0);
    const compatible = bytes.slice(0, 12).every((value) => value === 0);
    if (compatible || (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff)) {
      const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
      return isPrivateOrSpecialAddress(embedded);
    }
    // The well-known NAT64 prefix is globally routable, but the last 32 bits
    // still identify the effective IPv4 destination. Permit public synthesis
    // while preventing translation from bypassing the IPv4 deny ranges.
    if (bytesInPrefix(bytes, prefix(0x00, 0x64, 0xff, 0x9b), 96)) {
      const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
      return isPrivateOrSpecialAddress(embedded);
    }
    return (
      bytesInPrefix(bytes, prefix(0x00), 8) || // reserved low addresses
      bytesInPrefix(bytes, prefix(0x01, 0x00), 64) || // discard-only
      bytesInPrefix(bytes, prefix(0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01), 64) || // dummy IPv6
      bytesInPrefix(bytes, prefix(0x20, 0x01, 0x00, 0x02), 48) || // benchmarking
      bytesInPrefix(bytes, prefix(0x20, 0x01, 0x00), 23) || // other IETF assignments
      bytesInPrefix(bytes, prefix(0x20, 0x01, 0x0d, 0xb8), 32) || // documentation
      bytesInPrefix(bytes, prefix(0x20, 0x02), 16) || // deprecated 6to4
      bytesInPrefix(bytes, prefix(0x3f, 0xff), 20) || // documentation
      bytesInPrefix(bytes, prefix(0x5f, 0x00), 16) || // segment-routing local
      bytesInPrefix(bytes, prefix(0x00, 0x64, 0xff, 0x9b, 0x00, 0x01), 48) || // local translation
      bytesInPrefix(bytes, prefix(0xfc), 7) || // unique-local
      bytesInPrefix(bytes, prefix(0xfe, 0x80), 10) || // link-local
      bytesInPrefix(bytes, prefix(0xfe, 0xc0), 10) || // deprecated site-local
      bytesInPrefix(bytes, prefix(0xff), 8) // multicast
    );
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
    isIP(stripIpBrackets(url.hostname)) &&
    !policy.allowPrivateNetworks &&
    isPrivateOrSpecialAddress(url.hostname)
  ) {
    throw new ProviderBaseUrlError(
      "Provider base URL resolves to a private or special network",
      PROVIDER_PRIVATE_NETWORK_REJECTED,
    );
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

export type ProviderRequestOptions = Pick<
  RequestOptions,
  "method" | "path" | "headers" | "signal" | "ca" | "family"
> &
  Pick<TcpSocketConnectOpts, "autoSelectFamily"> & { body?: Uint8Array };

const REQUEST_OPTION_NAMES = new Set([
  "method",
  "path",
  "headers",
  "signal",
  "ca",
  "family",
  "autoSelectFamily",
  "body",
]);

/**
 * Each exchange owns a fresh, non-pooling agent. Every connection therefore
 * uses this exchange's validated DNS answers, never a foreign or differently
 * authorized socket. Connector, proxy and TLS verification overrides are not
 * accepted. Custom trust roots remain supported; certificate identity and SNI
 * use the original URL host. Redirects require a new, independently checked call.
 * timeoutMs bounds DNS/connect/headers, then socket inactivity during the body;
 * zero explicitly disables those timers. Streaming callers own total deadlines
 * and response byte limits.
 */
export async function providerHttpsRequest(
  rawUrl: string,
  options: ProviderRequestOptions,
  policy: ProviderEgressPolicy,
  protocol: ProviderProtocol,
  auth: ProviderEgressAuth,
) {
  if (policy.egressEnabled !== true) throw new ProviderEgressError();
  if (
    Reflect.ownKeys(options).some(
      (key) => typeof key !== "string" || !REQUEST_OPTION_NAMES.has(key),
    )
  )
    throw new ProviderEgressError();
  if (
    policy.timeoutMs !== undefined &&
    (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs < 0)
  )
    throw new ProviderEgressError();
  const url = validateProviderBaseUrl(rawUrl, policy);
  // Node's built-in signal handler destroys the request and dumps unread
  // response bytes. Own the signal so teardown always errors the body.
  const { body, signal, method, path, ca, family, autoSelectFamily } = options;
  if (signal?.aborted) throw new ProviderEgressError();
  const headers = {
    ...sanitizeProviderHeaders((options.headers ?? {}) as Record<string, string>, protocol),
    ...providerAuthHeaders(auth),
  };
  return new Promise<IncomingMessage>((resolve, reject) => {
    const requestFunction = url.protocol === "https:" ? httpsRequest : httpRequest;
    const agent =
      url.protocol === "https:"
        ? new HttpsAgent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 })
        : new HttpAgent({ keepAlive: false, maxSockets: 1 });
    let request: ReturnType<typeof httpRequest>;
    try {
      const nativeOptions: RequestOptions & Pick<TcpSocketConnectOpts, "autoSelectFamily"> = {
        method,
        path: path ?? url.pathname,
        ca,
        family,
        autoSelectFamily,
        agent,
        rejectUnauthorized: true,
        headers,
        lookup(hostname, lookupOptions, callback) {
          dnsLookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
            if (error) return callback(new ProviderEgressError(), []);
            const resolved = Array.isArray(addresses) ? addresses : [addresses];
            try {
              assertResolvedAddressesSafe(resolved, policy);
            } catch {
              return callback(new ProviderEgressError(), []);
            }
            const selected = resolved[0];
            if (!selected) return callback(new ProviderEgressError(), []);
            if (lookupOptions.all) callback(null, resolved);
            else callback(null, selected.address, selected.family);
          });
        },
      };
      request = requestFunction(url, nativeOptions);
    } catch {
      agent.destroy();
      reject(new ProviderEgressError());
      return;
    }
    let response: IncomingMessage | undefined;
    // Once headers exist, only a natural EOF with all bytes delivered or a
    // rejecting read is valid. ClientRequest.destroy() can discard buffered
    // records and end cleanly even when response.complete is already true.
    const teardownExchange = (error: ProviderEgressError) => {
      if (response) response.destroy(error);
      else request.destroy(error);
    };
    const timeoutMs = policy.timeoutMs ?? 10_000;
    // ClientRequest.setTimeout starts after connect, so separately bound the
    // DNS lookup, TCP/TLS handshake and response headers. A late DNS callback
    // cannot connect a destroyed socket (Node's native connecting check).
    const headerDeadline =
      timeoutMs > 0
        ? setTimeout(() => teardownExchange(new ProviderEgressError()), timeoutMs)
        : undefined;
    headerDeadline?.unref();
    request.setTimeout(timeoutMs, () => teardownExchange(new ProviderEgressError()));
    const abort = () => teardownExchange(new ProviderEgressError());
    const detachAbort = () => signal?.removeEventListener("abort", abort);
    const cleanup = () => {
      clearTimeout(headerDeadline);
      detachAbort();
      agent.destroy();
    };
    request.once("response", (incoming) => {
      clearTimeout(headerDeadline);
      response = incoming;
      response.once("end", cleanup);
      response.once("close", cleanup);
      response.once("error", cleanup);
      if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
        response.destroy();
        cleanup();
        reject(new ProviderEgressError());
        return;
      }
      resolve(response);
    });
    request.once("error", () => {
      cleanup();
      reject(new ProviderEgressError());
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else request.end(body);
  });
}
