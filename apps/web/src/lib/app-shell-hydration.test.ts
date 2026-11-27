import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_SHELL_ATTRIBUTE,
  APP_SHELL_HYDRATION_TIMEOUT_MS,
  appShellHydrated,
  markAppShellHydrated,
  resetAppShellHydrationForTests,
} from "./app-shell-hydration";

const mountEffects = vi.hoisted(() => [] as unknown[]);
vi.mock("@/hooks/use-mount-effect", () => ({
  useMountEffect: (fn: unknown) => {
    mountEffects.push(fn);
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/en-US/nodes" } }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/app-name-link", () => ({ AppNameLink: () => null }));
vi.mock("@/components/page-skeleton", () => ({ PageSkeleton: () => null }));

/** A document whose server HTML does (or does not) hold the app shell. */
function stubDocument(hasAppShell: boolean) {
  const querySelector = vi.fn((selector: string) =>
    hasAppShell && selector === `[${APP_SHELL_ATTRIBUTE}]` ? {} : null,
  );
  vi.stubGlobal("document", { querySelector });
  return querySelector;
}

/** Whether the promise has settled after the queued microtasks ran. */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

beforeEach(() => {
  resetAppShellHydrationForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("appShellHydrated", () => {
  it("holds a guard while the server-rendered shell has not hydrated", async () => {
    stubDocument(true);
    const wait = appShellHydrated();
    expect(await settled(wait)).toBe(false);

    markAppShellHydrated();
    expect(await settled(wait)).toBe(true);
  });

  it("resolves at once after the shell hydrated (every later navigation)", async () => {
    stubDocument(true);
    markAppShellHydrated();
    expect(await settled(appShellHydrated())).toBe(true);
  });

  it("resolves at once when the document holds no app shell (from a public page)", async () => {
    stubDocument(false);
    expect(await settled(appShellHydrated())).toBe(true);
  });

  it("resolves at once on the server", async () => {
    expect(typeof document).toBe("undefined");
    expect(await settled(appShellHydrated())).toBe(true);
  });

  it("never holds a guard forever if the shell stops reporting", async () => {
    stubDocument(true);
    const wait = appShellHydrated();
    vi.advanceTimersByTime(APP_SHELL_HYDRATION_TIMEOUT_MS - 1);
    expect(await settled(wait)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await settled(wait)).toBe(true);
  });

  it("clears a waiter's timer once the shell reports", async () => {
    stubDocument(true);
    const wait = appShellHydrated();
    expect(vi.getTimerCount()).toBe(1);
    markAppShellHydrated();
    expect(await settled(wait)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("resolveRouteSession", () => {
  it("runs the probe at once but decides only after the shell hydrated", async () => {
    vi.resetModules();
    const probe = vi.fn(async () => ({ status: "resolved" as const, session: null }));
    const admit = vi.fn(async () => undefined);
    vi.doMock("@/server/auth-session", () => ({ getRouteSession: probe }));
    vi.doMock("@/lib/document-identity", () => ({
      admitRouteIdentity: admit,
      identityVerificationGeneration: () => 0,
    }));
    const hydration = await import("./app-shell-hydration");
    const { resolveRouteSession } = await import("./route-session");
    stubDocument(true);

    const resolution = resolveRouteSession();
    expect(probe).toHaveBeenCalledOnce();
    expect(await settled(resolution.then(() => undefined))).toBe(false);
    expect(admit).not.toHaveBeenCalled();

    hydration.markAppShellHydrated();
    await expect(resolution).resolves.toEqual({ status: "resolved", session: null });
    expect(admit).toHaveBeenCalledOnce();
    vi.doUnmock("@/server/auth-session");
    vi.doUnmock("@/lib/document-identity");
  });

  it("delivers a failed probe only after the shell hydrated", async () => {
    vi.resetModules();
    const failure = new Error("network down");
    const probe = vi.fn(async () => {
      throw failure;
    });
    const admit = vi.fn(async () => undefined);
    vi.doMock("@/server/auth-session", () => ({ getRouteSession: probe }));
    vi.doMock("@/lib/document-identity", () => ({
      admitRouteIdentity: admit,
      identityVerificationGeneration: () => 0,
    }));
    const hydration = await import("./app-shell-hydration");
    const { resolveRouteSession } = await import("./route-session");
    stubDocument(true);

    let rejected: unknown;
    const resolution = resolveRouteSession().then(
      () => undefined,
      (error: unknown) => {
        rejected = error;
      },
    );
    expect(probe).toHaveBeenCalledOnce();
    expect(await settled(resolution)).toBe(false);
    expect(rejected).toBeUndefined();

    hydration.markAppShellHydrated();
    await resolution;
    expect(rejected).toBe(failure);
    expect(admit).not.toHaveBeenCalled();
    vi.doUnmock("@/server/auth-session");
    vi.doUnmock("@/lib/document-identity");
  });
});

describe("the shell skeleton (the server's HTML)", () => {
  it("marks itself in the server HTML and reports hydration from its first effect", async () => {
    const { ShellSkeleton } = await import("@/components/shell-skeleton");
    const hydration = await import("./app-shell-hydration");
    mountEffects.length = 0;
    const html = renderToStaticMarkup(createElement(ShellSkeleton));
    expect(html.match(new RegExp(`${hydration.APP_SHELL_ATTRIBUTE}=""`, "g"))).toHaveLength(1);
    expect(mountEffects).toContain(hydration.markAppShellHydrated);
  });
});
