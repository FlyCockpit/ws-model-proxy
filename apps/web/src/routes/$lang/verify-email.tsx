import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button, buttonVariants } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useTranslation } from "react-i18next";

import { ResendVerification } from "@/components/auth/resend-verification";
import { useAuthSession } from "@/hooks/use-auth-session";
import { parseVerifyEmailSearch } from "@/lib/verify-email-search";
import { orpc } from "@/utils/orpc";

/**
 * Landing page for the link in the account-verification email.
 *
 * The emailed link points at Better-Auth's `/api/auth/verify-email`, which
 * validates the token, flips `emailVerified`, and 302s here with `?ok=1` or
 * `&error=<CODE>`. This page never sees or handles a token.
 *
 * Three states (unguarded, directly navigable):
 *   • `?error=` → the link failed; offer a resend.
 *   • `?ok=1`   → real verification hop; confirm it.
 *   • neither   → bare visit; offer a resend without claiming success.
 */
export const Route = createFileRoute("/$lang/verify-email")({
  validateSearch: parseVerifyEmailSearch,
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const { lang } = Route.useParams();
  const { error, ok } = Route.useSearch();
  const authSession = useAuthSession();
  const {
    data: configData,
    isPending: configPending,
    isError: configError,
    refetch: refetchConfig,
  } = useQuery(orpc.appConfig.queryOptions());
  const { t } = useTranslation(["auth", "common"]);

  const isAuthenticated = authSession.state.status === "authenticated";
  const canResend = configData?.emailEnabled === true && configData?.forceSso !== true;

  if (error || !ok) {
    return (
      <AuthCard
        title={error ? t("auth:verifyEmail.invalidTitle") : t("auth:verifyEmail.pendingTitle")}
        description={
          error
            ? t("auth:verifyEmail.invalidDescription")
            : t("auth:verifyEmail.pendingDescription")
        }
      >
        {configPending ? (
          <Skeleton className="h-10 w-full" />
        ) : configError ? (
          <div className="space-y-2 text-center">
            <p className="text-sm text-muted-foreground">
              {t("auth:login.unableToConnectDescription")}
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px] w-full"
              onClick={() => refetchConfig()}
            >
              {t("common:actions.retry")}
            </Button>
          </div>
        ) : canResend ? (
          <ResendVerification />
        ) : (
          <p className="text-center text-sm text-muted-foreground">
            {t("auth:verifyEmail.emailUnavailable")}
          </p>
        )}
        <div className="text-center">
          <Link
            to="/$lang/login"
            params={{ lang }}
            search={{ redirectTo: undefined }}
            className={cn(buttonVariants({ variant: "link" }), "min-h-[44px]")}
          >
            {t("auth:verifyEmail.backToLogin")}
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t("auth:verifyEmail.successTitle")}
      description={
        isAuthenticated
          ? t("auth:verifyEmail.successDescriptionSignedIn")
          : t("auth:verifyEmail.successDescription")
      }
    >
      {isAuthenticated ? (
        <Link
          to="/$lang/dashboard"
          params={{ lang }}
          className={cn(buttonVariants(), "min-h-[44px] w-full")}
        >
          {t("auth:verifyEmail.continue")}
        </Link>
      ) : (
        <Link
          to="/$lang/login"
          params={{ lang }}
          search={{ redirectTo: undefined }}
          className={cn(buttonVariants(), "min-h-[44px] w-full")}
        >
          {t("auth:verifyEmail.signIn")}
        </Link>
      )}
    </AuthCard>
  );
}

function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
    </div>
  );
}
