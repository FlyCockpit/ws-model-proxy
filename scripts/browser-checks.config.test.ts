import assert from "node:assert/strict";
import { test } from "node:test";

import { assertDisposableTarget } from "./browser-checks.config.ts";

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
