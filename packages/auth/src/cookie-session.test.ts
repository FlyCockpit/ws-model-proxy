import { describe, expect, it } from "vitest";

import { cookieSessionHeaders } from "./cookie-session";

describe("cookieSessionHeaders", () => {
  it("removes bearer authorization while preserving cookie session headers", () => {
    const source = new Headers({
      Authorization: "Bearer wsmp_model_secret",
      Cookie: "better-auth.session_token=signed-session",
      "User-Agent": "vitest",
    });

    const result = cookieSessionHeaders(source);

    expect(result.get("authorization")).toBeNull();
    expect(result.get("cookie")).toBe("better-auth.session_token=signed-session");
    expect(result.get("user-agent")).toBe("vitest");
    expect(source.get("authorization")).toBe("Bearer wsmp_model_secret");
  });
});
