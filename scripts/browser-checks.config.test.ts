import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CheckRun } from "./browser-check-lib.ts";
import { assertDisposableTarget, seededAccounts, signIn } from "./browser-checks.config.ts";

test("refuses any target not declared disposable", () => {
  assert.throws(
    () => assertDisposableTarget("http://localhost:3000", {}),
    /WMP_CHECK_DISPOSABLE=1/,
  );
});

test("allows the throwaway accounts on this machine only", () => {
  const env = { WMP_CHECK_DISPOSABLE: "1" };
  assert.doesNotThrow(() => assertDisposableTarget("http://localhost:3000", env));
  assert.doesNotThrow(() => assertDisposableTarget("http://127.0.0.1:3000", env));
  assert.throws(
    () => assertDisposableTarget("https://test.example.com", env),
    /WMP_CHECK_ADMIN_EMAIL/,
  );
});

test("a remote throwaway stack needs its own accounts", () => {
  const env = {
    WMP_CHECK_DISPOSABLE: "1",
    WMP_CHECK_ADMIN_EMAIL: "a@example.invalid",
    WMP_CHECK_ADMIN_PASSWORD: "x",
    WMP_CHECK_USER_EMAIL: "u@example.invalid",
    WMP_CHECK_USER_PASSWORD: "y",
  };
  assert.doesNotThrow(() => assertDisposableTarget("https://test.example.com", env));
});

const credentials = {
  version: 1,
  accounts: {
    user: { email: "user@example.invalid", password: "user-test-password" },
    admin: {
      email: "admin@example.invalid",
      password: "admin-test-password",
      totp: { secret: "12345678901234567890" },
    },
  },
};

function withFile(body: (path: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "wmp-check-accounts-"));
  const path = join(dir, "accounts.json");
  writeFileSync(path, JSON.stringify(credentials), { mode: 0o600 });
  return Promise.resolve()
    .then(() => body(path))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

const argsFor = (path: string) => ["--url", "http://localhost:3000", "--accounts", path];

test("credentials accept accounts with an optional TOTP secret", () =>
  withFile((path) => {
    assert.deepEqual(seededAccounts(argsFor(path)), credentials.accounts);
    writeFileSync(
      path,
      JSON.stringify({
        ...credentials,
        accounts: { ...credentials.accounts, admin: credentials.accounts.user },
      }),
    );
    assert.equal(seededAccounts(argsFor(path)).admin.totp, undefined);
  }));

test("credentials errors give a precondition without source excerpts", () =>
  withFile((path) => {
    for (const args of [[], ["--accounts"], ["--accounts", "--url"]])
      assert.throws(() => seededAccounts(args), /needs a credentials file path/);
    assert.throws(() => seededAccounts(["--accounts", path]), /requires --url/);
    assert.throws(() => seededAccounts(argsFor(`${path}.missing`)), /cannot read credentials file/);
    const secret = "do-not-echo-this-password";
    writeFileSync(path, `{"password":${secret}}`);
    assert.throws(
      () => seededAccounts(argsFor(path)),
      (error: Error) =>
        error.message.includes("is not valid JSON") &&
        !error.message.includes(secret) &&
        !error.message.includes("password") &&
        !error.message.includes("SyntaxError"),
    );
    writeFileSync(path, JSON.stringify({ version: secret }));
    assert.throws(
      () => seededAccounts(argsFor(path)),
      (error: Error) =>
        error.message.includes("needs version 1") && !error.message.includes(secret),
    );
    writeFileSync(
      path,
      JSON.stringify({ ...credentials, accounts: { ...credentials.accounts, user: {} } }),
    );
    assert.throws(() => seededAccounts(argsFor(path)), /accounts.user.email and password/);
    writeFileSync(
      path,
      JSON.stringify({
        ...credentials,
        accounts: { ...credentials.accounts, admin: { ...credentials.accounts.admin, totp: {} } },
      }),
    );
    assert.throws(() => seededAccounts(argsFor(path)), /accounts.admin.totp.secret/);
  }));

test("accounts files retain the disposable guard and avoid default passwords on remote stacks", () => {
  assert.throws(
    () => assertDisposableTarget("https://test.example.invalid", {}, true),
    /WMP_CHECK_DISPOSABLE/,
  );
  assert.doesNotThrow(() =>
    assertDisposableTarget("https://test.example.invalid", { WMP_CHECK_DISPOSABLE: "1" }, true),
  );
  assert.throws(
    () =>
      assertDisposableTarget("http://localhost:3000", {
        WMP_CHECK_DISPOSABLE: "1",
        WMP_CHECK_USER_EMAIL: "x",
      }),
    /must be supplied together/,
  );
});

test("real sign-in reuses a role, switches cookies, computes TOTP, and bootstraps fixtures once", async (t) =>
  withFile(async (path) => {
    const previous = process.env.WMP_CHECK_DISPOSABLE;
    process.env.WMP_CHECK_DISPOSABLE = "1";
    t.after(() => {
      if (previous === undefined) delete process.env.WMP_CHECK_DISPOSABLE;
      else process.env.WMP_CHECK_DISPOSABLE = previous;
    });
    const commands: { args: string[]; input?: string }[] = [];
    let fixtures = 0;
    let verified = false;
    const browser: CheckRun["browser"] = {
      async run(args, input) {
        commands.push({ args, input });
        const script = input ?? args[1] ?? "";
        if (script.includes("__reactProps")) return '"ready"';
        if (script.includes("button.click()")) {
          verified = true;
          return '"clicked"';
        }
        if (script.startsWith("location.pathname ===")) return verified ? '"app"' : '"code"';
        return "true";
      },
      async evalJson<T>(script: string): Promise<T> {
        fixtures++;
        return (
          script.includes("presets/list")
            ? { presets: [{ id: "vllm", kind: "LLM", spec: {} }] }
            : { id: "fixture" }
        ) as T;
      },
      close() {},
    };
    const run = { base: "http://localhost:3000", browser, args: argsFor(path) };
    await signIn(run, "admin");
    const after = commands.length;
    assert.equal(fixtures, 4);
    await signIn(run, "admin");
    assert.equal(commands.length, after);
    await signIn(run, "user");
    await signIn(run, "anonymous");
    assert.equal(fixtures, 4);
    assert.equal(commands.filter(({ args }) => args[0] === "cookies").length, 3);
    assert.equal(
      commands.filter(
        ({ input }) => input?.includes("fill") && input.includes("12345678901234567890"),
      ).length,
      0,
    );
    for (const { args } of commands) {
      assert.equal(args.join(" ").includes(credentials.accounts.admin.password), false);
      assert.equal(args.join(" ").includes(credentials.accounts.admin.totp.secret), false);
    }
    assert.equal(
      commands.some(({ input }) => input?.includes('"#totp-code"')),
      true,
    );
  }));
