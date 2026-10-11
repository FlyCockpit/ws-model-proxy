import { createFileRoute } from "@tanstack/react-router";

import { ResetPasswordCard } from "@/components/auth/reset-password-card";
import { parseResetPasswordSearch } from "@/lib/reset-password-search";

/**
 * Landing page for the emailed password-reset link (public, unguarded like
 * verify-email: the link works whether or not this browser is signed in, and a
 * reset signs the account out everywhere).
 *
 * Better Auth's `/api/auth/reset-password/<token>` checks the token and 302s
 * here with `?token=` or `?error=INVALID_TOKEN`. The card captures the token,
 * then takes it out of the address bar.
 */
export const Route = createFileRoute("/$lang/reset-password")({
  validateSearch: parseResetPasswordSearch,
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { lang } = Route.useParams();
  const { token, error } = Route.useSearch();
  return <ResetPasswordCard lang={lang} token={token} error={error} />;
}
