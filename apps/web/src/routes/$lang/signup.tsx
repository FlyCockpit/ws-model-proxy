import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { validateForwarderSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import { INVITE_IN_USE_CODE, SHARE_INVITE_HEADER } from "@ws-model-proxy/config/share-invite";
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
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";
import { AuthFormSkeleton } from "@/components/auth/auth-form-skeleton";
import { AuthRetryCard } from "@/components/auth/auth-retry-card";
import { ResendVerification } from "@/components/auth/resend-verification";
import { useAuthSession } from "@/hooks/use-auth-session";
import { authClient } from "@/lib/auth-client";
import { decideAnonymousOnlyRouteAccess } from "@/lib/route-session-access";
import { parseSignupSearch, stripInviteFromAddressBar } from "@/lib/signup-search";
import { getRouteSession } from "@/server/auth-session";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";
import { inviteSignupPath, safeRedirectTo } from "@/utils/safe-redirect";

export const Route = createFileRoute("/$lang/signup")({
  validateSearch: parseSignupSearch,
  beforeLoad: async ({ context, params, search }) => {
    const decision = decideAnonymousOnlyRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    // A signed-in person with an invite link stays: the page offers to accept it.
    if (decision.kind === "redirect-authenticated" && !search.invite) {
      throw redirect({ href: safeRedirectTo(search.redirectTo, params.lang) });
    }
    const cfg = await context.queryClient.ensureQueryData(orpc.app.config.queryOptions());
    // An invite link signs up even with open sign-up off; the page checks the token
    // (auth.inviteInfo) and the server lets only a pending invite's token through.
    if (!cfg.signupEnabled && !cfg.adminBootstrapSignupEnabled && !search.invite) {
      throw redirect({
        to: "/$lang/login",
        params: { lang: params.lang },
        search: { redirectTo: search.redirectTo },
      });
    }
  },
  component: SignupPage,
});

/** Mounting the page takes the invite token out of the address bar (the page keeps it). */
function stripInviteRef(element: HTMLDivElement | null): void {
  if (element) stripInviteFromAddressBar();
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div ref={stripInviteRef} className="flex min-h-[80vh] items-center justify-center px-4">
      {children}
    </div>
  );
}

function SignupPage() {
  const { lang } = Route.useParams();
  const search = Route.useSearch();
  const { redirectTo } = search;
  // Read once: the address bar loses the token right after this render.
  const [invite] = useState(search.invite);
  const { state } = useAuthSession();
  const config = useQuery(orpc.app.config.queryOptions());
  const inviteInfo = useQuery({
    ...orpc.auth.inviteInfo.queryOptions({ input: { token: invite ?? "" } }),
    enabled: invite !== undefined,
  });
  const { t } = useTranslation(["auth", "common"]);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  const emailEnabled = config.data?.emailEnabled === true;
  const validInvite = validInviteOf(invite, inviteInfo.data);
  const view = pickSignupView({
    pendingEmail,
    sessionStatus: state.status,
    configPending: config.isPending,
    configError: config.isError,
    invite,
    invitePending: inviteInfo.isPending,
    inviteError: inviteInfo.isError,
    validInvite,
  });

  switch (view.kind) {
    case "verificationPending":
      return <VerificationPendingCard lang={lang} email={view.email} canResend={emailEnabled} />;
    case "loading":
      return (
        <Frame>
          <AuthFormSkeleton />
        </Frame>
      );
    case "configError":
      return (
        <Frame>
          <AuthRetryCard
            title={t("auth:login.unableToConnect")}
            description={t("auth:login.unableToConnectDescription")}
            onRetry={() => config.refetch()}
          />
        </Frame>
      );
    case "inviteError":
      return (
        <Frame>
          <AuthRetryCard
            title={t("auth:invite.checkFailedTitle")}
            description={t("auth:invite.checkFailedDescription")}
            onRetry={() => inviteInfo.refetch()}
          />
        </Frame>
      );
    case "invalidInvite":
      return <InvalidInviteCard lang={lang} signedIn={view.signedIn} redirectTo={redirectTo} />;
    case "acceptInvite":
      return (
        <Frame>
          <AcceptInviteCard
            lang={lang}
            token={view.token}
            ownerName={view.invite.ownerName ?? ""}
            target={view.invite.target}
          />
        </Frame>
      );
    case "form":
      return (
        <SignupFormCard
          lang={lang}
          redirectTo={redirectTo}
          emailEnabled={emailEnabled}
          invite={invite}
          validInvite={validInvite}
          onAccountCreatedNeedingVerification={setPendingEmail}
        />
      );
  }
}

/** A pending invite as `auth.inviteInfo` returns it. */
type InviteDetails = {
  email: string | null;
  ownerName: string | null;
  target: { kind: "pool" | "runtime"; name: string } | null;
};

/** The account exists and waits for e-mail verification (or has no e-mail to verify with). */
function VerificationPendingCard({
  lang,
  email,
  canResend,
}: {
  lang: string;
  email: string;
  canResend: boolean;
}) {
  const { t } = useTranslation(["auth", "common"]);
  return (
    <Frame>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            {canResend ? t("auth:verifyEmail.sentTitle") : t("auth:verifyEmail.pendingTitle")}
          </CardTitle>
          <CardDescription>
            {canResend
              ? t("auth:verifyEmail.sentDescription", { email })
              : t("auth:verifyEmail.accountCreatedNoEmail", { email })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Link
            to="/$lang/login"
            params={{ lang }}
            search={{ redirectTo: undefined }}
            className={cn(buttonVariants(), "min-h-[44px] w-full")}
          >
            {t("auth:verifyEmail.signIn")}
          </Link>
          {canResend ? (
            <ResendVerification email={email} />
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              {t("auth:verifyEmail.emailUnavailable")}
            </p>
          )}
        </CardContent>
      </Card>
    </Frame>
  );
}

/** The invite as `auth.inviteInfo` returned it, when the page has a token and it is valid. */
function validInviteOf(
  invite: string | undefined,
  data: (InviteDetails & { valid: boolean }) | undefined,
): InviteDetails | null {
  return invite !== undefined && data?.valid === true ? data : null;
}

type SignupView =
  | { kind: "verificationPending"; email: string }
  | { kind: "loading" }
  | { kind: "configError" }
  | { kind: "inviteError" }
  | { kind: "invalidInvite"; signedIn: boolean }
  | { kind: "acceptInvite"; token: string; invite: InviteDetails }
  | { kind: "form" };

/** Which card the sign-up page shows, checked in this order. */
function pickSignupView({
  pendingEmail,
  sessionStatus,
  configPending,
  configError,
  invite,
  invitePending,
  inviteError,
  validInvite,
}: {
  pendingEmail: string | null;
  sessionStatus: string;
  configPending: boolean;
  configError: boolean;
  invite: string | undefined;
  invitePending: boolean;
  inviteError: boolean;
  validInvite: InviteDetails | null;
}): SignupView {
  if (pendingEmail) return { kind: "verificationPending", email: pendingEmail };
  if (sessionStatus === "pending" || configPending || (invite && invitePending)) {
    return { kind: "loading" };
  }
  if (configError) return { kind: "configError" };
  if (invite && inviteError) return { kind: "inviteError" };
  const signedIn = sessionStatus === "authenticated";
  if (invite && !validInvite) return { kind: "invalidInvite", signedIn };
  if (invite && validInvite && signedIn) {
    return { kind: "acceptInvite", token: invite, invite: validInvite };
  }
  return { kind: "form" };
}

/** Sign-up (or sign-up through an invite link) with the link to sign in instead. */
function SignupFormCard({
  lang,
  redirectTo,
  emailEnabled,
  invite,
  validInvite,
  onAccountCreatedNeedingVerification,
}: {
  lang: string;
  redirectTo: string | undefined;
  emailEnabled: boolean;
  invite: string | undefined;
  validInvite: InviteDetails | null;
  onAccountCreatedNeedingVerification: (email: string) => void;
}) {
  const { t } = useTranslation(["auth", "common"]);
  const postAuthRedirect = safeRedirectTo(redirectTo, lang);
  // "Sign in" on an invite link comes back here to accept it.
  const signInRedirect = invite && validInvite ? inviteSignupPath(lang, invite) : redirectTo;
  return (
    <Frame>
      <Card className="w-full max-w-md">
        <SignupCardHeader validInvite={validInvite} />
        <CardContent className="space-y-4">
          <SignUpForm
            lang={lang}
            redirectTo={postAuthRedirect}
            emailEnabled={emailEnabled}
            invite={validInvite && invite ? { token: invite, email: validInvite.email } : null}
            onAccountCreatedNeedingVerification={onAccountCreatedNeedingVerification}
          />
          <div className="text-center">
            <Link
              to="/$lang/login"
              params={{ lang }}
              search={{ redirectTo: signInRedirect }}
              className={cn(buttonVariants({ variant: "link" }), "min-h-[44px]")}
            >
              {validInvite ? t("auth:invite.signInToAccept") : t("auth:login.signinHint")}
            </Link>
          </div>
        </CardContent>
      </Card>
    </Frame>
  );
}

function InvalidInviteCard({
  lang,
  signedIn,
  redirectTo,
}: {
  lang: string;
  signedIn: boolean;
  redirectTo: string | undefined;
}) {
  const { t } = useTranslation(["auth", "common"]);
  return (
    <Frame>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t("auth:invite.invalidTitle")}</CardTitle>
          <CardDescription>{t("auth:invite.invalidDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          {signedIn ? (
            <Link
              to="/$lang/overview"
              params={{ lang }}
              className={cn(buttonVariants({ variant: "link" }), "min-h-[44px]")}
            >
              {t("auth:invite.goToOverview")}
            </Link>
          ) : (
            <Link
              to="/$lang/login"
              params={{ lang }}
              search={{ redirectTo }}
              className={cn(buttonVariants({ variant: "link" }), "min-h-[44px]")}
            >
              {t("auth:login.signinHint")}
            </Link>
          )}
        </CardContent>
      </Card>
    </Frame>
  );
}

function SignupCardHeader({ validInvite }: { validInvite: InviteDetails | null }) {
  const { t } = useTranslation(["auth", "common"]);
  return (
    <CardHeader className="text-center">
      {validInvite ? (
        <>
          <CardTitle className="text-2xl">{t("auth:invite.title")}</CardTitle>
          <CardDescription className="break-words">
            {validInvite.target?.kind === "runtime"
              ? t("auth:invite.runtimeDescription", {
                  ownerName: validInvite.ownerName ?? "",
                  name: validInvite.target.name,
                })
              : t("auth:invite.description", {
                  ownerName: validInvite.ownerName ?? "",
                  callableId: validInvite.target?.name ?? "",
                })}
          </CardDescription>
          <CardDescription>{t("auth:invite.anyEmail")}</CardDescription>
        </>
      ) : (
        <>
          <CardTitle className="text-2xl">{t("auth:login.createAccount")}</CardTitle>
          <CardDescription>{t("auth:login.createDescription")}</CardDescription>
        </>
      )}
    </CardHeader>
  );
}

/** A signed-in person opening an invite link: accept it for this account (any e-mail). */
function AcceptInviteCard({
  lang,
  token,
  ownerName,
  target,
}: {
  lang: string;
  token: string;
  ownerName: string;
  /** What the invite shares: a pool's callable id or a runtime definition's name. */
  target: { kind: "pool" | "runtime"; name: string } | null;
}) {
  const { t } = useTranslation(["auth"]);
  const queryClient = useQueryClient();
  const acceptInvite = useMutation({
    ...orpc.auth.acceptInvite.mutationOptions(),
    // A new share changes pools, models and which aliases hide a pool (the Overview warning).
    onSuccess: () => queryClient.invalidateQueries(),
    onError: (error) => {
      toast.error(friendly(error, t("auth:invite.acceptFailed")));
    },
  });
  const result = acceptInvite.data?.result;
  const runtime = target?.kind === "runtime";
  const name = target?.name ?? "";

  if (result === "accepted") {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t("auth:invite.acceptedTitle")}</CardTitle>
          <CardDescription className="break-words">
            {runtime
              ? t("auth:invite.runtimeAcceptedDescription", { name })
              : t("auth:invite.acceptedDescription", { callableId: name })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            to="/$lang/overview"
            params={{ lang }}
            className={cn(buttonVariants(), "min-h-[44px] w-full")}
          >
            {t("auth:invite.goToOverview")}
          </Link>
        </CardContent>
      </Card>
    );
  }

  const refusal =
    result === "own"
      ? t("auth:invite.own")
      : result === "invalid"
        ? t("auth:invite.invalidDescription")
        : null;

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">
          {result === "invalid" ? t("auth:invite.invalidTitle") : t("auth:invite.title")}
        </CardTitle>
        <CardDescription className="break-words">
          {refusal ??
            (result === "in_use"
              ? t("auth:invite.inUse")
              : runtime
                ? t("auth:invite.runtimeSignedInDescription", { ownerName, name })
                : t("auth:invite.signedInDescription", { ownerName, callableId: name }))}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {refusal ? (
          <Link
            to="/$lang/overview"
            params={{ lang }}
            className={cn(buttonVariants(), "min-h-[44px] w-full")}
          >
            {t("auth:invite.goToOverview")}
          </Link>
        ) : (
          <Button
            className="min-h-[44px] w-full"
            disabled={acceptInvite.isPending}
            onClick={() => acceptInvite.mutate({ token })}
          >
            {acceptInvite.isPending ? t("auth:invite.accepting") : t("auth:invite.accept")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function SignUpForm({
  lang,
  redirectTo,
  emailEnabled,
  invite,
  onAccountCreatedNeedingVerification,
}: {
  lang: string;
  redirectTo: string;
  emailEnabled: boolean;
  /** A pending invite link: its token goes in a request header, its e-mail prefills the form. */
  invite: { token: string; email: string | null } | null;
  onAccountCreatedNeedingVerification: (email: string) => void;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation(["auth"]);

  const form = useForm({
    defaultValues: { name: "", slug: "", email: invite?.email ?? "", password: "" },
    onSubmit: async ({ value }) => {
      const result = await authClient.signUp.email({
        email: value.email,
        password: value.password,
        name: value.name,
        slug: value.slug.trim(),
        // The token travels in a header, never in a (logged) URL; the server lets an invite
        // sign-up through with open sign-up off and turns the invite into a share.
        ...(invite ? { fetchOptions: { headers: { [SHARE_INVITE_HEADER]: invite.token } } } : {}),
      });
      if (result.error) {
        console.error("[signup.signUp]", result.error);
        toast.error(
          result.error?.code === INVITE_IN_USE_CODE
            ? t("auth:invite.inUse")
            : result.error?.status === 409
              ? t("auth:errors.accountAlreadyRegistered")
              : friendly(result.error, t("auth:errors.couldNotCreateAccount")),
        );
        return;
      }
      toast.success(t("auth:accountCreatedSuccess"));
      // When email is configured, requireEmailVerification means signUp returns
      // no session — stay here and show the verify-email pending UI.
      if (emailEnabled) {
        onAccountCreatedNeedingVerification(value.email);
        return;
      }
      if (redirectTo === `/${lang}/overview`) {
        navigate({ to: "/$lang/overview", params: { lang } });
      } else {
        window.location.assign(redirectTo);
      }
    },
    validators: {
      // Validation messages come from the locale-aware Zod error map installed
      // in `@/i18n/zod`. Don't pass inline strings here — that would override
      // the global map and leak hardcoded English copy into es-MX UIs.
      onSubmit: z.object({
        name: z.string().min(2),
        slug: z
          .string()
          .trim()
          .superRefine((value, ctx) => {
            const result = validateForwarderSlug(value);
            if (!result.ok) {
              ctx.addIssue({
                code: "custom",
                message:
                  result.reason === "reserved"
                    ? t("auth:errors.reservedSlug")
                    : t("auth:errors.invalidSlug"),
              });
            }
          }),
        email: z.email(),
        password: z.string().min(8),
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
      <form.Field name="name">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{t("auth:fields.name")}</Label>
            <Input
              id={field.name}
              name={field.name}
              autoComplete="name"
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

      <form.Field name="slug">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{t("auth:fields.slug")}</Label>
            <Input
              id={field.name}
              name={field.name}
              inputMode="text"
              autoComplete="username"
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
              autoComplete="new-password"
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
            {isSubmitting ? t("auth:login.creatingAccount") : t("auth:login.signUp")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
