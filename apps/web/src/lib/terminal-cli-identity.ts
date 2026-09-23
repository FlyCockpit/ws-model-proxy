import {
  base64UrlToBytes,
  cliIdentityFingerprint,
  verifyCliIdentitySignature,
} from "@/hooks/use-terminal-crypto";
import type { ListedCli } from "@/lib/terminal-protocol";

/**
 * Trust in one CLI's terminal key (phase 6, CLI identity pinning).
 *
 * - `trusted`: a 2.5 CLI whose identity signs its current ECDH key, and whose
 *   identity matches the key pinned for this `cliDeviceId` (or was just pinned).
 * - `unpinned`: as `trusted`, but this browser could not store the pin.
 * - `unverified`: a 2.4 CLI. It cannot prove an identity; allowed with a notice.
 * - `changed`: the identity differs from the pinned one. `fingerprint` is null
 *   when a previously pinned CLI stopped proving an identity at all.
 * - `invalid`: a 2.5 CLI without a valid identity signature.
 * - `offline`: no live CLI (no terminal key to check right now). The pin is
 *   kept; nothing about the identity is known until the CLI reconnects.
 */
export type CliTrust =
  | { status: "trusted"; fingerprint: string; terminalPublicKey: string; firstUse: boolean }
  | { status: "unpinned"; fingerprint: string; terminalPublicKey: string }
  | { status: "unverified" }
  | {
      status: "changed";
      pinnedFingerprint: string;
      fingerprint: string | null;
      identityPublicKey: string | null;
    }
  | { status: "invalid" }
  | { status: "offline" };

export type ChangedCliTrust = Extract<CliTrust, { status: "changed" }>;

/** Pinned identity keys (base64url, 65-byte SEC1) per `cliDeviceId`. */
export type CliPinStore = {
  get(cliDeviceId: string): Promise<string | null>;
  put(cliDeviceId: string, identityPublicKey: string): Promise<void>;
  remove(cliDeviceId: string): Promise<void>;
};

/** Whether a handshake may start, and the ECDH key the CLI must answer with. */
export function trustAllowsHandshake(
  trust: CliTrust,
): { ok: true; expectedCliPublicKey: string | null } | { ok: false } {
  if (trust.status === "trusted" || trust.status === "unpinned") {
    return { ok: true, expectedCliPublicKey: trust.terminalPublicKey };
  }
  if (trust.status === "unverified") return { ok: true, expectedCliPublicKey: null };
  return { ok: false };
}

/** The tab rejection reason for a trust state that blocks handshakes. */
export function trustRejectionReason(trust: CliTrust): string {
  if (trust.status === "changed") return "identity_changed";
  if (trust.status === "offline") return "offline";
  return "identity_invalid";
}

/** Everything that changes the outcome of `evaluateCliTrust`. */
export function cliTrustInputKey(cli: ListedCli): string {
  return [
    cli.terminalViewers ? "2.5" : "2.4",
    cli.slug ?? "",
    cli.publicKey ?? "",
    cli.identityPublicKey ?? "",
    cli.identitySignature ?? "",
  ].join("|");
}

function decode(value: string, length: number): Uint8Array | null {
  try {
    const bytes = base64UrlToBytes(value);
    return bytes.byteLength === length ? bytes : null;
  } catch {
    return null;
  }
}

async function fingerprintOf(identityPublicKey: string): Promise<string | null> {
  const raw = decode(identityPublicKey, 65);
  return raw ? cliIdentityFingerprint(raw) : null;
}

async function readPin(store: CliPinStore, cliDeviceId: string): Promise<string | null | "error"> {
  try {
    return await store.get(cliDeviceId);
  } catch {
    return "error";
  }
}

/** Verifies the signature over the listed terminal key before anything else. */
async function verifiedIdentity(
  cli: ListedCli,
): Promise<{ identityPublicKey: string; terminalPublicKey: string; fingerprint: string } | null> {
  if (!cli.publicKey || !cli.slug || !cli.identityPublicKey || !cli.identitySignature) return null;
  const identity = decode(cli.identityPublicKey, 65);
  const signature = decode(cli.identitySignature, 64);
  const ecdh = decode(cli.publicKey, 65);
  if (!identity || !signature || !ecdh) return null;
  const valid = await verifyCliIdentitySignature({
    identityPublicKey: identity,
    signature,
    cliSlug: cli.slug,
    ecdhPublicKey: ecdh,
  });
  if (!valid) return null;
  return {
    identityPublicKey: cli.identityPublicKey,
    terminalPublicKey: cli.publicKey,
    fingerprint: await cliIdentityFingerprint(identity),
  };
}

/**
 * A CLI is live when the relay lists its per-start terminal key: the relay
 * only lists one for a connected CLI speaking protocol 2.4 or later. An offline
 * CLI reports no protocol version, so `terminalViewers` says nothing about it.
 */
function cliIsLive(cli: ListedCli): boolean {
  return cli.publicKey !== null;
}

/** Verify, then pin on first use. Never replaces an existing pin. */
export async function evaluateCliTrust(cli: ListedCli, store: CliPinStore): Promise<CliTrust> {
  if (!cliIsLive(cli)) return { status: "offline" };
  const pinned = await readPin(store, cli.cliDeviceId);
  const pinnedFingerprint = pinned && pinned !== "error" ? await fingerprintOf(pinned) : null;
  if (!cli.terminalViewers) {
    // A live pinned CLI that now speaks 2.4 no longer proves its identity.
    if (pinned && pinned !== "error" && pinnedFingerprint) {
      return { status: "changed", pinnedFingerprint, fingerprint: null, identityPublicKey: null };
    }
    return { status: "unverified" };
  }
  const verified = await verifiedIdentity(cli);
  if (!verified) return { status: "invalid" };
  const { fingerprint, identityPublicKey, terminalPublicKey } = verified;
  if (pinned === "error") return { status: "unpinned", fingerprint, terminalPublicKey };
  if (pinned === null || !pinnedFingerprint) {
    try {
      await store.put(cli.cliDeviceId, identityPublicKey);
    } catch {
      return { status: "unpinned", fingerprint, terminalPublicKey };
    }
    return { status: "trusted", fingerprint, terminalPublicKey, firstUse: true };
  }
  if (pinned === identityPublicKey) {
    return { status: "trusted", fingerprint, terminalPublicKey, firstUse: false };
  }
  return { status: "changed", pinnedFingerprint, fingerprint, identityPublicKey };
}

/** Whether the pin still has the fingerprint the user was shown. */
async function pinStillMatches(
  store: CliPinStore,
  cliDeviceId: string,
  pinnedFingerprint: string,
): Promise<boolean> {
  const pinned = await store.get(cliDeviceId);
  return pinned !== null && (await fingerprintOf(pinned)) === pinnedFingerprint;
}

/**
 * The user confirmed the `changed` state shown in the dialog (`shown` is the
 * snapshot taken when it opened). Pins exactly that key, and only while the
 * relay still lists it with a valid signature over the CLI's current terminal
 * key and the pin is still the one shown. Anything else pins nothing and
 * returns the fresh evaluation. A CLI that stopped proving an identity loses
 * its pin only while it is still a live 2.4 CLI.
 */
export async function trustNewCliKey(
  cli: ListedCli,
  shown: ChangedCliTrust,
  store: CliPinStore,
): Promise<CliTrust> {
  if (!(await pinStillMatches(store, cli.cliDeviceId, shown.pinnedFingerprint))) {
    return evaluateCliTrust(cli, store);
  }
  if (shown.identityPublicKey === null) {
    // Only a live 2.4 CLI may drop the pin. An offline one keeps it.
    if (cli.terminalViewers || !cliIsLive(cli)) return evaluateCliTrust(cli, store);
    await store.remove(cli.cliDeviceId);
    return evaluateCliTrust(cli, store);
  }
  if (!cliIsLive(cli) || cli.identityPublicKey !== shown.identityPublicKey) {
    return evaluateCliTrust(cli, store);
  }
  const verified = await verifiedIdentity(cli);
  if (!verified) return { status: "invalid" };
  if (verified.fingerprint !== shown.fingerprint) return evaluateCliTrust(cli, store);
  await store.put(cli.cliDeviceId, verified.identityPublicKey);
  return {
    status: "trusted",
    fingerprint: verified.fingerprint,
    terminalPublicKey: verified.terminalPublicKey,
    firstUse: false,
  };
}

/** Whether `trustNewCliKey` applied the confirmed snapshot rather than re-evaluating. */
export function trustAppliedSnapshot(shown: ChangedCliTrust, result: CliTrust): boolean {
  if (shown.identityPublicKey === null) return result.status === "unverified";
  return result.status === "trusted" && result.fingerprint === shown.fingerprint;
}

const PIN_DB = "wsmp-terminal-cli-pins";
const PIN_STORE = "pins";

type PinRecord = { identityPublicKey: string; pinnedAt: number };

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
  });
}

function openPinDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PIN_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PIN_STORE)) db.createObjectStore(PIN_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("pin database failed"));
  });
}

async function withPinStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openPinDb();
  try {
    return await requestToPromise(run(db.transaction(PIN_STORE, mode).objectStore(PIN_STORE)));
  } finally {
    db.close();
  }
}

/** Per-origin IndexedDB pins. Rejects when IndexedDB is unavailable. */
export const indexedDbCliPinStore: CliPinStore = {
  async get(cliDeviceId) {
    const stored: unknown = await withPinStore("readonly", (store) => store.get(cliDeviceId));
    if (!stored || typeof stored !== "object") return null;
    const key = (stored as Partial<PinRecord>).identityPublicKey;
    return typeof key === "string" ? key : null;
  },
  async put(cliDeviceId, identityPublicKey) {
    const record: PinRecord = { identityPublicKey, pinnedAt: Date.now() };
    await withPinStore("readwrite", (store) => store.put(record, cliDeviceId));
  },
  async remove(cliDeviceId) {
    await withPinStore("readwrite", (store) => store.delete(cliDeviceId));
  },
};

/** In-memory pins, for tests. */
export function createMemoryCliPinStore(initial?: Record<string, string>): CliPinStore & {
  pins: Map<string, string>;
} {
  const pins = new Map(Object.entries(initial ?? {}));
  return {
    pins,
    async get(cliDeviceId) {
      return pins.get(cliDeviceId) ?? null;
    },
    async put(cliDeviceId, identityPublicKey) {
      pins.set(cliDeviceId, identityPublicKey);
    },
    async remove(cliDeviceId) {
      pins.delete(cliDeviceId);
    },
  };
}
