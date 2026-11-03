import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
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
import { buttonVariants } from "@ws-model-proxy/ui/lib/button-variants";
import { toast } from "@ws-model-proxy/ui/lib/toast";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useTranslation } from "react-i18next";
import z from "zod";
import { AuthFormSkeleton } from "@/components/auth/auth-form-skeleton";
import { AuthRetryCard } from "@/components/auth/auth-retry-card";
import { useAuthSession } from "@/hooks/use-auth-session";
import { useGuardedMachine } from "@/hooks/use-guarded-machine";
import { authClient } from "@/lib/auth-client";
import { resolveOauthRedirectUrl } from "@/lib/mcp-oauth-search";
import {
  initialSignInTwoFactorState,
  type SignInTwoFactorEvent,
  type SignInTwoFactorState,
  signInTwoFactorTransition,
} from "@/lib/two-factor-state";
import { friendly, isRateLimit, isUserDeletionPending } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";
import { safeRedirectTo } from "@/utils/safe-redirect";

/**
 * Shared sign-in card (Phase 6).
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
   * overview path; every other destination (and every mcp-mode
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

/**
 * Post-auth destination. MCP mode: a server-issued OAuth continuation wins
 * (redirect === true + nonempty url); the fallback RELOADS the MCP login
 * page, whose authenticated branch routes onward (the signed query stays in
 * the URL). Standard mode: the historical redirectTo behavior, unchanged.
 */
function resolveSignInOutcome(
  mode: SignInMode,
  lang: string,
  postAuthRedirect: string,
  data: Record<string, unknown> | undefined,
): SignInOutcome {
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
    preferRouterNavigate: postAuthRedirect === `/${lang}/overview`,
  };
}

/**
 * The 2FA step's state machine (`SignInTwoFactorState`). It lives in
 * SignInCard so it survives the card switching branches.
 */
function useTwoFactorChallenge() {
  return useGuardedMachine<SignInTwoFactorState, SignInTwoFactorEvent>(
    initialSignInTwoFactorState,
    signInTwoFactorTransition,
  );
}

type TwoFactorChallenge = ReturnType<typeof useTwoFactorChallenge>;
type ChallengeState = Extract<SignInTwoFactorState, { kind: "challenge" }>;
type ResolveOutcome = (data: Record<string, unknown> | undefined) => SignInOutcome;

export function SignInCard({ lang, mode, redirectTo, mcpDescription }: SignInCardProps) {
  const twoFactor = useTwoFactorChallenge();
  const { state } = useAuthSession();
  const config = useQuery(orpc.app.config.queryOptions());
  const { t } = useTranslation(["auth", "common"]);

  const emailEnabled = config.data?.emailEnabled ?? false;
  const postAuthRedirect = safeRedirectTo(redirectTo, lang);
  const resolveOutcome: ResolveOutcome = (data) =>
    resolveSignInOutcome(mode, lang, postAuthRedirect, data);

  // In mcp mode the SSO callback returns to THIS page (signed query kept in
  // the URL) so the authenticated branch can continue the transaction.

  if (state.status === "pending" || config.isPending) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center px-4">
        <AuthFormSkeleton />
      </div>
    );
  }

  if (config.isError) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center px-4">
        <AuthRetryCard
          title={t("auth:login.unableToConnect")}
          description={t("auth:login.unableToConnectDescription")}
          onRetry={() => config.refetch()}
        />
      </div>
    );
  }

  if (twoFactor.state.kind === "challenge") {
    return (
      <TwoFactorCard
        challenge={twoFactor.state}
        machine={twoFactor}
        emailEnabled={emailEnabled}
        resolveOutcome={resolveOutcome}
      />
    );
  }

  const signupEnabled =
    (config.data?.signupEnabled ?? true) || config.data?.adminBootstrapSignupEnabled === true;
  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <SignInHeader mode={mode} mcpDescription={mcpDescription} />
        <CardContent className="space-y-4">
          <SignInForm
            lang={lang}
            redirectTo={postAuthRedirect}
            onNeeds2FA={() => twoFactor.send({ type: "required" })}
            resolveOutcome={resolveOutcome}
          />
          {/* Reset by email exists only when SMTP is configured (no mail, no link). */}
          {emailEnabled && (
            <div className="text-center">
              <Link
                to="/$lang/forgot-password"
                params={{ lang }}
                className={cn(buttonVariants({ variant: "link" }), "min-h-[44px]")}
              >
                {t("auth:login.forgotPassword")}
              </Link>
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

function SignInHeader({ mode, mcpDescription }: { mode: SignInMode; mcpDescription?: string }) {
  const { t } = useTranslation(["auth"]);
  return (
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
      <CardDescription className={mode === "mcp" ? "min-w-0 max-w-full break-words" : undefined}>
        {mode === "mcp"
          ? (mcpDescription ?? t("auth:mcpLogin.description"))
          : t("auth:login.signinDescription")}
      </CardDescription>
    </CardHeader>
  );
}

function TwoFactorCard({
  challenge,
  machine,
  emailEnabled,
  resolveOutcome,
}: {
  challenge: ChallengeState;
  machine: TwoFactorChallenge;
  emailEnabled: boolean;
  resolveOutcome: ResolveOutcome;
}) {
  const { t } = useTranslation(["auth"]);
  const { send, nextAttempt, current } = machine;

  const handle2FAVerify = async () => {
    const before = current();
    if (before.kind !== "challenge") return;
    const attempt = nextAttempt();
    // Rejected unless the challenge is idle with a full code: no double
    // submit from Enter + click, and no verify racing an email send.
    if (!send({ type: "verifyStarted", attempt })) return;
    try {
      // When the user requested an emailed code we verify against the OTP
      // endpoint; otherwise the code is a TOTP from their authenticator app.
      const result =
        before.method === "email"
          ? await authClient.twoFactor.verifyOtp({ code: before.code })
          : await authClient.twoFactor.verifyTotp({ code: before.code });
      if (result.error) {
        console.error("[login.twoFactor.verify]", result.error);
        if (!send({ type: "verifyFailed", attempt })) return;
        // The 2FA step mints the session, so a pending deletion surfaces here.
        toast.error(
          isRateLimit(result.error) || isUserDeletionPending(result.error)
            ? friendly(result.error)
            : t("auth:errors.invalidTotp"),
        );
        return;
      }
      if (!send({ type: "verifySucceeded", attempt })) return;
      toast.success(t("auth:signedInSuccess"));
      const outcome = resolveOutcome(result.data as Record<string, unknown> | undefined);
      window.location.assign(outcome.url);
    } catch (err) {
      // A thrown request returns the challenge to idle so the user can retry.
      console.error("[login.twoFactor.verify]", err);
      send({ type: "verifyFailed", attempt });
    }
  };

  const handleSendEmailOtp = async () => {
    const attempt = nextAttempt();
    if (!send({ type: "sendStarted", attempt })) return;
    // After Back (or any newer attempt) the completion no longer matches:
    // it neither switches a later challenge to email mode nor toasts.
    const fail = (message: string) => {
      if (send({ type: "sendFailed", attempt })) toast.error(message);
    };
    try {
      // Delivery-aware preflight: Better-Auth's send-otp endpoint reports
      // success even when SMTP delivery fails, so verify the transport is
      // actually reachable before telling the user a code is on the way.
      const preflight = await orpc.auth.verifyEmailTransport.call().catch((err) => {
        console.error("[login.twoFactor.verifyEmailTransport]", err);
        return { ok: false };
      });
      if (!preflight.ok) {
        fail(t("auth:twoFactor.couldNotSendCode"));
        return;
      }
      const result = await authClient.twoFactor.sendOtp();
      if (result.error) {
        console.error("[login.twoFactor.sendOtp]", result.error);
        fail(
          isRateLimit(result.error) ? friendly(result.error) : t("auth:twoFactor.couldNotSendCode"),
        );
        return;
      }
      if (send({ type: "sendSucceeded", attempt })) toast.success(t("auth:twoFactor.codeSent"));
    } catch (err) {
      console.error("[login.twoFactor.sendOtp]", err);
      send({ type: "sendFailed", attempt });
    }
  };

  const { activity, code, method } = challenge;
  const isVerifying = activity.kind === "verifying" || activity.kind === "redirecting";
  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t("auth:twoFactor.title")}</CardTitle>
          <CardDescription>
            {method === "email"
              ? t("auth:twoFactor.emailCodeDescription")
              : t("auth:twoFactor.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="totp-code">{t("auth:fields.verificationCode")}</Label>
            <Input
              id="totp-code"
              placeholder="000000"
              value={code}
              onChange={(e) => send({ type: "codeChanged", code: e.target.value })}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="text-center text-lg tracking-widest"
              onKeyDown={(e) => {
                if (e.key === "Enter") handle2FAVerify();
              }}
            />
          </div>
          <Button
            className="min-h-[44px] w-full"
            onClick={handle2FAVerify}
            disabled={code.length !== 6 || activity.kind !== "idle"}
          >
            {isVerifying ? t("auth:twoFactor.verifying") : t("auth:twoFactor.verify")}
          </Button>
          {emailEnabled && <EmailCodeButton challenge={challenge} onClick={handleSendEmailOtp} />}
          <Button
            variant="ghost"
            className="min-h-[44px] w-full"
            onClick={() => send({ type: "back" })}
            disabled={isVerifying}
          >
            {t("auth:twoFactor.back")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function EmailCodeButton({
  challenge,
  onClick,
}: {
  challenge: ChallengeState;
  onClick: () => void;
}) {
  const { t } = useTranslation(["auth"]);
  const isSending = challenge.activity.kind === "sending";
  return (
    <Button
      variant="outline"
      className="min-h-[44px] w-full"
      onClick={onClick}
      disabled={challenge.activity.kind !== "idle"}
    >
      {isSending
        ? t("auth:twoFactor.sendingCode")
        : challenge.method === "email"
          ? t("auth:twoFactor.resendEmailCode")
          : t("auth:twoFactor.emailMeCode")}
    </Button>
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
          isRateLimit(result.error) || isUserDeletionPending(result.error)
            ? friendly(result.error)
            : t("auth:errors.invalidCredentials"),
        );
        return;
      }
      if ((result.data as Record<string, unknown>)?.twoFactorRedirect) {
        onNeeds2FA();
        return;
      }
      toast.success(t("auth:signedInSuccess"));
      const outcome = resolveOutcome(result.data as Record<string, unknown> | undefined);
      if (outcome.preferRouterNavigate && redirectTo === `/${lang}/overview`) {
        navigate({ to: "/$lang/overview", params: { lang } });
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
