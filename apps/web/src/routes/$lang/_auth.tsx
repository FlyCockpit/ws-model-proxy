import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { TwoFactorSetupDetails } from "@/components/two-factor-setup-details";
import { useTotpEnrollment } from "@/hooks/use-totp-enrollment";
import { decideProtectedRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth")({
  beforeLoad: async ({ location, params }) => {
    const decision = decideProtectedRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-to-login") {
      throw redirect({
        to: "/$lang/login",
        params: { lang: params.lang },
        search: { redirectTo: location.href },
      });
    }
    return { session: decision.session };
  },
  component: AuthLayout,
});

function AuthLayout() {
  const { session } = Route.useRouteContext();
  const has2FA = session.user.twoFactorEnabled === true;
  // With forced 2FA, every signed-in procedure refuses a person without a second factor
  // (FORBIDDEN). One cheap read tells the layout whether to show the setup instead.
  const probe = useQuery({
    ...orpc.settings.get.queryOptions(),
    enabled: !has2FA,
    retry: false,
    meta: { skipGlobalErrorToast: true },
  });
  const { t } = useTranslation(["common", "dashboard"]);

  if (has2FA) return <Outlet />;

  if (probe.isPending) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-5 w-64" />
        <div className="mt-8 space-y-3">
          <Skeleton className="h-32 w-full rounded-lg" />
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  if (probe.isError) {
    if (isForbidden(probe.error)) return <TwoFactorSetupRequired />;
    return (
      <div className="container mx-auto max-w-4xl px-4">
        <InlineRetry
          className="py-12"
          message={t("dashboard:appSettingsLoadFailed")}
          onRetry={() => probe.refetch()}
        />
      </div>
    );
  }

  return <Outlet />;
}

function isForbidden(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "FORBIDDEN"
  );
}

function TwoFactorSetupRequired() {
  const { t } = useTranslation("auth");
  const enrollment = useTotpEnrollment({
    messages: {
      couldNotStartSetup: t("twoFactor.couldNotStartSetup"),
      invalidCode: t("errors.invalidTotp"),
      enabled: t("twoFactor.enabledSuccess"),
    },
    logPrefix: "_auth.twoFactor",
    confirmBackupCodes: false,
    onVerified: () => window.location.reload(),
  });
  const { state } = enrollment;

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t("twoFactor.requiredTitle")}</CardTitle>
          <CardDescription>{t("twoFactor.requiredDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.kind === "idle" && (
            <>
              <p className="text-sm text-muted-foreground">{t("twoFactor.introText")}</p>
              <Button className="min-h-[44px] w-full" onClick={() => enrollment.start()}>
                {t("twoFactor.setUp")}
              </Button>
            </>
          )}

          {state.kind === "password" && (
            <>
              <p className="text-sm text-muted-foreground">{t("twoFactor.passwordPrompt")}</p>
              <div className="space-y-2">
                <Label htmlFor="2fa-password">{t("fields.password")}</Label>
                <Input
                  id="2fa-password"
                  type="password"
                  autoComplete="current-password"
                  value={state.password}
                  onChange={(e) => enrollment.setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") enrollment.enable();
                  }}
                />
              </div>
              <Button
                className="min-h-[44px] w-full"
                onClick={() => enrollment.enable()}
                disabled={!state.password || state.activity.kind === "enabling"}
              >
                {state.activity.kind === "enabling"
                  ? t("twoFactor.settingUp")
                  : t("twoFactor.continue")}
              </Button>
            </>
          )}

          {state.kind === "verify" && (
            <>
              <TwoFactorSetupDetails
                backupCodes={state.backupCodes}
                backupCodesLabel={t("twoFactor.backupCodesLabel")}
                manualPrompt={t("twoFactor.addKeyToApp")}
                qrPrompt={t("twoFactor.scanQrPrompt")}
                totpURI={state.totpURI}
              />

              <div className="space-y-2">
                <Label htmlFor="verify-code">{t("fields.verificationCode")}</Label>
                <Input
                  id="verify-code"
                  placeholder="000000"
                  value={state.code}
                  onChange={(e) => enrollment.setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  className="text-center text-lg tracking-widest"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") enrollment.verify();
                  }}
                />
              </div>
              <Button
                className="min-h-[44px] w-full"
                onClick={() => enrollment.verify()}
                disabled={state.code.length !== 6 || state.activity.kind !== "idle"}
              >
                {state.activity.kind !== "idle"
                  ? t("twoFactor.verifying")
                  : t("twoFactor.verifyAndEnable")}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
