import { describe, expect, it } from "vitest";

import {
  buildCliIdentityStatement,
  bytesToBase64Url,
  generateEphemeralHandshake,
} from "@/hooks/use-terminal-crypto";
import {
  type CliPinStore,
  createMemoryCliPinStore,
  evaluateCliTrust,
  trustAllowsHandshake,
  trustNewCliKey,
} from "@/lib/terminal-cli-identity";
import type { ListedCli } from "@/lib/terminal-protocol";

async function signedCli(): Promise<ListedCli> {
  const ecdh = await generateEphemeralHandshake();
  const identity = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.privateKey,
    Uint8Array.from(buildCliIdentityStatement("desk-01", ecdh.publicKeyRaw)),
  );
  return {
    cliDeviceId: "cli-1",
    slug: "desk-01",
    publicKey: ecdh.publicKeyB64,
    terminalViewers: true,
    identityPublicKey: bytesToBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("raw", identity.publicKey)),
    ),
    identitySignature: bytesToBase64Url(new Uint8Array(signature)),
  };
}

const brokenStore: CliPinStore = {
  get: async () => {
    throw new Error("no indexedDB");
  },
  put: async () => {
    throw new Error("no indexedDB");
  },
  remove: async () => {
    throw new Error("no indexedDB");
  },
};

describe("CLI identity trust", () => {
  it("pins on first use and expects the signed terminal key", async () => {
    const cli = await signedCli();
    const store = createMemoryCliPinStore();
    const trust = await evaluateCliTrust(cli, store);
    expect(trust).toMatchObject({ status: "trusted", firstUse: true });
    expect(store.pins.get("cli-1")).toBe(cli.identityPublicKey);
    expect(trustAllowsHandshake(trust)).toEqual({
      ok: true,
      expectedCliPublicKey: cli.publicKey,
    });
    expect(await evaluateCliTrust(cli, store)).toMatchObject({
      status: "trusted",
      firstUse: false,
    });
  });

  it("refuses a relay-swapped terminal key signed by nobody", async () => {
    const cli = await signedCli();
    const swapped = { ...cli, publicKey: (await generateEphemeralHandshake()).publicKeyB64 };
    const trust = await evaluateCliTrust(swapped, createMemoryCliPinStore());
    expect(trust).toEqual({ status: "invalid" });
    expect(trustAllowsHandshake(trust)).toEqual({ ok: false });
  });

  it("pins exactly the key the user was shown", async () => {
    const first = await signedCli();
    const store = createMemoryCliPinStore();
    await evaluateCliTrust(first, store);
    const second = await signedCli();
    const shown = await evaluateCliTrust(second, store);
    if (shown.status !== "changed") throw new Error("expected a changed identity");
    expect(trustAllowsHandshake(shown)).toEqual({ ok: false });
    // The relay lists a third identity after the user saw the second.
    const third = await signedCli();
    const result = await trustNewCliKey(third, shown, store);
    expect(result.status).toBe("changed");
    expect(store.pins.get("cli-1")).toBe(first.identityPublicKey);
    await trustNewCliKey(second, shown, store);
    expect(store.pins.get("cli-1")).toBe(second.identityPublicKey);
  });

  it("pins nothing when the pin itself changed after the key was shown", async () => {
    const first = await signedCli();
    const store = createMemoryCliPinStore();
    await evaluateCliTrust(first, store);
    const second = await signedCli();
    const shown = await evaluateCliTrust(second, store);
    if (shown.status !== "changed") throw new Error("expected a changed identity");
    // Another tab of this browser pinned a different key meanwhile.
    const other = await signedCli();
    if (!other.identityPublicKey) throw new Error("expected an identity");
    store.pins.set("cli-1", other.identityPublicKey);
    expect((await trustNewCliKey(second, shown, store)).status).toBe("changed");
    expect(store.pins.get("cli-1")).toBe(other.identityPublicKey);
  });

  it("treats a pinned CLI that falls back to 2.4 as changed until allowed", async () => {
    const cli = await signedCli();
    const store = createMemoryCliPinStore();
    await evaluateCliTrust(cli, store);
    const legacy = {
      ...cli,
      terminalViewers: false,
      identityPublicKey: null,
      identitySignature: null,
    };
    const trust = await evaluateCliTrust(legacy, store);
    expect(trust).toMatchObject({ status: "changed", fingerprint: null });
    if (trust.status !== "changed") throw new Error("expected a changed identity");
    expect(await trustNewCliKey(legacy, trust, store)).toEqual({ status: "unverified" });
    expect(store.pins.size).toBe(0);
  });

  it("treats a disconnected pinned CLI as offline and keeps its pin", async () => {
    const cli = await signedCli();
    const store = createMemoryCliPinStore();
    await evaluateCliTrust(cli, store);
    // An offline CLI has no live protocol version and no terminal key.
    const offline: ListedCli = {
      ...cli,
      publicKey: null,
      terminalViewers: false,
      identityPublicKey: null,
      identitySignature: null,
    };
    const trust = await evaluateCliTrust(offline, store);
    expect(trust).toEqual({ status: "offline" });
    expect(trustAllowsHandshake(trust)).toEqual({ ok: false });
    expect(store.pins.get("cli-1")).toBe(cli.identityPublicKey);
  });

  it("never drops a pin for a CLI that went offline after the warning", async () => {
    const cli = await signedCli();
    const store = createMemoryCliPinStore();
    await evaluateCliTrust(cli, store);
    const legacy = {
      ...cli,
      terminalViewers: false,
      identityPublicKey: null,
      identitySignature: null,
    };
    const shown = await evaluateCliTrust(legacy, store);
    if (shown.status !== "changed") throw new Error("expected a changed identity");
    const offline = { ...legacy, publicKey: null };
    expect(await trustNewCliKey(offline, shown, store)).toEqual({ status: "offline" });
    expect(store.pins.get("cli-1")).toBe(cli.identityPublicKey);
  });

  it("treats an offline CLI without a pin as offline, not unverified", async () => {
    const cli = await signedCli();
    const offline = { ...cli, publicKey: null, terminalViewers: false };
    expect(await evaluateCliTrust(offline, createMemoryCliPinStore())).toEqual({
      status: "offline",
    });
  });

  it("allows a verified CLI without a pin when storage fails", async () => {
    const cli = await signedCli();
    expect(await evaluateCliTrust(cli, brokenStore)).toMatchObject({ status: "unpinned" });
    expect(await evaluateCliTrust({ ...cli, identitySignature: null }, brokenStore)).toEqual({
      status: "invalid",
    });
  });
});
