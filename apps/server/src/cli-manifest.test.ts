/**
 * `GET /cli/manifest.json` (wsmp self-update): what the server would install, read from the
 * release's `sha256.sum`. Fails closed: no checksums, no update.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_URL: "https://proxy.example.com", NODE_ENV: "test", WMP_RATE_LIMIT_SCALE: 1 },
}));
vi.mock("@ws-model-proxy/api/nodes/enroll-exchange", () => ({
  exchangeEnrollmentCode: vi.fn(),
  findEnrollmentCodeOwner: vi.fn(),
}));

const {
  CLI_MANIFEST_PATH,
  CliManifestUnavailable,
  cargoInstallCommand,
  cliInstallCommit,
  cliManifestHandler,
  createCliManifestCache,
  parseSha256Sum,
  readCliReleaseManifest,
  defaultCliReleaseBaseUrl,
} = await import("./node-http.js");
const { SERVER_VERSION } = await import("./version.js");

const RELEASE = "https://releases.example.com/wsmp/v0.4.3";
const LINUX = "a".repeat(64);
const WINDOWS = "b".repeat(64);
const SUMS = `${"0".repeat(64)}  source.tar.gz\n${LINUX}  wsmp-x86_64-unknown-linux-gnu.tar.xz\r\n${WINDOWS.toUpperCase()} *wsmp-x86_64-pc-windows-msvc.zip\n\n`;

function fetchStub(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response("missing", { status: 404 });
  });
  return { fetchImpl, calls };
}

describe("sha256.sum", () => {
  it("lists every wsmp archive by target, lower-case", () => {
    expect(parseSha256Sum(SUMS, RELEASE)).toEqual({
      "x86_64-unknown-linux-gnu": {
        url: `${RELEASE}/wsmp-x86_64-unknown-linux-gnu.tar.xz`,
        sha256: LINUX,
      },
      "x86_64-pc-windows-msvc": {
        url: `${RELEASE}/wsmp-x86_64-pc-windows-msvc.zip`,
        sha256: WINDOWS,
      },
    });
  });

  it("refuses a malformed line for an archive and an archive listed twice", () => {
    expect(() => parseSha256Sum(`xyz  wsmp-x86_64-unknown-linux-gnu.tar.xz\n`, RELEASE)).toThrow(
      CliManifestUnavailable,
    );
    expect(() =>
      parseSha256Sum(
        `${LINUX}  wsmp-x86_64-unknown-linux-gnu.tar.xz\n${WINDOWS}  wsmp-x86_64-unknown-linux-gnu.tar.xz\n`,
        RELEASE,
      ),
    ).toThrow(CliManifestUnavailable);
  });
});

describe("the release manifest", () => {
  it("reads the release's checksums", async () => {
    const { fetchImpl } = fetchStub({ [`${RELEASE}/sha256.sum`]: () => new Response(SUMS) });
    const manifest = await readCliReleaseManifest(
      { kind: "release", baseUrl: `${RELEASE}/` },
      fetchImpl,
    );
    expect(manifest).toMatchObject({
      version: SERVER_VERSION,
      commit: null,
      releaseUrl: RELEASE,
      sourceBuild: false,
    });
    expect(Object.keys(manifest.artifacts).sort()).toEqual([
      "x86_64-pc-windows-msvc",
      "x86_64-unknown-linux-gnu",
    ]);
  });

  it("is a source build with no artifacts when the server builds wsmp from source", async () => {
    const { fetchImpl } = fetchStub({});
    const rev = "0123456789abcdef0123456789abcdef01234567";
    expect(await readCliReleaseManifest({ kind: "source", rev }, fetchImpl)).toEqual({
      version: SERVER_VERSION,
      commit: rev,
      releaseUrl: null,
      sourceBuild: true,
      artifacts: {},
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cargoInstallCommand({ kind: "source", rev })).toBe(
      `cargo install --git https://github.com/FlyCockpit/ws-model-proxy --rev ${rev} --locked --force wsmp`,
    );
  });

  it("fails closed: a missing sha256.sum, one with no archive, or a redirect away from https", async () => {
    const source = { kind: "release" as const, baseUrl: RELEASE };
    await expect(readCliReleaseManifest(source, fetchStub({}).fetchImpl)).rejects.toBeInstanceOf(
      CliManifestUnavailable,
    );
    await expect(
      readCliReleaseManifest(
        source,
        fetchStub({ [`${RELEASE}/sha256.sum`]: () => new Response(`${LINUX}  other.tar.gz\n`) })
          .fetchImpl,
      ),
    ).rejects.toBeInstanceOf(CliManifestUnavailable);
    await expect(
      readCliReleaseManifest(
        source,
        fetchStub({
          [`${RELEASE}/sha256.sum`]: () =>
            new Response(null, { status: 302, headers: { location: "http://plain.example/sums" } }),
        }).fetchImpl,
      ),
    ).rejects.toBeInstanceOf(CliManifestUnavailable);
    await expect(
      readCliReleaseManifest(source, async () => {
        throw new TypeError("network down");
      }),
    ).rejects.toBeInstanceOf(CliManifestUnavailable);
  });

  it("follows an https redirect (GitHub release downloads)", async () => {
    const { fetchImpl, calls } = fetchStub({
      [`${RELEASE}/sha256.sum`]: () =>
        new Response(null, { status: 302, headers: { location: "https://objects.example/s" } }),
      "https://objects.example/s": () => new Response(SUMS),
    });
    await readCliReleaseManifest({ kind: "release", baseUrl: RELEASE }, fetchImpl);
    expect(calls).toEqual([`${RELEASE}/sha256.sum`, "https://objects.example/s"]);
  });

  it("caches a read, and retries a failure soon", async () => {
    let time = 0;
    let ok = false;
    const fetchImpl = vi.fn(async () =>
      ok ? new Response(SUMS) : new Response("no", { status: 404 }),
    );
    const cache = createCliManifestCache({
      source: () => ({ kind: "release", baseUrl: RELEASE }),
      fetch: fetchImpl,
      now: () => time,
    });
    await expect(cache.get()).rejects.toBeInstanceOf(CliManifestUnavailable);
    ok = true;
    await expect(cache.get()).rejects.toBeInstanceOf(CliManifestUnavailable);
    time = 31_000;
    await expect(cache.get()).resolves.toMatchObject({ sourceBuild: false });
    time = 200_000;
    await cache.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("GET /cli/manifest.json", () => {
  it("answers the manifest, and 503 when the checksums cannot be read", async () => {
    const good = new Hono();
    const manifest = {
      version: SERVER_VERSION,
      commit: null,
      releaseUrl: RELEASE,
      sourceBuild: false,
      artifacts: {},
    };
    good.get(CLI_MANIFEST_PATH, cliManifestHandler({ get: async () => manifest }));
    const ok = await good.request(CLI_MANIFEST_PATH);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual(manifest);

    const bad = new Hono();
    bad.get(
      CLI_MANIFEST_PATH,
      cliManifestHandler({
        get: async () => {
          throw new CliManifestUnavailable("sha256.sum answered 404.");
        },
      }),
    );
    const refused = await bad.request(CLI_MANIFEST_PATH);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error: "manifest_unavailable",
      message: "sha256.sum answered 404.",
    });
  });
});

describe("cliInstallCommit", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("vouches for this image's commit only while it serves its own version's release", () => {
    const own = { kind: "release" as const, baseUrl: defaultCliReleaseBaseUrl() };
    expect(cliInstallCommit(own, SHA)).toBe(SHA);
    // Not a commit (a dev build id), or no build id: compare by version only.
    expect(cliInstallCommit(own, "local-dev")).toBeNull();
    expect(cliInstallCommit(own, undefined)).toBeNull();
    // Binaries from elsewhere, or a preview-branch build: their commit is not this image's.
    expect(cliInstallCommit({ kind: "release", baseUrl: RELEASE }, SHA)).toBeNull();
    expect(cliInstallCommit({ ...own, fallbackBranch: "preview" }, SHA)).toBeNull();
  });

  it("names a pinned source build's rev", () => {
    expect(cliInstallCommit({ kind: "source", rev: SHA }, undefined)).toBe(SHA);
    expect(cliInstallCommit({ kind: "source" }, SHA)).toBeNull();
  });
});
