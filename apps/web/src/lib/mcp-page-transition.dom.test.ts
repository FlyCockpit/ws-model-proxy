// @vitest-environment jsdom

import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMcpPageContinue } from "@/hooks/use-mcp-page-continue";
import { mcpPageHref } from "./mcp-oauth-search";

/**
 * Signed-query preservation probes (MCP plan Phase 6, Part H pass 2 —
 * R83/R84 F1): transitions between the MCP login and consent pages must keep
 * the RAW query string byte-identical, because the signed OAuth transaction
 * (repeated `ba_param` keys + `sig`) IS the URL. The probes run the INSTALLED
 * @better-auth/oauth-provider@1.7.3 `setSignedOAuthQueryParameterNames` /
 * `buildSignedOAuthQuery` (the exact producer/consumer pair the browser flow
 * uses) against both the CHOSEN mechanism (raw search → history-layer
 * navigation) and the REJECTED mechanism (TanStack parse→stringify round
 * trip), proving the defect class the reviewers reproduced.
 */

type SignedQueryModule = {
  a: (params: URLSearchParams) => void; // setSignedOAuthQueryParameterNames
  t: (search: string) => string | undefined; // buildSignedOAuthQuery
};

async function loadInstalledSignedQueryModule(): Promise<SignedQueryModule> {
  const require = createRequire(import.meta.url);
  // The dist chunk name carries a content hash; resolve the package's
  // ./client export (stable in the exports map) and locate the chunk next to
  // it — the same two functions the installed client plugin imports.
  const clientPath = require.resolve("@better-auth/oauth-provider/client");
  const distDir = dirname(clientPath);
  const chunk = readdirSync(distDir).find((name) =>
    /^signed-query-[A-Za-z0-9_-]+\.mjs$/.test(name),
  );
  if (!chunk) throw new Error("installed signed-query chunk not found");
  const module = await import(pathToFileURL(join(distDir, chunk)).href);
  return module as SignedQueryModule;
}

/** A REAL Better Auth signed query: repeated ba_param keys + sig + ba_iat. */
async function buildRealSignedQuery(): Promise<string> {
  const signed = await loadInstalledSignedQueryModule();
  const params = new URLSearchParams();
  params.set("client_id", "mcp-client-1");
  params.set("scope", "mcp:read mcp:write offline_access");
  params.set("state", "st-8f3a");
  params.set("code_challenge", "cc-S0meL0ngCh4llenge");
  params.set("ba_iat", "1758100000000");
  params.set("sig", "sig-SECRET-value");
  signed.a(params);
  return params.toString();
}

describe("raw-query MCP page transitions (R83/R84 F1)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    // Reset the jsdom URL so later tests start clean.
    window.history.pushState({}, "", "/");
  });

  it("mcpPageHref embeds the raw search byte-identically (both directions)", async () => {
    const signed = await buildRealSignedQuery();
    expect(mcpPageHref("en-US", "mcp-login", `?${signed}`)).toBe(`/en-US/mcp-login?${signed}`);
    expect(mcpPageHref("es-MX", "mcp-consent", `?${signed}`)).toBe(`/es-MX/mcp-consent?${signed}`);
    // Tolerates a search string without the leading "?" and the empty search.
    expect(mcpPageHref("en-US", "mcp-login", signed)).toBe(`/en-US/mcp-login?${signed}`);
    expect(mcpPageHref("en-US", "mcp-consent", "")).toBe("/en-US/mcp-consent");
  });

  it("PROBE: the chosen mechanism (raw search → history-layer URL) preserves the signed transaction", async () => {
    const signed = await buildRealSignedQuery();
    const signedQuery = await loadInstalledSignedQueryModule();

    // The transition: land on mcp-login carrying the raw signed query (the
    // browser/history layer keeps URL strings verbatim — pushState is the
    // same primitive window.location.assign ends in).
    window.history.pushState({}, "", `/en-US/mcp-login?${signed}`);
    const rawSearch = window.location.search;
    expect(rawSearch).toBe(`?${signed}`);

    // ... and continue to the consent page through the production helper.
    window.history.pushState({}, "", mcpPageHref("en-US", "mcp-consent", rawSearch));
    expect(window.location.search).toBe(`?${signed}`);

    // The INSTALLED buildSignedOAuthQuery (what oauthProviderClient()'s fetch
    // plugin runs over window.location.search) still sees the original
    // client_id/scope/sig — repeated ba_param keys intact.
    const oauthQuery = signedQuery.t(window.location.search);
    expect(oauthQuery).toBeDefined();
    const params = new URLSearchParams(oauthQuery ?? "");
    expect(params.get("client_id")).toBe("mcp-client-1");
    expect(params.get("scope")).toBe("mcp:read mcp:write offline_access");
    expect(params.get("sig")).toBe("sig-SECRET-value");
    expect(params.getAll("ba_param")).toContain("client_id");
    expect(params.getAll("ba_param")).toContain("scope");
  });

  it("NEGATIVE CONTROL: a TanStack parse→stringify round trip corrupts the signed transaction (the rejected mechanism)", async () => {
    const signed = await buildRealSignedQuery();
    const signedQuery = await loadInstalledSignedQueryModule();

    // Installed router-core defaults (router.js parseLocation/buildLocation
    // run exactly this pair for `search: true`, href navigations, and even
    // location.searchStr).
    const roundTripped = defaultStringifySearch(defaultParseSearch(`?${signed}`));
    expect(roundTripped).not.toBe(`?${signed}`);

    // The corrupted query kills the signature: the collapsed JSON-array
    // ba_param is not a parameter name the provider recognizes, so
    // client_id/scope fall out of the signed set.
    const oauthQuery = signedQuery.t(roundTripped);
    const params = new URLSearchParams(oauthQuery ?? "");
    expect(params.get("client_id")).not.toBe("mcp-client-1");
    expect(params.get("scope")).not.toBe("mcp:read mcp:write offline_access");
  });

  it("useMcpPageContinue navigates to consent with the byte-identical raw query", async () => {
    const signed = await buildRealSignedQuery();
    window.history.pushState({}, "", `/en-US/mcp-login?${signed}`);
    const assign = vi.fn();

    const { result } = renderHook(() => useMcpPageContinue(true, "en-US", assign));
    expect(result.current).toBeUndefined();
    await act(async () => {});

    // Exactly one document navigation, href built from window.location.search.
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/en-US/mcp-consent?${signed}`);
  });

  it("useMcpPageContinue fires only on the rising edge (no loop on consent)", async () => {
    window.history.pushState({}, "", "/en-US/mcp-login?client_id=c&sig=s");
    const assign = vi.fn();
    const { rerender } = renderHook(
      ({ should }: { should: boolean }) => useMcpPageContinue(should, "en-US", assign),
      { initialProps: { should: false } },
    );
    rerender({ should: true });
    rerender({ should: true });
    await act(async () => {});
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("PRODUCTION DEFAULT assign is stable: an unchanged rerender navigates exactly once (R85/R86 N3)", async () => {
    // The reviewers' probe shape: no injected mock — the hook's own default
    // callback runs (window.location.assign stubbed). The default must be a
    // stable module-level adapter; an inline per-render default re-fires the
    // effect on every ordinary rerender while shouldContinue stays true.
    window.history.pushState({}, "", "/en-US/mcp-login?client_id=c&sig=s");
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, search: "?client_id=c&sig=s" });

    const { rerender } = renderHook(() => useMcpPageContinue(true, "en-US"));
    rerender();
    await act(async () => {});

    // Exactly one document navigation despite the rerender.
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/en-US/mcp-consent?client_id=c&sig=s");
  });
});
