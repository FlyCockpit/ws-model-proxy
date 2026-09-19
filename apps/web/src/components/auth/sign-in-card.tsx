import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button, buttonVariants } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";
import { useAuthSession } from "@/hooks/use-auth-session";
import { authClient } from "@/lib/auth-client";
import { resolveOauthRedirectUrl } from "@/lib/mcp-oauth-search";
import { friendly, isRateLimit } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";
import { safeRedirectTo } from "@/utils/safe-redirect";

/**
 * Shared sign-in card (MCP plan Phase 6).
 *
 * ONE component serves BOTH the ordinary `/$lang/login` route (mode
 * "standard": anonymous-only, signup hint, redirectTo-based post-auth
 * navigation) and the `/$lang/mcp-login` route (mode "mcp": localized MCP
 * title/description, no signup hint, and post-auth navigation that prefers
 * Better Auth's OAuth continuation).
 *
 * The email/password, social (SSO), email-OTP, and TOTP/2FA branches are
 * byte-for-byte the same code for both modes — the ONLY per-mode differences
 * are (a) the header strings, (b) the signup hint (standard only), and
 * (c) how a successful authentication decides where to go next. In mcp mode
 * the sign-in APIs are called EXACTLY as in standard mode; Better Auth's
 * `oauthProviderClient()` fetch plugin (already installed on `authClient`)
 * is what attaches the signed `oauth_query` from `window.location.search` —
 * this component never appends OAuth state itself, and never follows a
 * caller-provided callback: the only accepted continuation is a server
 * response with `redirect === true` plus a nonempty `url`
 * (resolveOauthRedirectUrl).
 */

/** Where a successful authentication should send the user. */
export interface SignInOutcome {
  url: string;
  /**
   * Standard mode keeps its historical SPA navigation for the exact
   * dashboard path; every other destination (and every mcp-mode
   * destination) is a full document load so OAuth redirects work.
   */
  preferRouterNavigate: boolean;
}

export type SignInMode = "standard" | "mcp";

export interface SignInCardProps {
  lang: string;
  mode: SignInMode;
  /**
   * Standard mode: the `redirectTo` search param (validated by
   * safeRedirectTo). MCP mode ignores this in favor of the OAuth
   * continuation contract above.
   */
  redirectTo?: string;
  /** MCP mode: override for the card description (e.g. the requesting client). */
  mcpDescription?: string;
}

export function SignInCard({ lang, mode, redirectTo, mcpDescription }: SignInCardProps) {
  const [needs2FA, setNeeds2FA] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [isVerifying2FA, setIsVerifying2FA] = useState(false);
  // Email-OTP challenge: once the user requests a code by email we switch the
  // verification path from verifyTotp to verifyOtp.
  const [otpSent, setOtpSent] = useState(false);
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const { state } = useAuthSession();
  const config = useQuery(orpc.appConfig.queryOptions());
  const { t } = useTranslation(["auth", "common"]);

  const ssoEnabled = config.data?.ssoEnabled ?? false;
  const forceSso = config.data?.forceSso === true;
  const ssoProviderName = config.data?.ssoProviderName ?? "SSO";
  const signupEnabled =
    !forceSso &&
    ((config.data?.signupEnabled ?? true) || config.data?.adminBootstrapSignupEnabled === true);
  const emailEnabled = config.data?.emailEnabled ?? false;
  const postAuthRedirect = safeRedirectTo(redirectTo, lang);

  // Post-auth destination. MCP mode: a server-issued OAuth continuation wins
  // (redirect === true + nonempty url); the fallback RELOADS the MCP login
  // page, whose authenticated branch routes onward (the signed query stays in
  // the URL). Standard mode: the historical redirectTo behavior, unchanged.
  const resolveOutcome = (data: Record<string, unknown> | undefined): SignInOutcome => {
    if (mode === "mcp") {
      const oauthUrl = resolveOauthRedirectUrl(data);
      if (oauthUrl !== null) return { url: oauthUrl, preferRouterNavigate: false };
      return {
        url: typeof window === "undefined" ? `/${lang}/mcp-login` : window.location.href,
        preferRouterNavigate: false,
      };
    }
    return {
      url: postAuthRedirect,
      preferRouterNavigate: postAuthRedirect === `/${lang}/dashboard`,
    };
  };

  // In mcp mode the SSO callback returns to THIS page (signed query kept in
  // the URL) so the authenticated branch can continue the transaction.
  const ssoCallbackURL =
    mode === "mcp" && typeof window !== "undefined" ? window.location.href : postAuthRedirect;

  if (state.status === "pending" || config.isPending) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center px-4">
        <div className="w-full max-w-md space-y-6">
          <div className="space-y-2 text-center">
            <Skeleton className="mx-auto h-8 w-40" />
            <Skeleton className="mx-auto h-4 w-56" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (config.isError) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">{t("auth:login.unableToConnect")}</CardTitle>
            <CardDescription>{t("auth:login.unableToConnectDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="min-h-[44px] w-full" onClick={() => config.refetch()}>
              {t("common:actions.retry")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleSsoLogin = async () => {
    const result = await authClient.signIn.social({
      provider: "sso",
      callbackURL: ssoCallbackURL,
    });
    if (result.error) {
      console.error("[login.sso]", result.error);
      toast.error(t("auth:login.ssoFailed"));
    }
  };

  const handle2FAVerify = async () => {
    setIsVerifying2FA(true);
    try {
      // When the user requested an emailed code we verify against the OTP
      // endpoint; otherwise the code is a TOTP from their authenticator app.
      const result = otpSent
        ? await authClient.twoFactor.verifyOtp({ code: totpCode })
        : await authClient.twoFactor.verifyTotp({ code: totpCode });
      if (result.error) {
        console.error("[login.twoFactor.verify]", result.error);
        toast.error(t("auth:errors.invalidTotp"));
      } else {
        toast.success(t("auth:signedInSuccess"));
        const outcome = resolveOutcome(result.data as Record<string, unknown> | undefined);
        window.location.assign(outcome.url);
      }
    } finally {
      setIsVerifying2FA(false);
    }
  };

  const handleSendEmailOtp = async () => {
    setIsSendingOtp(true);
    try {
      // Delivery-aware preflight: Better-Auth's send-otp endpoint reports
      // success even when SMTP delivery fails, so verify the transport is
      // actually reachable before telling the user a code is on the way.
      const preflight = await orpc.auth.verifyEmailTransport.call().catch((err) => {
        console.error("[login.twoFactor.verifyEmailTransport]", err);
        return { ok: false };
      });
      if (!preflight.ok) {
        toast.error(t("auth:twoFactor.couldNotSendCode"));
        return;
      }
      const result = await authClient.twoFactor.sendOtp();
      if (result.error) {
        console.error("[login.twoFactor.sendOtp]", result.error);
        toast.error(
          isRateLimit(result.error) ? friendly(result.error) : t("auth:twoFactor.couldNotSendCode"),
        );
        return;
      }
      setOtpSent(true);
      setTotpCode("");
      toast.success(t("auth:twoFactor.codeSent"));
    } finally {
      setIsSendingOtp(false);
    }
  };

  if (needs2FA) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">{t("auth:twoFactor.title")}</CardTitle>
            <CardDescription>
              {otpSent ? t("auth:twoFactor.emailCodeDescription") : t("auth:twoFactor.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="totp-code">{t("auth:fields.verificationCode")}</Label>
              <Input
                id="totp-code"
                placeholder="000000"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="text-center text-lg tracking-widest"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && totpCode.length === 6) {
                    handle2FAVerify();
                  }
                }}
              />
            </div>
            <Button
              className="min-h-[44px] w-full"
              onClick={handle2FAVerify}
              disabled={totpCode.length !== 6 || isVerifying2FA}
            >
              {isVerifying2FA ? t("auth:twoFactor.verifying") : t("auth:twoFactor.verify")}
            </Button>
            {emailEnabled && (
              <Button
                variant="outline"
                className="min-h-[44px] w-full"
                onClick={handleSendEmailOtp}
                disabled={isSendingOtp}
              >
                {isSendingOtp
                  ? t("auth:twoFactor.sendingCode")
                  : otpSent
                    ? t("auth:twoFactor.resendEmailCode")
                    : t("auth:twoFactor.emailMeCode")}
              </Button>
            )}
            <Button
              variant="ghost"
              className="min-h-[44px] w-full"
              onClick={() => {
                setNeeds2FA(false);
                setTotpCode("");
                setOtpSent(false);
              }}
            >
              {t("auth:twoFactor.back")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            {mode === "mcp" ? t("auth:mcpLogin.title") : t("auth:login.signinTitle")}
          </CardTitle>
          {/* The MCP description interpolates the CANONICAL CLIENT NAME
              (untrusted operator-controlled text). The containment lives on
              the CardDescription element ITSELF — the actual grid child of
              CardHeader (packages/ui card.tsx merges `className` via cn()) —
              because classes on an inline descendant cannot constrain the
              grid child's min-content width: the reviewers' Chromium
              measurement showed a 1,868–3,964px description inside a 311px
              card for an unbroken client name (R87/R88 P3). Constraining the
              grid child (min-w-0 max-w-full break-words) measured 279px and
              wrapped. */}
          <CardDescription
            className={mode === "mcp" ? "min-w-0 max-w-full break-words" : undefined}
          >
            {mode === "mcp"
              ? (mcpDescription ?? t("auth:mcpLogin.description"))
              : forceSso
                ? t("auth:login.ssoOnlyDescription", { provider: ssoProviderName })
                : t("auth:login.signinDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {ssoEnabled && (
            <>
              <Button variant="outline" className="min-h-[44px] w-full" onClick={handleSsoLogin}>
                {t("auth:login.ssoContinue", { provider: ssoProviderName })}
              </Button>
              {!forceSso && (
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">{t("auth:login.or")}</span>
                  </div>
                </div>
              )}
            </>
          )}
          {!forceSso && (
            <SignInForm
              lang={lang}
              redirectTo={postAuthRedirect}
              onNeeds2FA={() => setNeeds2FA(true)}
              resolveOutcome={resolveOutcome}
            />
          )}
          {forceSso && !ssoEnabled && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {t("auth:login.ssoUnavailable")}
            </div>
          )}
          {mode === "standard" && signupEnabled && (
            <div className="text-center">
              <Link
                to="/$lang/signup"
                params={{ lang }}
                search={{ redirectTo }}
                className={cn(buttonVariants({ variant: "link" }), "min-h-[44px]")}
              >
                {t("auth:login.signupHint")}
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SignInForm({
  lang,
  redirectTo,
  onNeeds2FA,
  resolveOutcome,
}: {
  lang: string;
  redirectTo: string;
  onNeeds2FA: () => void;
  resolveOutcome: (data: Record<string, unknown> | undefined) => SignInOutcome;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation(["auth"]);

  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }) => {
      // UNCHANGED sign-in API: no OAuth state is appended here. When the page
      // URL carries a signed oauth_query, Better Auth's oauthProviderClient
      // fetch plugin attaches it server-verified; the response then contains
      // the OAuth continuation (redirect === true + url) which
      // resolveOutcome prefers in mcp mode.
      const result = await authClient.signIn.email({
        email: value.email,
        password: value.password,
      });
      if (result.error) {
        toast.error(
          isRateLimit(result.error) ? friendly(result.error) : t("auth:errors.invalidCredentials"),
        );
        return;
      }
      if ((result.data as Record<string, unknown>)?.twoFactorRedirect) {
        onNeeds2FA();
        return;
      }
      toast.success(t("auth:signedInSuccess"));
      const outcome = resolveOutcome(result.data as Record<string, unknown> | undefined);
      if (outcome.preferRouterNavigate && redirectTo === `/${lang}/dashboard`) {
        navigate({ to: "/$lang/dashboard", params: { lang } });
      } else {
        window.location.assign(outcome.url);
      }
    },
    validators: {
      // Validation messages come from the locale-aware Zod error map installed
      // in `@/i18n/zod`. Don't pass inline strings here — that would override
      // the global map and leak hardcoded English copy into es-MX UIs.
      onSubmit: z.object({
        email: z.email(),
        password: z.string().min(1),
      }),
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
      className="space-y-4"
    >
      <form.Field name="email">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{t("auth:fields.email")}</Label>
            <Input
              id={field.name}
              name={field.name}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
            />
            {field.state.meta.errors.map((error) => (
              <p key={error?.message} className="text-sm text-destructive">
                {error?.message}
              </p>
            ))}
          </div>
        )}
      </form.Field>

      <form.Field name="password">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{t("auth:fields.password")}</Label>
            <Input
              id={field.name}
              name={field.name}
              type="password"
              autoComplete="current-password"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
            />
            {field.state.meta.errors.map((error) => (
              <p key={error?.message} className="text-sm text-destructive">
                {error?.message}
              </p>
            ))}
          </div>
        )}
      </form.Field>

      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <Button
            type="submit"
            className="min-h-[44px] w-full"
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? t("auth:login.signingIn") : t("auth:login.signIn")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
