import { describe, expect, it } from "vitest";

import { shellPartsOf } from "./shell-skeleton";

describe("shellPartsOf", () => {
  it("frames signed-in pages with the sidebar and the bottom nav", () => {
    expect(shellPartsOf("/en-US/nodes")).toEqual({ sidebar: true, bottomNav: true });
    expect(shellPartsOf("/es-MX/runtimes/abc/definition")).toEqual({
      sidebar: true,
      bottomNav: true,
    });
  });

  it("gives admin pages the bottom nav but not the sidebar (they have their own tabs)", () => {
    expect(shellPartsOf("/en-US/admin/users")).toEqual({ sidebar: false, bottomNav: true });
  });

  it("leaves public pages and unknown locales unframed", () => {
    for (const path of [
      "/en-US/login",
      "/en-US/signup",
      "/en-US",
      "/en-US/mcp-consent",
      "/",
      "/xx/nodes",
      "/en-US/missing",
      "/es-MX/new-public-page/child",
      "/en-US/nodes-missing",
    ])
      expect(shellPartsOf(path)).toEqual({ sidebar: false, bottomNav: false });
  });
});
