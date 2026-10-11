import { useForm } from "@tanstack/react-form";
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
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { authClient } from "@/lib/auth-client";
import { stripResetTokenFromAddressBar } from "@/lib/reset-password-search";
import { friendly, isRateLimit } from "@/utils/friendly-error";

/** Same policy as the server (`emailAndPassword.minPasswordLength`, Better Auth's max). */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

const REJECTED_TOKEN_CODES = new Set(["INVALID_TOKEN", "USER_NOT_FOUND"]);

function stripTokenRef(element: HTMLDivElement | null): void {
  if (element) stripResetTokenFromAddressBar();
}

/**
 * The reset-password page body (`/$lang/reset-password`).
 *
 * The token is captured into state on the first render, BEFORE the address bar is cleaned: the
 * router patches `history.replaceState` and re-reads the search, so after the clean-up the
 * route's `token` is gone. The captured value is what the form submits.
 */
export function ResetPasswordCard({
  lang,
  token: searchToken,
  error,
}: {
  lang: string;
  token: string | undefined;
  error: string | undefined;
}) {
  const { t } = useTranslation(["auth"]);
  const [token] = useState(searchToken);
  const [tokenRejected, setTokenRejected] = useState(false);

  const backToLogin = (
    <div className="text-center">
      <Link
        to="/$lang/login"
        params={{ lang }}
        search={{ redirectTo: undefined }}
        className={cn(buttonVariants({ variant: "link" }), "min-h-[44px]")}
      >
        {t("auth:resetPassword.backToLogin")}
      </Link>
    </div>
  );

  if (error || !token || tokenRejected) {
    return (
      <div ref={stripTokenRef} className="contents">
        <AuthCard
          title={t("auth:resetPassword.invalidTitle")}
          description={t("auth:resetPassword.invalidDescription")}
        >
          <Link
            to="/$lang/forgot-password"
            params={{ lang }}
            className={cn(buttonVariants(), "min-h-[44px] w-full")}
          >
            {t("auth:resetPassword.requestNew")}
          </Link>
          {backToLogin}
        </AuthCard>
      </div>
    );
  }

  return (
    <div ref={stripTokenRef} className="contents">
      <AuthCard
        title={t("auth:resetPassword.title")}
        description={t("auth:resetPassword.description")}
      >
        <ResetPasswordForm
          lang={lang}
          token={token}
          onTokenRejected={() => setTokenRejected(true)}
        />
        {backToLogin}
      </AuthCard>
    </div>
  );
}

function ResetPasswordForm({
  lang,
  token,
  onTokenRejected,
}: {
  lang: string;
  token: string;
  onTokenRejected: () => void;
}) {
  const { t } = useTranslation(["auth"]);
  const navigate = useNavigate();

  const form = useForm({
    defaultValues: { password: "", confirmPassword: "" },
    onSubmit: async ({ value }) => {
      const result = await authClient.resetPassword({ newPassword: value.password, token });
      if (result.error) {
        if (typeof result.error.code === "string" && REJECTED_TOKEN_CODES.has(result.error.code)) {
          onTokenRejected();
          return;
        }
        console.error("[reset-password.submit]", result.error);
        toast.error(
          isRateLimit(result.error) ? friendly(result.error) : t("auth:resetPassword.failed"),
        );
        return;
      }
      toast.success(t("auth:resetPassword.success"));
      navigate({ to: "/$lang/login", params: { lang }, search: { redirectTo: undefined } });
    },
    validators: {
      // Length messages come from the locale-aware Zod error map; the mismatch
      // message is this page's own localized string.
      onSubmit: z
        .object({
          password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
          confirmPassword: z.string(),
        })
        .refine((value) => value.password === value.confirmPassword, {
          path: ["confirmPassword"],
          message: t("auth:resetPassword.mismatch"),
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
      <form.Field name="password">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{t("auth:resetPassword.newPassword")}</Label>
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

      <form.Field name="confirmPassword">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{t("auth:resetPassword.confirmPassword")}</Label>
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
            {isSubmitting ? t("auth:resetPassword.submitting") : t("auth:resetPassword.submit")}
          </Button>
        )}
      </form.Subscribe>
    </form>
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
