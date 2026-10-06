import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { validateForwarderSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import { SHARE_INVITE_HEADER } from "@ws-model-proxy/config/share-invite";
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
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";
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

  const postAuthRedirect = safeRedirectTo(redirectTo, lang);
  const emailEnabled = config.data?.emailEnabled === true;
  const canResend = emailEnabled;
  const validInvite =
    invite !== undefined && inviteInfo.data?.valid === true ? inviteInfo.data : null;
  // "Sign in" on an invite link comes back here to accept it.
  const signInRedirect = invite && validInvite ? inviteSignupPath(lang, invite) : redirectTo;

  if (pendingEmail) {
    return (
      <Frame>
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">
              {canResend ? t("auth:verifyEmail.sentTitle") : t("auth:verifyEmail.pendingTitle")}
            </CardTitle>
            <CardDescription>
              {canResend
                ? t("auth:verifyEmail.sentDescription", { email: pendingEmail })
                : t("auth:verifyEmail.accountCreatedNoEmail", { email: pendingEmail })}
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
              <ResendVerification email={pendingEmail} />
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

  if (state.status === "pending" || config.isPending || (invite && inviteInfo.isPending)) {
    return (
      <Frame>
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
      </Frame>
    );
  }

  if (config.isError) {
    return (
      <Frame>
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
      </Frame>
    );
  }

  if (invite && inviteInfo.isError) {
    return (
      <Frame>
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">{t("auth:invite.checkFailedTitle")}</CardTitle>
            <CardDescription>{t("auth:invite.checkFailedDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="min-h-[44px] w-full" onClick={() => inviteInfo.refetch()}>
              {t("common:actions.retry")}
            </Button>
          </CardContent>
        </Card>
      </Frame>
    );
  }

  const signedIn = state.status === "authenticated";

  if (invite && !validInvite) {
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

  if (invite && validInvite && signedIn) {
    return (
      <Frame>
        <AcceptInviteCard
          lang={lang}
          token={invite}
          ownerName={validInvite.ownerName ?? ""}
          callableId={validInvite.callableId ?? ""}
        />
      </Frame>
    );
  }

  return (
    <Frame>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          {validInvite ? (
            <>
              <CardTitle className="text-2xl">{t("auth:invite.title")}</CardTitle>
              <CardDescription className="break-words">
                {t("auth:invite.description", {
                  ownerName: validInvite.ownerName ?? "",
                  callableId: validInvite.callableId ?? "",
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
        <CardContent className="space-y-4">
          <SignUpForm
            lang={lang}
            redirectTo={postAuthRedirect}
            emailEnabled={emailEnabled}
            invite={validInvite && invite ? { token: invite, email: validInvite.email } : null}
            onAccountCreatedNeedingVerification={setPendingEmail}
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

/** A signed-in person opening an invite link: accept it for this account (any e-mail). */
function AcceptInviteCard({
  lang,
  token,
  ownerName,
  callableId,
}: {
  lang: string;
  token: string;
  ownerName: string;
  callableId: string;
}) {
  const { t } = useTranslation(["auth"]);
  const acceptInvite = useMutation({
    ...orpc.auth.acceptInvite.mutationOptions(),
    onError: (error) => {
      toast.error(friendly(error, t("auth:invite.acceptFailed")));
    },
  });
  const result = acceptInvite.data?.result;

  if (result === "accepted") {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t("auth:invite.acceptedTitle")}</CardTitle>
          <CardDescription className="break-words">
            {t("auth:invite.acceptedDescription", { callableId })}
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
    result === "own_pool"
      ? t("auth:invite.ownPool")
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
          {refusal ?? t("auth:invite.signedInDescription", { ownerName, callableId })}
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
          result.error?.status === 409
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
