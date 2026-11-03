import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { buttonVariants } from "@ws-model-proxy/ui/lib/button-variants";
import { toast } from "@ws-model-proxy/ui/lib/toast";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AuthCard } from "@/components/auth/auth-card";
import { EmailOnlyForm } from "@/components/auth/email-only-form";
import { authClient } from "@/lib/auth-client";
import { decideAnonymousOnlyRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";
import { friendly, isRateLimit } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

/**
 * Request a password-reset link (signed-out only, like the sign-in page).
 *
 * Reset by email exists only when SMTP is configured; otherwise the page says
 * so. Better Auth's `/request-password-reset` answers alike whether or not an
 * account exists, and this page always shows the same confirmation. Only a
 * rate limit (per IP or per recipient, which never depends on the account
 * existing) is surfaced.
 */
export const Route = createFileRoute("/$lang/forgot-password")({
  beforeLoad: async ({ params }) => {
    const decision = decideAnonymousOnlyRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-authenticated") {
      throw redirect({ to: "/$lang/overview", params: { lang: params.lang } });
    }
  },
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const { lang } = Route.useParams();
  const config = useQuery(orpc.app.config.queryOptions());
  const { t } = useTranslation(["auth", "common"]);
  const [sent, setSent] = useState(false);

  if (config.isPending) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center px-4">
        <div className="w-full max-w-md space-y-6">
          <div className="space-y-2 text-center">
            <Skeleton className="mx-auto h-8 w-48" />
            <Skeleton className="mx-auto h-4 w-64" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        </div>
      </div>
    );
  }

  const backToLogin = (
    <div className="text-center">
      <Link
        to="/$lang/login"
        params={{ lang }}
        search={{ redirectTo: undefined }}
        className={cn(buttonVariants({ variant: "link" }), "min-h-[44px]")}
      >
        {t("auth:forgotPassword.backToLogin")}
      </Link>
    </div>
  );

  if (config.isError) {
    return (
      <AuthCard
        title={t("auth:login.unableToConnect")}
        description={t("auth:login.unableToConnectDescription")}
      >
        <Button className="min-h-[44px] w-full" onClick={() => config.refetch()}>
          {t("common:actions.retry")}
        </Button>
        {backToLogin}
      </AuthCard>
    );
  }

  if (config.data?.emailEnabled !== true) {
    return (
      <AuthCard
        title={t("auth:forgotPassword.title")}
        description={t("auth:forgotPassword.emailUnavailable")}
      >
        {backToLogin}
      </AuthCard>
    );
  }

  if (sent) {
    return (
      <AuthCard
        title={t("auth:forgotPassword.sentTitle")}
        description={t("auth:forgotPassword.sent")}
      >
        {backToLogin}
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t("auth:forgotPassword.title")}
      description={t("auth:forgotPassword.description")}
    >
      <ForgotPasswordForm lang={lang} onSent={() => setSent(true)} />
      {backToLogin}
    </AuthCard>
  );
}

function ForgotPasswordForm({ lang, onSent }: { lang: string; onSent: () => void }) {
  const { t } = useTranslation(["auth"]);
  return (
    <EmailOnlyForm
      submitLabel={t("auth:forgotPassword.submit")}
      submittingLabel={t("auth:forgotPassword.submitting")}
      onSubmit={async (email) => {
        // The server rewrites the emailed callback to this app's reset page; the
        // path here only tells it which locale the person is using.
        const result = await authClient.requestPasswordReset({
          email,
          redirectTo: `/${lang}/reset-password`,
        });
        if (result.error) {
          if (isRateLimit(result.error)) {
            toast.error(friendly(result.error));
            return;
          }
          // Any other refusal gets the same neutral confirmation.
          console.error("[forgot-password.request]", result.error);
        }
        onSent();
      }}
    />
  );
}
