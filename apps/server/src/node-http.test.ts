import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  // rate-limit.ts builds its limiters at import from the built-in table.
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com/app",
    NODE_ENV: "test",
    WMP_RATE_LIMIT_SCALE: 1,
  },
}));
vi.mock("@ws-model-proxy/api/nodes/enroll-exchange", () => ({
  exchangeEnrollmentCode: vi.fn(),
  findEnrollmentCodeOwner: vi.fn(),
}));
vi.mock("./client-ip.js", () => ({ resolveClientIp: () => "203.0.113.9" }));

const {
  CLI_PREVIEW_BRANCH,
  CLI_RELEASE_BINARIES_BY_DEFAULT,
  CLI_REPOSITORY,
  SERVER_VERSION,
  cliInstallSource,
  installScript,
  registerNodeHttpRoutes,
} = await import("./node-http.js");
const { env } = await import("@ws-model-proxy/env/server");

const CODE = `wsmp_enr_${"A".repeat(26)}`;
const KEY = `B${"A".repeat(85)}A`;
const body = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ code: CODE, identityPublicKey: KEY, slug: "desk-01", ...overrides });

function limiter(points: number) {
  return new RateLimiterMemory({ keyPrefix: `t-${Math.random()}`, points, duration: 60 });
}

function app(overrides: Parameters<typeof registerNodeHttpRoutes>[1] = {}) {
  const exchange = vi.fn(async () => ({
    response: {
      ok: true as const,
      nodeId: "node-1",
      slug: "desk-01",
      credential: `wsmp_node_${"x".repeat(43)}`,
      replaced: null,
      trustLowerPending: false,
      removeAfterOfflineMs: 3_600_000,
    },
    ownerUserId: "owner-1",
    revokedCredentialIds: ["cred-old"],
  }));
  const findOwner = vi.fn(async () => ({ ownerUserId: "owner-1" }));
  const closeRevokedSessions = vi.fn(async () => undefined);
  const hono = new Hono();
  registerNodeHttpRoutes(hono, {
    ipLimiter: limiter(10),
    userLimiter: limiter(20),
    exchange,
    findOwner,
    closeRevokedSessions,
    ...overrides,
  });
  const post = (text: string) =>
    hono.request("/api/node/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
    });
  return { hono, post, exchange, findOwner, closeRevokedSessions };
}

describe("node bootstrap HTTP", () => {
  it("serves the well-known document with the canonical origin and enroll path", async () => {
    const res = await app().hono.request("/.well-known/wsmp");
    expect(await res.json()).toEqual({
      serverVersion: "0.4.0",
      protocolVersion: "3.0",
      origin: "https://proxy.example.com",
      installScript: "/install.sh",
      enrollPath: "/api/node/enroll",
    });
  });

  it("serves the preview-branch source build until the release flip, unconfigured", async () => {
    const res = await app().hono.request("/install.sh");
    expect(res.headers.get("content-type")).toContain("shellscript");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    // Neither WMP_CLI_SOURCE_REV nor WMP_CLI_RELEASE_BASE_URL is set in this env mock.
    expect(text).toBe(
      installScript("https://proxy.example.com", cliInstallSource(undefined, undefined)),
    );
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    if (CLI_RELEASE_BINARIES_BY_DEFAULT) {
      expect(text).toContain(
        `WSMP_RELEASE_URL='${CLI_REPOSITORY}/releases/download/v${SERVER_VERSION}'`,
      );
    } else {
      expect(text).toContain("WSMP_RELEASE_URL=''");
      expect(text).toContain(`install_source --branch '${CLI_PREVIEW_BRANCH}'`);
    }
    // A download cut short runs nothing: the only top-level command is the last line.
    expect(text.endsWith('\nmain "$@"\n')).toBe(true);
  });

  it("serves the verified release-binary installer when WMP_CLI_RELEASE_BASE_URL is set", async () => {
    const mirror = "https://mirror.example.com/wsmp/v0.4.0";
    Object.assign(env, { WMP_CLI_RELEASE_BASE_URL: mirror });
    try {
      const text = await (await app().hono.request("/install.sh")).text();
      expect(text).toContain(`WSMP_RELEASE_URL='${mirror}'`);
      expect(text).toContain(
        CLI_RELEASE_BINARIES_BY_DEFAULT
          ? `install_source --tag 'v${SERVER_VERSION}'`
          : `install_source --branch '${CLI_PREVIEW_BRANCH}'`,
      );
      // A pinned commit still wins.
      Object.assign(env, { WMP_CLI_SOURCE_REV: "a".repeat(40) });
      const pinned = await (await app().hono.request("/install.sh")).text();
      expect(pinned).toContain("WSMP_RELEASE_URL=''");
      expect(pinned).toContain(`install_source --rev '${"a".repeat(40)}'`);
    } finally {
      Object.assign(env, { WMP_CLI_RELEASE_BASE_URL: undefined, WMP_CLI_SOURCE_REV: undefined });
    }
  });

  it("finds rustup's cargo over a non-interactive shell that never read the profile", () => {
    const home = mkdtempSync(join(tmpdir(), "wsmp-install-"));
    try {
      const bin = join(home, ".cargo", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "cargo"), '#!/bin/sh\necho "fake cargo $*"\n');
      chmodSync(join(bin, "cargo"), 0o755);
      writeFileSync(join(home, ".cargo", "env"), `export PATH="${bin}:$PATH"\n`);
      const script = join(home, "install.sh");
      writeFileSync(script, installScript("https://proxy.example.com", { kind: "source" }));
      const run = (extra: Record<string, string> = {}) =>
        execFileSync("/bin/sh", [script], {
          // Only builtins and the fake cargo: a cargo on the host must not satisfy the check.
          env: { HOME: home, PATH: join(home, "no-tools"), ...extra },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      expect(run()).toContain("fake cargo install --git");
      // CARGO_HOME wins when set.
      const cargoHome = join(home, "custom");
      mkdirSync(cargoHome);
      writeFileSync(join(cargoHome, "env"), `export PATH="${bin}:$PATH"\n`);
      rmSync(join(home, ".cargo", "env"));
      expect(run({ CARGO_HOME: cargoHome })).toContain("fake cargo install --git");
      // A CARGO_HOME env file that does not provide cargo falls through to ~/.cargo/env.
      writeFileSync(join(cargoHome, "env"), "true\n");
      writeFileSync(join(home, ".cargo", "env"), `export PATH="${bin}:$PATH"\n`);
      expect(run({ CARGO_HOME: cargoHome })).toContain("fake cargo install --git");
      rmSync(join(home, ".cargo", "env"));
      // Without any env file the installer still refuses clearly.
      expect(() => run()).toThrow(/cargo is not installed/);
      // Also with HOME unset (no `parameter not set` abort).
      expect(() =>
        execFileSync("/bin/sh", [script], {
          env: { PATH: join(home, "no-tools") },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ).toThrow(/cargo is not installed/);
      // A cargo on PATH with HOME and CARGO_HOME unset: a clear message, not a shell error.
      expect(() =>
        execFileSync("/bin/sh", [script], {
          env: { PATH: bin },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ).toThrow(/set HOME \(or CARGO_HOME\)/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("enrolls and closes the sessions of credentials the exchange revoked", async () => {
    const { post, exchange, closeRevokedSessions } = app();
    const res = await post(body());
    expect(res.status).toBe(200);
    // The credential is in this body: never cached.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      ok: true,
      nodeId: "node-1",
      removeAfterOfflineMs: 3_600_000,
    });
    expect(exchange).toHaveBeenCalledWith(
      expect.objectContaining({ code: CODE, slug: "desk-01", replaceConfirmed: false }),
    );
    expect(closeRevokedSessions).toHaveBeenCalledWith(["cred-old"]);
  });

  it("answers a malformed request without naming fields (the code may be in it)", async () => {
    const { post, findOwner } = app();
    for (const text of ["{nope", body({ code: "wsmp_enr_short" }), body({ extra: 1 })]) {
      const res = await post(text);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "invalid_code" });
    }
    expect(findOwner).not.toHaveBeenCalled();
  });

  it("charges the IP budget before any lookup (successes give it back), then the owner's", async () => {
    const byIp = app({ ipLimiter: limiter(1) });
    // A fleet behind one address: successful enrollments do not use up the IP budget.
    expect((await byIp.post(body())).status).toBe(200);
    expect((await byIp.post(body())).status).toBe(200);
    // A failure keeps its point; the next attempt from that address is refused before lookup.
    expect((await byIp.post("{nope")).status).toBe(400);
    const limited = await byIp.post(body());
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ ok: false, error: "rate_limited" });
    expect(byIp.findOwner).toHaveBeenCalledTimes(2);

    const byOwner = app({ userLimiter: limiter(1) });
    expect((await byOwner.post(body())).status).toBe(200);
    expect((await byOwner.post(body())).status).toBe(429);
    expect(byOwner.exchange).toHaveBeenCalledTimes(1);
  });

  it("passes a refusal through and never exchanges an unusable code", async () => {
    const { post, exchange } = app({
      findOwner: vi.fn(async () => ({
        refusal: { ok: false as const, error: "expired" as const },
      })),
    });
    const res = await post(body());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "expired" });
    expect(exchange).not.toHaveBeenCalled();
  });
});
