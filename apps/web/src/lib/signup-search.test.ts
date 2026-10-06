import { defaultParseSearch } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { parseSignupSearch, urlWithoutInvite } from "./signup-search";

const TOKEN = "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const fromUrl = (search: string) =>
  parseSignupSearch(defaultParseSearch(search) as Record<string, unknown>);

describe("parseSignupSearch", () => {
  it("keeps a well-formed invite token from the link", () => {
    expect(fromUrl(`?invite=${TOKEN}`)).toEqual({ invite: TOKEN, redirectTo: undefined });
  });

  it("keeps redirectTo alongside the invite", () => {
    expect(fromUrl(`?invite=${TOKEN}&redirectTo=%2Fen-US%2Fpools`)).toEqual({
      invite: TOKEN,
      redirectTo: "/en-US/pools",
    });
  });

  it("drops a malformed invite", () => {
    for (const bad of [
      "?invite=",
      "?invite=wsmp_inv_short",
      `?invite=${TOKEN.toLowerCase()}`,
      `?invite=${TOKEN}A`,
      `?invite=x${TOKEN}`,
      "?invite=wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXY1",
      "?invite=123",
    ]) {
      expect(fromUrl(bad).invite).toBeUndefined();
    }
  });

  it("is empty for a bare visit", () => {
    expect(fromUrl("")).toEqual({ invite: undefined, redirectTo: undefined });
  });
});

describe("urlWithoutInvite", () => {
  it("drops the invite and keeps the rest", () => {
    expect(urlWithoutInvite(`https://x.test/en-US/signup?invite=${TOKEN}`)).toBe("/en-US/signup");
    expect(
      urlWithoutInvite(`https://x.test/en-US/signup?redirectTo=%2Fen-US%2Fpools&invite=${TOKEN}#f`),
    ).toBe("/en-US/signup?redirectTo=%2Fen-US%2Fpools#f");
  });

  it("leaves a URL without an invite alone", () => {
    expect(urlWithoutInvite("https://x.test/en-US/signup?redirectTo=x")).toBeNull();
  });
});
