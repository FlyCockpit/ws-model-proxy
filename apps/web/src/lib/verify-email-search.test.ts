import { defaultParseSearch } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { parseVerifyEmailSearch } from "./verify-email-search";

const parseUrl = (search: string) => defaultParseSearch(search) as Record<string, unknown>;
const fromUrl = (search: string) => parseVerifyEmailSearch(parseUrl(search));

describe("parseVerifyEmailSearch", () => {
  it("recognizes the ?ok=1 marker buildCallback actually emits", () => {
    expect(parseUrl("?ok=1").ok).toBe(1);
    expect(fromUrl("?ok=1")).toEqual({ ok: true, error: undefined });
  });

  it("accepts the other spellings of the marker", () => {
    expect(fromUrl("?ok=true").ok).toBe(true);
    expect(fromUrl('?ok="1"').ok).toBe(true);
  });

  it("treats a bare visit as unknown, not success", () => {
    expect(fromUrl("")).toEqual({ ok: undefined, error: undefined });
    expect(fromUrl("?lang=en-US")).toEqual({ ok: undefined, error: undefined });
  });

  it("surfaces an error code as a string", () => {
    expect(fromUrl("?error=TOKEN_EXPIRED")).toEqual({ ok: undefined, error: "TOKEN_EXPIRED" });
  });

  it("keeps the error when Better-Auth appends it to the success callback", () => {
    expect(fromUrl("?ok=1&error=TOKEN_EXPIRED")).toEqual({ ok: true, error: "TOKEN_EXPIRED" });
  });

  it("ignores values that are not a recognized marker", () => {
    expect(fromUrl("?ok=0").ok).toBeUndefined();
    expect(fromUrl("?ok=false").ok).toBeUndefined();
    expect(fromUrl("?ok=maybe").ok).toBeUndefined();
    expect(fromUrl("?error=1").error).toBeUndefined();
  });
});
