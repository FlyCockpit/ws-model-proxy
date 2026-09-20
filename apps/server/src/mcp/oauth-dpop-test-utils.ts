import { createHmac, webcrypto as nodeWebcrypto } from "node:crypto";

/**
 * Pure test-only cryptography helpers for the disposable-PostgreSQL MCP
 * OAuth integration suite (MCP plan Phase 9b / Part K2).
 *
 * NO new dependencies (repo rule: ask first): everything is built on
 * node:crypto's WebCrypto (crypto.subtle) and createHmac. The DPoP helper
 * produces RFC 9449 proofs with ES256 (P-256) exactly the way the installed
 * verifier consumes them (better-auth/core dist/oauth2/dpop.mjs + jose):
 *
 * - compact JWS with header { typ: "dpop+jwt", alg: "ES256", jwk } where
 *   `jwk` is the PUBLIC key (private members absent — the verifier rejects
 *   proofs carrying them);
 * - payload { htm, htu, jti, iat[, ath] } with `ath` = base64url(SHA-256 of
 *   the ASCII access-token string) when a token is bound;
 * - an RFC 7638 SHA-256 JWK thumbprint (`calculateJwkThumbprint(jwk,
 *   "sha256")` semantics: canonical JSON over the required EC members
 *   {crv,kty,x,y} in lexicographic order) — used for `dpop_jkt` at
 *   authorize time and cross-checked against the minted token's cnf.jkt;
 * - the ECDSA signature in the RAW WebCrypto r||s form (64 bytes) — the
 *   installed verifier verifies through jose@6.2.8's WEBAPI build, which
 *   feeds `subtle.verify` directly (raw per the WebCrypto spec) WITHOUT the
 *   historical JWS DER conversion (probe-verified: a DER-encoded proof
 *   fails with "signature verification failed", the raw form verifies).
 *
 * The TOTP helper is the same RFC 6238 derivation the repo's lockout suite
 * uses (HMAC-SHA1, 30 s step, 6 digits, ±1 step accepted by the installed
 * verifier).
 */

const subtle = nodeWebcrypto.subtle;

export interface DpopKeyPair {
  /** Public JWK (EC P-256, private members absent). */
  publicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  /** RFC 7638 SHA-256 thumbprint of the public JWK (base64url, 43 chars). */
  jkt: string;
  /** Handles the private key material; never serialized into proofs. */
  privateCryptoKey: nodeWebcrypto.CryptoKey;
}

// ---------------------------------------------------------------------------
// base64url primitives (alphabet without padding, per RFC 7515).
// ---------------------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// ---------------------------------------------------------------------------
// RFC 7638 JWK thumbprint (SHA-256, EC required members in lexicographic
// order — byte-identical to jose's calculateJwkThumbprint(jwk, "sha256")).
// ---------------------------------------------------------------------------

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  return await subtle.digest("SHA-256", bytes);
}

export async function jwkThumbprint(jwk: {
  kty: string;
  crv: string;
  x: string;
  y: string;
}): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return toBase64Url(new Uint8Array(await sha256(new TextEncoder().encode(canonical))));
}

// ---------------------------------------------------------------------------
// ES256 signing (raw WebCrypto r||s — the form the installed jose webapi
// build verifies; see the module header) and key generation.
// ---------------------------------------------------------------------------

/** Generate an ES256 (P-256) keypair and expose the public JWK + thumbprint. */
export async function generateDpopKey(): Promise<DpopKeyPair> {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = (await subtle.exportKey("jwk", pair.privateKey)) as {
    kty: string;
    crv: string;
    x: string;
    y: string;
    d?: string;
  };
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.d) {
    throw new Error("unexpected EC JWK export shape");
  }
  const publicJwk = { kty: "EC" as const, crv: "P-256" as const, x: jwk.x, y: jwk.y };
  return {
    publicJwk,
    jkt: await jwkThumbprint(publicJwk),
    privateCryptoKey: pair.privateKey,
  };
}

/** Sign `data` with an ES256 private key; returns the RAW r||s signature. */
export async function signEs256(
  privateCryptoKey: nodeWebcrypto.CryptoKey,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateCryptoKey, data),
  );
}

// ---------------------------------------------------------------------------
// Ed25519 / EdDSA (row 12's signature-negative fixture): the PRODUCTION JWT
// configuration mints EdDSA keys (JWKS: {alg:"EdDSA", kty:"OKP",
// crv:"Ed25519"}), and jose SELECTS verification keys by alg+kid — an ES256
// fixture naming the production kid dies at key selection
// (ERR_JWKS_NO_MATCHING_KEY) and never reaches signature verification
// (R119 finding 3 / R120 finding 4). node:crypto's WebCrypto supports
// Ed25519 sign/verify/importKey("jwk") natively (probe-verified on the
// repo's Node), so the forged single-defect token is EdDSA-signed here.
// ---------------------------------------------------------------------------

/** A fresh Ed25519 keypair (attacker key for the forged fixture). */
export interface Ed25519KeyPair {
  /** Handles the private key material. */
  privateCryptoKey: nodeWebcrypto.CryptoKey;
  /** Public JWK members (kty OKP, crv Ed25519, x) — the JWKS key shape. */
  publicJwk: { kty: "OKP"; crv: "Ed25519"; x: string };
}

/** Generate an Ed25519 keypair (usable for EdDSA JWS signing). */
export async function generateEd25519Key(): Promise<Ed25519KeyPair> {
  const pair = (await subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as nodeWebcrypto.CryptoKeyPair;
  const jwk = (await subtle.exportKey("jwk", pair.privateKey)) as {
    kty: string;
    crv: string;
    x: string;
    d?: string;
  };
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x || !jwk.d) {
    throw new Error("unexpected Ed25519 JWK export shape");
  }
  return {
    privateCryptoKey: pair.privateKey,
    publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x },
  };
}

/** Sign `data` with an Ed25519 private key (raw 64-byte EdDSA signature). */
export async function signEd25519(
  privateCryptoKey: nodeWebcrypto.CryptoKey,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle.sign({ name: "Ed25519" }, privateCryptoKey, data));
}

/**
 * Import an Ed25519 public JWK (the production JWKS OKP key shape) for
 * verification — used by the suite's INDEPENDENT code-path pin: the same
 * JWKS key that admits the real production token must REJECT the forged
 * signature (proving key selection succeeds and the rejection happens at
 * signature verification, not before).
 */
export async function importEd25519PublicJwk(jwk: {
  kty: string;
  crv: string;
  x: string;
}): Promise<nodeWebcrypto.CryptoKey> {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
    throw new Error("not an Ed25519 OKP public JWK");
  }
  return await subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    { name: "Ed25519" },
    true,
    ["verify"],
  );
}

/** Verify a raw Ed25519 signature over `data` with an imported public key. */
export async function verifyEd25519(
  publicCryptoKey: nodeWebcrypto.CryptoKey,
  signature: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  return await subtle.verify({ name: "Ed25519" }, publicCryptoKey, signature, data);
}

// ---------------------------------------------------------------------------
// DPoP proof construction (RFC 9449).
// ---------------------------------------------------------------------------

export interface DpopProofOptions {
  /** HTTP method (`htm`). */
  method: string;
  /** Target URI (`htu`); normalized to origin+pathname like the verifier. */
  uri: string;
  /** Signing key. */
  key: DpopKeyPair;
  /** Access token to bind (`ath`); omit for an unbound proof. */
  accessToken?: string;
  /** Issued-at seconds; defaults to now. Override for expiry fixtures. */
  iat?: number;
  /** Unique proof id; defaults to a fresh UUID (override to force replay). */
  jti?: string;
}

/** `ath` = base64url(SHA-256(ASCII(access token))) — the verifier's exact derivation. */
export async function deriveAth(accessToken: string): Promise<string> {
  return toBase64Url(new Uint8Array(await sha256(new TextEncoder().encode(accessToken))));
}

function normalizeHtu(uri: string): string {
  const parsed = new URL(uri);
  if (parsed.hash) throw new Error("DPoP proof htu must not contain a fragment");
  return `${parsed.origin}${parsed.pathname}`;
}

/** Build one compact DPoP proof JWT (typ dpop+jwt, alg ES256, public jwk). */
export async function createDpopProof(options: DpopProofOptions): Promise<string> {
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: options.key.publicJwk,
  };
  const payload: Record<string, unknown> = {
    htm: options.method.toUpperCase(),
    htu: normalizeHtu(options.uri),
    jti: options.jti ?? crypto.randomUUID(),
    iat: options.iat ?? Math.floor(Date.now() / 1000),
  };
  if (options.accessToken !== undefined) {
    payload.ath = await deriveAth(options.accessToken);
  }
  const signingInput = `${toBase64Url(
    new TextEncoder().encode(JSON.stringify(header)),
  )}.${toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const signature = await signEs256(
    options.key.privateCryptoKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${toBase64Url(signature)}`;
}

// ---------------------------------------------------------------------------
// Unverified JWT payload decode (assertions on MINTED tokens only — the
// suite's security checks ride on the real verifier, never on this).
// ---------------------------------------------------------------------------

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("not a compact JWS");
  return JSON.parse(new TextDecoder().decode(fromBase64Url(segments[1] ?? ""))) as Record<
    string,
    unknown
  >;
}

// ---------------------------------------------------------------------------
// RFC 6238 TOTP (HMAC-SHA1, 30 s period, 6 digits) — the installed
// two-factor plugin defaults (see packages/auth/src/two-factor-lockout.test.ts
// for the same derivation).
// ---------------------------------------------------------------------------

/** RFC 4648 base32 decode (the inverse of the otpauth URI secret encoding). */
export function base32Decode(input: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function totpCode(secretBytes: Uint8Array, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac("sha1", Buffer.from(secretBytes)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    ((digest[offset + 2]! << 8) | digest[offset + 3]!);
  return String(binary % 1_000_000).padStart(6, "0");
}

/** Extract the raw secret bytes from an otpauth:// totp URI. */
export function totpSecretFromUri(uri: string): Uint8Array {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("totpURI carried no secret");
  return base32Decode(secret);
}
