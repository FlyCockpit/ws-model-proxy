import { isAPIError } from "better-auth/api";
import { describe, expect, it } from "vitest";
import { requireCliDeviceLoginScope } from "./cli-device-login-scope";

describe("requireCliDeviceLoginScope", () => {
  it("accepts one valid CLI slug", () => {
    expect(() => requireCliDeviceLoginScope("ws-model-proxy", "cli-slug:desk-01")).not.toThrow();
  });

  it.each([undefined, "", "openid", "cli-slug:Not A Slug", "cli-slug:desk-01 openid"])(
    "rejects %j with invalid_scope",
    (scope) => {
      let caught: unknown;
      try {
        requireCliDeviceLoginScope("ws-model-proxy", scope);
      } catch (error) {
        caught = error;
      }
      expect(isAPIError(caught)).toBe(true);
      expect(caught).toMatchObject({ body: { error: "invalid_scope" } });
    },
  );
});
