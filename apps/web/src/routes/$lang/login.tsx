import { createFileRoute, redirect } from "@tanstack/react-router";
import { SignInCard } from "@/components/auth/sign-in-card";
import { decideAnonymousOnlyRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";
import { safeRedirectTo } from "@/utils/safe-redirect";

export const Route = createFileRoute("/$lang/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirectTo: typeof search.redirectTo === "string" ? search.redirectTo : undefined,
  }),
  beforeLoad: async ({ params, search }) => {
    const decision = decideAnonymousOnlyRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-authenticated") {
      throw redirect({ href: safeRedirectTo(search.redirectTo, params.lang) });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const { lang } = Route.useParams();
  const { redirectTo } = Route.useSearch();

  // The entire sign-in UI (SSO, email/password, email-OTP, TOTP/2FA) lives in
  // the shared SignInCard — the same component the MCP login route
  // (/$lang/mcp-login) renders in "mcp" mode. This route passes mode
  // "standard", which preserves the pre-Phase-6 behavior byte-for-byte.
  return <SignInCard lang={lang} mode="standard" redirectTo={redirectTo} />;
}
