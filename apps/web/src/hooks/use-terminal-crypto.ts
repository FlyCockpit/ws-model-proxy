import { useCallback, useEffect, useRef, useState } from "react";

export const TERMINAL_HKDF_LABEL = "wsmp-term-v1";
export const TERMINAL_APPROVAL_LABEL = "wsmp-term-approve-v1";
export const DIRECTION_BROWSER_TO_CLI = 0x01;
export const DIRECTION_CLI_TO_BROWSER = 0x02;
export const PLAINTEXT_DATA = 0x01;
export const PLAINTEXT_RESIZE = 0x02;

const ECDH_PARAMS = { name: "ECDH", namedCurve: "P-256" } as const;
const ECDSA_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const;
const IDENTITY_DB = "wsmp-terminal-identity";
const IDENTITY_STORE = "keys";
const IDENTITY_RECORD = "ecdsa-p256";

const textEncoder = new TextEncoder();

export type TerminalDirection = typeof DIRECTION_BROWSER_TO_CLI | typeof DIRECTION_CLI_TO_BROWSER;

export type TerminalPlaintext =
  | { kind: "data"; data: Uint8Array }
  | { kind: "resize"; cols: number; rows: number };

export type TerminalSessionKeys = {
  ikm: Uint8Array;
  browserToCliRaw: Uint8Array;
  cliToBrowserRaw: Uint8Array;
  browserToCli: CryptoKey;
  cliToBrowser: CryptoKey;
};

export type ApprovalTranscriptInput = {
  terminalId: string;
  browserPublicKey: Uint8Array;
  browserNonce: Uint8Array;
  cliPublicKey: Uint8Array;
  cliNonce: Uint8Array;
};

export type TerminalIdentityProof = {
  publicKey: string;
  signature: string;
};

type StoredIdentity = {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const pad = (4 - (value.length % 4)) % 4;
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(pad);
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    hex += (bytes[index] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export function uncompressedPublicKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  if (x.byteLength !== 32 || y.byteLength !== 32) {
    throw new Error("P-256 coordinates must be 32 bytes");
  }
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(x, 1);
  out.set(y, 33);
  return out;
}

export function ecPrivateJwk(scalar: Uint8Array, x: Uint8Array, y: Uint8Array): JsonWebKey {
  return {
    kty: "EC",
    crv: "P-256",
    d: bytesToBase64Url(scalar),
    x: bytesToBase64Url(x),
    y: bytesToBase64Url(y),
    ext: true,
  };
}

export async function importEcdhPrivateJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ECDH_PARAMS, true, ["deriveBits"]);
}

export async function importEcdhPublicRaw(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== 65 || raw[0] !== 0x04) {
    throw new Error("expected an uncompressed P-256 public key");
  }
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), ECDH_PARAMS, true, []);
}

export async function generateEphemeralHandshake(): Promise<{
  privateKey: CryptoKey;
  publicKeyRaw: Uint8Array;
  publicKeyB64: string;
  nonce: Uint8Array;
}> {
  // Ephemeral ECDH material stays in memory for this handshake only.
  const pair = await crypto.subtle.generateKey(ECDH_PARAMS, true, ["deriveBits"]);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    publicKeyRaw,
    publicKeyB64: bytesToBase64Url(publicKeyRaw),
    nonce,
  };
}

export function terminalGcmNonce(seq: bigint): Uint8Array {
  if (seq < 1n || seq > 0xffffffffffffffffn) throw new Error("terminal seq is out of range");
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, seq, false);
  return nonce;
}

export function terminalAad(
  terminalId: string,
  direction: TerminalDirection,
  seq: bigint,
): Uint8Array {
  const id = textEncoder.encode(terminalId);
  const out = new Uint8Array(id.byteLength + 1 + 8);
  out.set(id, 0);
  out[id.byteLength] = direction;
  new DataView(out.buffer).setBigUint64(id.byteLength + 1, seq, false);
  return out;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function deriveTerminalSessionKeys(input: {
  browserPrivateKey: CryptoKey;
  cliPublicKey: CryptoKey;
  browserNonce: Uint8Array;
  cliNonce: Uint8Array;
  terminalId: string;
  cliPublicRaw: Uint8Array;
  browserPublicRaw: Uint8Array;
}): Promise<TerminalSessionKeys> {
  if (input.browserNonce.byteLength !== 16 || input.cliNonce.byteLength !== 16) {
    throw new Error("terminal nonces must be 16 bytes");
  }
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: input.cliPublicKey },
      input.browserPrivateKey,
      256,
    ),
  );
  if (ikm.byteLength !== 32) throw new Error("ECDH IKM must be 32 bytes");
  const hkdfKey = await crypto.subtle.importKey("raw", toArrayBuffer(ikm), "HKDF", false, [
    "deriveBits",
  ]);
  const okm = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: toArrayBuffer(concatBytes([input.browserNonce, input.cliNonce])),
        info: toArrayBuffer(
          concatBytes([
            textEncoder.encode(TERMINAL_HKDF_LABEL),
            textEncoder.encode(input.terminalId),
            input.cliPublicRaw,
            input.browserPublicRaw,
          ]),
        ),
      },
      hkdfKey,
      512,
    ),
  );
  const browserToCliRaw = okm.slice(0, 32);
  const cliToBrowserRaw = okm.slice(32, 64);
  return {
    ikm,
    browserToCliRaw,
    cliToBrowserRaw,
    browserToCli: await importAesKey(browserToCliRaw),
    cliToBrowser: await importAesKey(cliToBrowserRaw),
  };
}

export async function sealTerminalBytes(input: {
  key: CryptoKey;
  terminalId: string;
  direction: TerminalDirection;
  seq: bigint;
  plaintext: Uint8Array;
}): Promise<Uint8Array> {
  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(terminalGcmNonce(input.seq)),
      additionalData: toArrayBuffer(terminalAad(input.terminalId, input.direction, input.seq)),
    },
    input.key,
    toArrayBuffer(input.plaintext),
  );
  return new Uint8Array(sealed);
}

export async function openTerminalBytes(input: {
  key: CryptoKey;
  terminalId: string;
  direction: TerminalDirection;
  seq: bigint;
  ciphertext: Uint8Array;
}): Promise<Uint8Array> {
  const opened = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(terminalGcmNonce(input.seq)),
      additionalData: toArrayBuffer(terminalAad(input.terminalId, input.direction, input.seq)),
    },
    input.key,
    toArrayBuffer(input.ciphertext),
  );
  return new Uint8Array(opened);
}

export function encodeTerminalData(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + data.byteLength);
  out[0] = PLAINTEXT_DATA;
  out.set(data, 1);
  return out;
}

export function encodeTerminalResize(cols: number, rows: number): Uint8Array {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > 1000 ||
    rows > 1000
  ) {
    throw new Error("terminal resize is out of range");
  }
  const out = new Uint8Array(5);
  const view = new DataView(out.buffer);
  out[0] = PLAINTEXT_RESIZE;
  view.setUint16(1, cols, false);
  view.setUint16(3, rows, false);
  return out;
}

export function decodeTerminalPlaintext(bytes: Uint8Array): TerminalPlaintext {
  const kind = bytes[0];
  if (kind === PLAINTEXT_DATA) {
    return { kind: "data", data: bytes.slice(1) };
  }
  if (kind === PLAINTEXT_RESIZE) {
    if (bytes.byteLength !== 5) throw new Error("resize plaintext must be 5 bytes");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { kind: "resize", cols: view.getUint16(1, false), rows: view.getUint16(3, false) };
  }
  throw new Error("unknown terminal plaintext");
}

export function assertIncreasingTerminalSeq(previous: bigint, next: bigint): void {
  if (next <= previous) throw new Error("terminal seq did not increase");
}

function lengthPrefix(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > 0xffff) throw new Error("transcript field too long");
  const out = new Uint8Array(2 + bytes.byteLength);
  new DataView(out.buffer).setUint16(0, bytes.byteLength, false);
  out.set(bytes, 2);
  return out;
}

export function buildApprovalTranscript(input: ApprovalTranscriptInput): Uint8Array {
  return concatBytes([
    lengthPrefix(textEncoder.encode(TERMINAL_APPROVAL_LABEL)),
    lengthPrefix(textEncoder.encode(input.terminalId)),
    lengthPrefix(input.browserPublicKey),
    lengthPrefix(input.browserNonce),
    lengthPrefix(input.cliPublicKey),
    lengthPrefix(input.cliNonce),
  ]);
}

export async function signApprovalTranscript(
  privateKey: CryptoKey,
  input: ApprovalTranscriptInput,
): Promise<Uint8Array> {
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      toArrayBuffer(buildApprovalTranscript(input)),
    ),
  );
  if (signature.byteLength !== 64) throw new Error("expected an IEEE P1363 signature");
  return signature;
}

export async function verifyApprovalTranscript(
  publicKey: CryptoKey,
  input: ApprovalTranscriptInput,
  signature: Uint8Array,
): Promise<boolean> {
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    toArrayBuffer(signature),
    toArrayBuffer(buildApprovalTranscript(input)),
  );
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
  });
}

function openIdentityDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDENTITY_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDENTITY_STORE)) db.createObjectStore(IDENTITY_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("identity database failed"));
  });
}

async function readStoredIdentity(db: IDBDatabase): Promise<StoredIdentity | null> {
  const stored = await requestToPromise(
    db.transaction(IDENTITY_STORE, "readonly").objectStore(IDENTITY_STORE).get(IDENTITY_RECORD),
  );
  if (!stored || typeof stored !== "object") return null;
  const record = stored as Partial<StoredIdentity>;
  if (!record.privateKey || !record.publicKey) return null;
  return { privateKey: record.privateKey, publicKey: record.publicKey };
}

async function createIdentity(): Promise<StoredIdentity> {
  // Non-extractable private key. The public key of the pair stays exportable.
  const pair = await crypto.subtle.generateKey(ECDSA_PARAMS, false, ["sign", "verify"]);
  if (pair.privateKey.extractable) throw new Error("terminal identity key must not be extractable");
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

async function loadOrCreateIdentity(): Promise<{
  privateKey: CryptoKey;
  publicKeyRaw: Uint8Array;
}> {
  const db = openIdentityDb();
  try {
    const database = await db;
    const existing = await readStoredIdentity(database);
    const record = existing ?? (await createIdentity());
    if (!existing) {
      await requestToPromise(
        database
          .transaction(IDENTITY_STORE, "readwrite")
          .objectStore(IDENTITY_STORE)
          .put(record, IDENTITY_RECORD),
      );
    }
    const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", record.publicKey));
    return { privateKey: record.privateKey, publicKeyRaw };
  } finally {
    void db.then((database) => database.close()).catch(() => undefined);
  }
}

export function useTerminalIdentity(): {
  ready: boolean;
  publicKey: () => string | null;
  sign: (input: ApprovalTranscriptInput) => Promise<TerminalIdentityProof | null>;
} {
  const privateKeyRef = useRef<CryptoKey | null>(null);
  const publicKeyRawRef = useRef<Uint8Array | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadOrCreateIdentity()
      .then((identity) => {
        if (cancelled) return;
        privateKeyRef.current = identity.privateKey;
        publicKeyRawRef.current = identity.publicKeyRaw;
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const publicKey = useCallback(() => {
    const raw = publicKeyRawRef.current;
    return raw ? bytesToBase64Url(raw) : null;
  }, []);

  const sign = useCallback(async (input: ApprovalTranscriptInput) => {
    const privateKey = privateKeyRef.current;
    const publicKeyRaw = publicKeyRawRef.current;
    if (!privateKey || !publicKeyRaw) return null;
    const signature = await signApprovalTranscript(privateKey, input);
    return {
      publicKey: bytesToBase64Url(publicKeyRaw),
      signature: bytesToBase64Url(signature),
    };
  }, []);

  return { ready, publicKey, sign };
}
