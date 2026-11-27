import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvConfigError } from "@ws-model-proxy/env/config-error";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PasswordPepperKeyError } from "../../../packages/auth/src/password-pepper.js";
import { reportBootError } from "./boot-error.js";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(SERVER_DIR, "node_modules", ".bin");

// The repro from follow-up 02: MCP on by default, plain http on a LAN address.
const LAN_HTTP_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  WSMP_DISABLE_DOTENV: "1",
  NODE_ENV: "production",
  TRUST_PROXY_HOPS: "0",
  // Never reached: the env guard refuses first.
  DATABASE_URL: "postgresql://boot-test@127.0.0.1:1/boot_test",
  SERVER_PORT: "1",
  BETTER_AUTH_URL: "http://192.168.1.10:3999",
  BETTER_AUTH_SECRET: "w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB-boot-test-Q8r",
};

const EXPECTED_STDERR =
  "[server] FATAL: [env] BETTER_AUTH_URL=http://192.168.1.10:3999 uses plain http on a host " +
  "that is not loopback, and the MCP server (WMP_MCP_ENABLED, on by default) requires https " +
  "there. Fix one of: set BETTER_AUTH_URL to the public https origin (e.g. " +
  "https://wsmp.example.com); for local use only, set it to http://localhost:<port> or " +
  "http://127.0.0.1:<port>; or set WMP_MCP_ENABLED=false to run without the MCP server.";

// Bundles go under apps/server/node_modules so the bundle's external packages
// resolve exactly as they do from apps/server/dist.
const CACHE = join(SERVER_DIR, "node_modules", ".cache");
const bundleDirs: string[] = [];
afterAll(() => {
  for (const dir of bundleDirs) rmSync(dir, { recursive: true, force: true });
});

function capture() {
  const printed: unknown[] = [];
  const codes: number[] = [];
  return {
    printed,
    codes,
    output: {
      error: (message: unknown) => printed.push(message),
      exit: (code: number) => codes.push(code),
    },
  };
}

describe("reportBootError", () => {
  it("prints only the message of a configuration error and exits 1", () => {
    const { printed, codes, output } = capture();
    reportBootError(new EnvConfigError("[env] fix BETTER_AUTH_URL"), output);
    expect(printed).toEqual(["[server] FATAL: [env] fix BETTER_AUTH_URL"]);
    expect(codes).toEqual([1]);
  });

  it("prints the password pepper remediation and exits 1", () => {
    const { printed, codes, output } = capture();
    const error = new PasswordPepperKeyError(1, ["0123456789abcdef"], ["fedcba9876543210"]);
    reportBootError(error, output);
    expect(printed).toEqual([`[server] FATAL: ${error.message}`]);
    expect(codes).toEqual([1]);
  });

  it("preserves the password pepper message with the console shim installed", async () => {
    const originals = { error: console.error, warn: console.warn, log: console.log };
    const printed = vi.fn();
    console.error = printed;
    try {
      vi.resetModules();
      const { installBetterCallErrorLogShim } = await import("./better-call-error-log-shim.js");
      installBetterCallErrorLogShim();
      const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      const error = new PasswordPepperKeyError(1, ["0123456789abcdef"], ["fedcba9876543210"]);
      reportBootError(error);
      expect(printed).toHaveBeenCalledWith(`[server] FATAL: ${error.message}`);
      expect(printed.mock.calls[0]?.[0]).toContain("sealed under key");
      expect(printed.mock.calls[0]?.[0]).not.toContain("error (sanitized):");
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.restoreAllMocks();
      Object.assign(console, originals);
    }
  });

  it("prints any other error whole, stack included, and exits 1", () => {
    const { printed, codes, output } = capture();
    const error = new TypeError("boom");
    reportBootError(error, output);
    expect(printed).toEqual([error]);
    expect(codes).toEqual([1]);
  });
});

describe("server process entry", () => {
  it("is start.ts, built as dist/index.mjs, and imports the boot module only dynamically", () => {
    const tsdown = readFileSync(join(SERVER_DIR, "tsdown.config.ts"), "utf8");
    expect(tsdown).toMatch(/entry:\s*\{\s*index:\s*"\.\/src\/start\.ts"\s*\}/);
    const start = readFileSync(join(SERVER_DIR, "src", "start.ts"), "utf8");
    const imports = start.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual([
      'import "@ws-model-proxy/env/load-dotenv";',
      'import { reportBootError } from "./boot-error.js";',
    ]);
    expect(start).toContain('await import("./index.js")');
  });

  it("under tsx (pnpm dev), exits 1 with the one-line fix and no stack trace", () => {
    const result = spawnSync(join(BIN, "tsx"), ["src/start.ts"], {
      cwd: SERVER_DIR,
      encoding: "utf8",
      timeout: 120_000,
      env: LAN_HTTP_ENV,
    });
    expect(result.stderr.trim()).toBe(EXPECTED_STDERR);
    expect(result.status).toBe(1);
  }, 150_000);

  it("as the production bundle (node dist/index.mjs), exits 1 with the one-line fix and no stack trace", () => {
    mkdirSync(CACHE, { recursive: true });
    const outDir = mkdtempSync(join(CACHE, "boot-error-bundle-"));
    bundleDirs.push(outDir);
    const build = spawnSync(join(BIN, "tsdown"), ["--out-dir", outDir, "--no-clean"], {
      cwd: SERVER_DIR,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);

    const result = spawnSync(process.execPath, [join(outDir, "index.mjs")], {
      cwd: SERVER_DIR,
      encoding: "utf8",
      timeout: 60_000,
      env: LAN_HTTP_ENV,
    });
    expect(result.stderr.trim()).toBe(EXPECTED_STDERR);
    expect(result.status).toBe(1);
  }, 200_000);
});
