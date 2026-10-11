import { defaultParseSearch } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { parseResetPasswordSearch, urlWithoutResetToken } from "./reset-password-search";

const fromUrl = (search: string) =>
  parseResetPasswordSearch(defaultParseSearch(search) as Record<string, unknown>);

describe("parseResetPasswordSearch", () => {
  it("reads the token Better Auth appends on a valid link", () => {
    expect(fromUrl("?token=AbC123xyz0AbC123xyz0AbCd")).toEqual({
      token: "AbC123xyz0AbC123xyz0AbCd",
      error: undefined,
    });
  });

  it("reads the error Better Auth appends on a bad link", () => {
    expect(fromUrl("?error=INVALID_TOKEN")).toEqual({ token: undefined, error: "INVALID_TOKEN" });
  });

  it("treats a bare visit as no token", () => {
    expect(fromUrl("")).toEqual({ token: undefined, error: undefined });
  });

  it("ignores values that are not a token string", () => {
    expect(fromUrl("?token=123456").token).toBeUndefined();
    expect(fromUrl("?token=true").token).toBeUndefined();
    expect(fromUrl("?token=a%20b").token).toBeUndefined();
    expect(fromUrl("?token=").token).toBeUndefined();
  });
});

describe("urlWithoutResetToken", () => {
  it("drops the token and keeps the rest", () => {
    expect(
      urlWithoutResetToken("https://app.example.com/en-US/reset-password?token=abc&x=1#h"),
    ).toBe("/en-US/reset-password?x=1#h");
  });

  it("returns null when there is no token", () => {
    expect(
      urlWithoutResetToken("https://app.example.com/en-US/reset-password?error=INVALID_TOKEN"),
    ).toBeNull();
  });
});
