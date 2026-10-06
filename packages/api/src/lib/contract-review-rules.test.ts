import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inviteAcceptance, inviteEmailKey, type PendingInvite } from "./invite-acceptance";
import { isFabricIp } from "./ip-literal";
import { previewFingerprint } from "./preview-fingerprint";
import { planProfileHolds } from "./profile-holds";
import { fabricIpSchema, runtimeBaseUrlSchema, runtimeSpecWarnings } from "./runtime-spec";

const repoRoot = join(import.meta.dirname, "../../../..");
const fabricVectors = JSON.parse(
  readFileSync(join(repoRoot, "apps/cli/tests/fixtures/relay-3.0/rules/fabric-ip.json"), "utf8"),
) as { valid: string[]; invalid: string[] };

describe("fabric IP literals (shared with Rust and SQL)", () => {
  it("accepts exactly the shared valid vectors", () => {
    for (const value of fabricVectors.valid) {
      expect(isFabricIp(value), value).toBe(true);
      expect(fabricIpSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it("refuses every shared invalid vector (shell text, brackets, unspecified, loopback)", () => {
    for (const value of fabricVectors.invalid) {
      expect(isFabricIp(value), value).toBe(false);
      expect(fabricIpSchema.safeParse(value).success, value).toBe(false);
    }
    for (const value of ["[$(curl x|sh)]", "[;reboot]", "[::]", "0.0.0.0", "::", "127.0.0.1"])
      expect(fabricVectors.invalid, value).toContain(value);
    expect(fabricVectors.valid).toContain("fd00::1");
  });

  it("still takes bracketed IPv6 hosts in runtime addresses (the URL parser checked them)", () => {
    expect(runtimeBaseUrlSchema.safeParse("http://[fd00::1]:8000").success).toBe(true);
    expect(runtimeBaseUrlSchema.safeParse("http://127.0.0.1:8000").success).toBe(true);
    expect(runtimeBaseUrlSchema.safeParse("http://example.com:8000").success).toBe(false);
  });
});

describe("binds_all_interfaces", () => {
  const spec = (command: string) =>
    ({ launch: { commands: [{ start: command }] } }) as unknown as Parameters<
      typeof runtimeSpecWarnings
    >[0];
  it.each([
    "python -m server --host 0.0.0.0",
    "curl http://0.0.0.0:8000/health",
    "server --bind [::]:8000",
    "vllm serve Qwen/Qwen3-8B --port {{port}}",
  ])("warns for %s", (command) => {
    expect(runtimeSpecWarnings(spec(command))).toEqual(["binds_all_interfaces"]);
  });
  it.each([
    "vllm serve Qwen/Qwen3-8B --host 127.0.0.1 --port {{port}}",
    "server --host {{fabric_ip}}",
    "ping fd00::1",
  ])("does not warn for %s", (command) => {
    expect(runtimeSpecWarnings(spec(command))).toEqual([]);
  });
});

describe("profile apply and node holds", () => {
  const held = (holdProfileId: string | null) => ({ holdAt: new Date(0), holdProfileId });
  const line = (nodeId: string, hold = false) => ({ nodeId, hold, holdNote: null });

  it("an agent's apply never releases a person's hold (it is refused with node_held)", () => {
    // A person holds X; an agent saves a profile owning X (no hold line) and applies it.
    const plan = planProfileHolds({
      profileId: "agent-profile",
      caller: "agent",
      nodes: [line("x")],
      current: new Map([["x", held(null)]]),
    });
    expect(plan).toEqual({ ok: false, reason: "node_held", nodeIds: ["x"] });
  });

  it("an agent's apply never releases another profile's hold", () => {
    const plan = planProfileHolds({
      profileId: "b",
      caller: "agent",
      nodes: [line("x")],
      current: new Map([["x", held("a")]]),
    });
    expect(plan.ok).toBe(false);
  });

  it("releases only this profile's own holds and keeps others' holds under a hold line", () => {
    const plan = planProfileHolds({
      profileId: "p",
      caller: "agent",
      nodes: [line("own"), line("free"), line("person", true), line("new", true)],
      current: new Map([
        ["own", held("p")],
        ["person", held(null)],
      ]),
    });
    expect(plan).toEqual({
      ok: true,
      hold: [{ nodeId: "new", note: null }],
      release: ["own"],
      keep: ["person"],
    });
  });

  it("a person's confirmed apply may release any hold on an owned node", () => {
    const plan = planProfileHolds({
      profileId: "p",
      caller: "person",
      nodes: [line("x"), line("y")],
      current: new Map([
        ["x", held(null)],
        ["y", held("other")],
      ]),
    });
    expect(plan).toEqual({ ok: true, hold: [], release: ["x", "y"], keep: [] });
  });
});

describe("preview fingerprint", () => {
  const preview = {
    fingerprint: "0".repeat(64),
    starts: [],
    stops: [],
    kept: [],
    holds: [{ nodeId: "x", change: "hold", heldBy: null, note: null }],
    warnings: [],
    refusals: [],
  };
  it("covers the hold changes a person confirms, and ignores its own field", () => {
    const base = previewFingerprint(preview);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(previewFingerprint({ ...preview, fingerprint: base })).toBe(base);
    expect(
      previewFingerprint({
        ...preview,
        holds: [{ nodeId: "x", change: "release", heldBy: "person", note: null }],
      }),
    ).not.toBe(base);
    expect(previewFingerprint({ ...preview, holds: [] })).not.toBe(base);
  });
});

describe("invite acceptance", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const invite = (overrides: Partial<PendingInvite> = {}): PendingInvite => ({
    id: "inv",
    email: "a@example.com",
    expiresAt: new Date("2026-10-07T00:00:00Z"),
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  });

  it("accepts through the link whatever the account's e-mail", () => {
    expect(
      inviteAcceptance({
        account: { email: "other@example.com", emailVerified: false },
        linkInvite: invite(),
        emailInvites: [],
        now,
      }),
    ).toEqual({ accept: true, inviteIds: ["inv"] });
  });

  it("refuses an e-mail match without verification (SMTP off: link only)", () => {
    expect(
      inviteAcceptance({
        account: { email: "A@example.com ", emailVerified: false },
        linkInvite: null,
        emailInvites: [invite()],
        now,
      }),
    ).toEqual({ accept: false, reason: "invite_needs_link" });
  });

  it("folds ASCII case only, as SQL lower() does (no Kelvin-sign match)", () => {
    expect(inviteEmailKey(" A@Example.COM ")).toBe("a@example.com");
    expect(inviteEmailKey("\u212Aate@example.com")).toBe("\u212Aate@example.com");
    expect(
      inviteAcceptance({
        account: { email: "\u212Aate@example.com", emailVerified: true },
        linkInvite: null,
        emailInvites: [invite({ email: "kate@example.com" })],
        now,
      }),
    ).toEqual({ accept: false, reason: "none" });
  });

  it("accepts a verified e-mail match, never an expired, revoked or accepted invite", () => {
    expect(
      inviteAcceptance({
        account: { email: "a@example.com", emailVerified: true },
        linkInvite: invite({ id: "expired", expiresAt: new Date("2026-10-01T00:00:00Z") }),
        emailInvites: [
          invite({ id: "ok" }),
          invite({ id: "revoked", revokedAt: now }),
          invite({ id: "accepted", acceptedAt: now }),
        ],
        now,
      }),
    ).toEqual({ accept: true, inviteIds: ["ok"] });
  });
});
