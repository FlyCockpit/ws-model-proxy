import { appShellHydrated } from "@/lib/app-shell-hydration";
import { admitRouteIdentity, identityVerificationGeneration } from "@/lib/document-identity";
import type { RouteSessionResolution } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";

/**
 * The session guards' probe: `getRouteSession()`, then the document's
 * identity check (`lib/document-identity.ts`). When the server answers with a
 * different identity than the one this document's cached data belongs to (a
 * switch made in another tab, or while this tab sat on a page whose watcher
 * had not seen it yet), the document is replaced and this never settles, so
 * nothing under the guard renders the previous identity's data. It also waits
 * for the server-rendered shell skeleton to hydrate, so a guard's redirect
 * never lands mid-hydration (React #418). Every session
 * guard uses this, never `getRouteSession()` alone (`pnpm
 * policy:web-conventions` G11).
 */
export async function resolveRouteSession(): Promise<RouteSessionResolution> {
  // Nothing a guard decides (redirect, not-found, error) may reach the router
  // while the server-rendered shell is still hydrating
  // (lib/app-shell-hydration.ts). The wait runs alongside the probe, and a
  // failed probe (a transport error) also waits before it reaches the router.
  // Taken before the probe: an identity change announced while it runs is
  // newer than its answer.
  const since = identityVerificationGeneration();
  const [probe] = await Promise.allSettled([getRouteSession(), appShellHydrated()]);
  if (probe.status === "rejected") throw probe.reason;
  const resolution = probe.value;
  await admitRouteIdentity(resolution, since);
  return resolution;
}
