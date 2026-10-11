import { describe, expect, it } from "vitest";

import { inviteSignupPath, safeRedirectTo } from "./safe-redirect";

const TOKEN = "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ";

describe("safeRedirectTo", () => {
  it("keeps same-locale app paths and falls back otherwise", () => {
    expect(safeRedirectTo("/en-US/pools", "en-US")).toBe("/en-US/pools");
    expect(safeRedirectTo("https://evil.example", "en-US")).toBe("/en-US/overview");
    expect(safeRedirectTo("/es-MX/pools", "en-US")).toBe("/en-US/overview");
    expect(safeRedirectTo(undefined, "en-US")).toBe("/en-US/overview");
  });

  it("never returns to the login or plain sign-up page", () => {
    expect(safeRedirectTo("/en-US/login", "en-US")).toBe("/en-US/overview");
    expect(safeRedirectTo("/en-US/signup", "en-US")).toBe("/en-US/overview");
  });

  it("returns to an invite link's sign-up page, exactly", () => {
    expect(safeRedirectTo(inviteSignupPath("en-US", TOKEN), "en-US")).toBe(
      `/en-US/signup?invite=${TOKEN}`,
    );
    for (const near of [
      `/en-US/signup?invite=${TOKEN}&redirectTo=https://evil.example`,
      `/en-US/signup?invite=${TOKEN}&x=1`,
      `/en-US/signup?invite=${TOKEN}#x`,
      `/en-US/signup?invite=${TOKEN}x`,
      "/en-US/signup?invite=wsmp_inv_short",
      `/en-US/signup?other=1&invite=${TOKEN}`,
      `/es-MX/signup?invite=${TOKEN}`,
    ]) {
      expect(safeRedirectTo(near, "en-US")).toBe("/en-US/overview");
    }
  });
});
