import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthScreenSkeleton } from "@/components/auth/auth-form-skeleton";
import { SignInCard } from "@/components/auth/sign-in-card";
import { markAnonymousOnlyRoute } from "@/lib/document-identity";
import { resolveRouteSession } from "@/lib/route-session";
import { decideAnonymousOnlyRouteAccess } from "@/lib/route-session-access";
import { stripInviteFromAddressBar } from "@/lib/signup-search";
import { safeRedirectTo } from "@/utils/safe-redirect";

export const Route = createFileRoute("/$lang/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirectTo: typeof search.redirectTo === "string" ? search.redirectTo : undefined,
  }),
  beforeLoad: async ({ params, search }) => {
    const decision = decideAnonymousOnlyRouteAccess(await resolveRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-authenticated") {
      throw redirect({ href: safeRedirectTo(search.redirectTo, params.lang) });
    }
  },
  pendingComponent: AuthScreenSkeleton,
  component: LoginPage,
});

/**
 * "Sign in" on an invite link arrives with `redirectTo=/{lang}/signup?invite=<token>`: the page
 * keeps it (router state) and takes it out of the address bar and history entry on mount.
 */
function stripInviteRef(element: HTMLDivElement | null): void {
  if (element) stripInviteFromAddressBar();
}

function LoginPage() {
  markAnonymousOnlyRoute();
  const { lang } = Route.useParams();
  const { redirectTo } = Route.useSearch();

  // The entire sign-in UI (SSO, email/password, email-OTP, TOTP/2FA) lives in
  // the shared SignInCard — the same component the MCP login route
  // (/$lang/mcp-login) renders in "mcp" mode. This route passes mode
  // "standard", which preserves the pre-Phase-6 behavior byte-for-byte.
  return (
    <div ref={stripInviteRef} className="contents">
      <SignInCard lang={lang} mode="standard" redirectTo={redirectTo} />
    </div>
  );
}
