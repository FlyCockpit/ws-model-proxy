import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { testContainerPrefix } from "./test-container-prefix.mjs";

const shellLib = fileURLToPath(new URL("./test-container-prefix.sh", import.meta.url));
const testPg = fileURLToPath(new URL("../test-pg.sh", import.meta.url));

/**
 * The shell twin, sourced into a clean bash (only PATH and the given env).
 * @param {string} fallback
 * @param {string[]} argv
 * @param {Record<string, string>} env
 */
function shellPrefix(fallback, argv, env) {
  const result = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; shift; test_container_prefix "$@"',
      "prefix-test",
      shellLib,
      fallback,
      ...argv,
    ],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

test("the flag wins, then TEST_CONTAINER_PREFIX, then the default (node and shell agree)", () => {
  /** @type {[string[], Record<string, string>, string | undefined, string][]} */
  const cases = [
    [[], {}, undefined, "wmp"],
    [[], {}, "wmp-test-migrations", "wmp-test-migrations"],
    [[], { TEST_CONTAINER_PREFIX: "ci-ws-model-proxy" }, "wsmp", "ci-ws-model-proxy"],
    [
      ["--other", "x", "--container-prefix", "ci-flag"],
      { TEST_CONTAINER_PREFIX: "ci-env" },
      "wsmp",
      "ci-flag",
    ],
    [["--container-prefix", "a.b_c__d--e"], {}, "wsmp", "a.b_c__d--e"],
  ];
  for (const [argv, env, fallback, expected] of cases) {
    const label = JSON.stringify({ argv, env, fallback });
    assert.equal(testContainerPrefix({ argv, env, fallback }), expected, label);
    const shell = shellPrefix(fallback ?? "wmp", argv, env);
    assert.equal(shell.status, 0, `${label}: ${shell.stderr}`);
    assert.equal(shell.stdout, expected, label);
  }
});

test("an empty or invalid prefix is an error, never the default (node and shell agree)", () => {
  for (const bad of ["", "Bad", "a-", "-a", "a..b", "a._b", "a b", "a/b", "x".repeat(25)]) {
    assert.throws(
      () => testContainerPrefix({ env: { TEST_CONTAINER_PREFIX: bad } }),
      /TEST_CONTAINER_PREFIX needs a Docker name prefix/,
      bad,
    );
    const shell = shellPrefix("wsmp", [], { TEST_CONTAINER_PREFIX: bad });
    assert.equal(shell.status, 2, JSON.stringify(bad));
    assert.equal(shell.stdout, "", JSON.stringify(bad));
    assert.match(shell.stderr, /TEST_CONTAINER_PREFIX needs a Docker name prefix/, bad);
    // An invalid flag value is refused even when the variable is valid.
    assert.throws(
      () =>
        testContainerPrefix({
          argv: ["--container-prefix", bad],
          env: { TEST_CONTAINER_PREFIX: "fine" },
        }),
      /--container-prefix needs a Docker name prefix/,
      bad,
    );
    const flag = shellPrefix("wsmp", ["--container-prefix", bad], {
      TEST_CONTAINER_PREFIX: "fine",
    });
    assert.equal(flag.status, 2, JSON.stringify(bad));
    assert.match(flag.stderr, /--container-prefix needs a Docker name prefix/, bad);
  }
  // A flag without a value.
  assert.throws(
    () => testContainerPrefix({ argv: ["--container-prefix"], env: {} }),
    /--container-prefix needs a Docker name prefix/,
  );
  const missing = shellPrefix("wsmp", ["--container-prefix"], {});
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--container-prefix needs a Docker name prefix/);
  // The longest accepted prefix is 24 characters.
  assert.equal(
    testContainerPrefix({ env: { TEST_CONTAINER_PREFIX: "x".repeat(24) } }),
    "x".repeat(24),
  );
  assert.equal(
    shellPrefix("wsmp", [], { TEST_CONTAINER_PREFIX: "x".repeat(24) }).stdout,
    "x".repeat(24),
  );
});

/**
 * test-pg.sh against a fake container runtime whose `run` fails after
 * recording its arguments, so no real container and no suite ever runs.
 * @param {string[]} argv
 * @param {Record<string, string>} env
 */
function testPgNames(argv, env) {
  const dir = mkdtempSync(join(tmpdir(), "test-pg-prefix-"));
  try {
    const log = join(dir, "calls.log");
    const runtime = join(dir, "fake-runtime");
    writeFileSync(
      runtime,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n[ "$1" = run ] && exit 1\nexit 0\n`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [testPg, ...argv], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: dir,
        CONTAINER_RUNTIME: runtime,
        ...env,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    let calls = [];
    try {
      calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      // No runtime call at all.
    }
    const run = calls.find((call) => call.startsWith("run "));
    const name = run ? /--name (\S+)/.exec(run)?.[1] : undefined;
    return { status: result.status, stderr: result.stderr, calls, name };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("test:pg names its container <prefix>-test-pg-<run> and refuses an invalid prefix before the runtime", () => {
  for (const [argv, env, prefix] of [
    [[], {}, "wsmp"],
    [[], { TEST_CONTAINER_PREFIX: "ci-ws-model-proxy" }, "ci-ws-model-proxy"],
    [["--container-prefix", "ci-flag"], { TEST_CONTAINER_PREFIX: "ci-env" }, "ci-flag"],
  ]) {
    const result = testPgNames(argv, env);
    const label = JSON.stringify({ argv, env });
    assert.equal(result.status, 1, `${label}: ${result.stderr}`);
    assert.match(
      result.name ?? "",
      new RegExp(`^${prefix.replace(/[.]/g, "\\.")}-test-pg-t\\d+r\\d+x\\d+$`),
      label,
    );
  }
  for (const [argv, env] of [
    [[], { TEST_CONTAINER_PREFIX: "" }],
    [[], { TEST_CONTAINER_PREFIX: "Bad" }],
    [["--container-prefix", "a-"], { TEST_CONTAINER_PREFIX: "fine" }],
  ]) {
    const result = testPgNames(argv, env);
    const label = JSON.stringify({ argv, env });
    assert.equal(result.status, 2, `${label}: ${result.stderr}`);
    assert.match(result.stderr, /needs a Docker name prefix/, label);
    assert.deepEqual(result.calls, [], label);
  }
});
