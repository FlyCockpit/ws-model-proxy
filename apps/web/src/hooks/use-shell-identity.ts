import { useRouterState } from "@tanstack/react-router";

import { useAuthSession } from "@/hooks/use-auth-session";

/** Layout routes whose guard admits only a signed-in person. */
const SIGNED_IN_ROUTES = new Set<string>(["/$lang/_auth", "/$lang/admin"]);

export type ShellIdentity = { signedIn: boolean; role: string | null };

/** The `session.user.role` a route guard put in a match's context (`""` for no role), or null. */
function routeRoleOf(context: unknown): string | null {
  if (typeof context !== "object" || context === null || !("session" in context)) return null;
  const { session } = context;
  if (typeof session !== "object" || session === null || !("user" in session)) return null;
  const { user } = session;
  if (typeof user !== "object" || user === null) return null;
  const role = "role" in user ? user.role : null;
  return typeof role === "string" ? role : "";
}

/**
 * Who the app shell (sidebar, bottom nav, header) draws its navigation for. The browser session
 * (`useAuthSession`) decides once it is known; while it is still loading, the session the route
 * guard already resolved (`/$lang/_auth`, `/$lang/admin`) stands in, so the first frame of a
 * reload already shows the signed-in shell rather than a signed-out one that then jumps.
 * Only the shell's navigation uses this; everything else reads `useAuthSession`.
 */
export function useShellIdentity(): ShellIdentity {
  const { state } = useAuthSession();
  const routeRole = useRouterState({
    select: (router) => {
      for (const match of router.matches) {
        const role = routeRoleOf(match.context);
        if (role !== null) return role;
      }
      // A reload into a signed-in page, its guard still checking: the page is only ever drawn
      // signed in (a signed-out visit redirects to the login page), so the nav is too, role
      // unknown until the guard answers.
      return router.matches.some((match) => SIGNED_IN_ROUTES.has(match.routeId)) ? "" : null;
    },
  });
  if (state.session) {
    const role = state.session.user.role;
    return { signedIn: true, role: typeof role === "string" ? role : null };
  }
  if (state.status === "pending" && routeRole !== null)
    return { signedIn: true, role: routeRole === "" ? null : routeRole };
  return { signedIn: false, role: null };
}
