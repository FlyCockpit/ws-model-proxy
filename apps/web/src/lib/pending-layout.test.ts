import { describe, expect, it } from "vitest";

import { resolvePendingLayout } from "./pending-layout";

const ROOT = { routeId: "__root__" };
const LANG = { routeId: "/$lang" };
const APP = { routeId: "/$lang/_app" };
const ADMIN = { routeId: "/$lang/_app/admin", staticData: { pendingFrame: "admin" as const } };
const USERS = {
  routeId: "/$lang/_app/admin/users",
  staticData: { pendingShape: "list" as const, pendingWidth: "wide" as const },
};
const SETTINGS = {
  routeId: "/$lang/_app/_auth/settings",
  staticData: { pendingFrame: "settings" as const },
};
const SECURITY = {
  routeId: "/$lang/_app/_auth/settings/security",
  staticData: { pendingShape: "form" as const },
};

describe("resolvePendingLayout", () => {
  it("draws every frame below the pending boundary and the leaf's shape", () => {
    expect(resolvePendingLayout([ROOT, LANG, APP, ADMIN, USERS], APP.routeId)).toEqual({
      shape: "list",
      width: "wide",
      frames: ["admin"],
    });
  });

  it("leaves out frames that are already on screen above the boundary", () => {
    expect(resolvePendingLayout([ROOT, LANG, APP, ADMIN, USERS], USERS.routeId)).toEqual({
      shape: "list",
      width: "wide",
      frames: [],
    });
  });

  it("puts a settings form inside the settings frame", () => {
    expect(resolvePendingLayout([ROOT, LANG, APP, SETTINGS, SECURITY], APP.routeId)).toEqual({
      shape: "form",
      width: "default",
      frames: ["settings"],
    });
  });

  it("falls back to a default-width list for routes that declare nothing", () => {
    expect(resolvePendingLayout([ROOT, LANG, APP], APP.routeId)).toEqual({
      shape: "list",
      width: "default",
      frames: [],
    });
  });

  it("reads from the top when the boundary is unknown", () => {
    expect(resolvePendingLayout([ROOT, ADMIN, USERS], undefined).frames).toEqual(["admin"]);
    expect(resolvePendingLayout([ROOT, ADMIN, USERS], "/nowhere").frames).toEqual(["admin"]);
  });
});
