import { serveStatic } from "@hono/node-server/serve-static";
import type { Env, Hono } from "hono";

/**
 * Production static file routes for the built web client (`apps/web/dist/client`).
 * Mounted by app.ts ahead of the SSR catch-all; everything they do not serve
 * falls through to it.
 */
export function mountStaticClient<E extends Env>(app: Hono<E>, clientDir: string): void {
  // Vite/rolldown content-hashes every file under /assets, so each URL is
  // immutable: a code change produces a new filename, never a new body at the
  // same URL. Safe to cache for a year. This middleware runs before the
  // serveStatic below (sets the header, then defers to it).
  // IMPORTANT: do NOT add long caching to the catch-all /* serveStatic or the
  // SSR shell — index.html and version.json must stay revalidated so new
  // deploys are picked up.
  app.use("/assets/*", async (c, next) => {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    await next();
  });
  app.use("/assets/*", serveStatic({ root: clientDir }));
  // A file under /assets that does not exist (a chunk from another build, a
  // typo, a probe) is a plain 404. Without this it would fall through to the
  // SSR catch-all, whose locale redirect answers 307 → /<lang>/assets/... and
  // then renders the app's 404 page as HTML — a module script loader then
  // reports a MIME error instead of a missing file, and the year-long
  // immutable header above would be attached to that redirect. Not cached:
  // the file may exist on the next deploy.
  app.all("/assets/*", (c) => {
    c.header("Cache-Control", "no-store");
    return c.text("Not Found", 404);
  });
  // Browsers already bypass their HTTP cache for the SW script; this keeps
  // proxies/CDNs from caching it heuristically and serving a stale SW.
  app.use("/sw.js", async (c, next) => {
    c.header("Cache-Control", "no-cache");
    await next();
  });
  app.use("/*", serveStatic({ root: clientDir }));
}
