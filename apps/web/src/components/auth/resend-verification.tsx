import { useForm } from "@tanstack/react-form";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { authClient } from "@/lib/auth-client";
import { friendly, isRateLimit } from "@/utils/friendly-error";

/**
 * Request a fresh email-verification link.
 *
 * Two shapes, one behaviour:
 *   • `email` given (we just created the account) → a single resend button.
 *   • `email` omitted (the user arrived on an expired link) → an email field.
 *
 * Better-Auth's `/send-verification-email` is enumeration-safe for anonymous
 * callers. Only rate limiting is surfaced; every other failure falls through
 * to the same neutral confirmation.
 */
export function ResendVerification({ email }: { email?: string }) {
  const { t } = useTranslation(["auth"]);
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <p className="text-center text-sm text-muted-foreground">{t("auth:verifyEmail.resent")}</p>
    );
  }

  return email ? (
    <ResendButton email={email} onSent={() => setSent(true)} />
  ) : (
    <ResendForm onSent={() => setSent(true)} />
  );
}

async function resend(email: string): Promise<boolean> {
  const result = await authClient.sendVerificationEmail({ email });
  if (result.error) {
    if (isRateLimit(result.error)) {
      toast.error(friendly(result.error));
      return false;
    }
    console.error("[resend-verification.send]", result.error);
  }
  return true;
}

function ResendButton({ email, onSent }: { email: string; onSent: () => void }) {
  const { t } = useTranslation(["auth"]);
  const [sending, setSending] = useState(false);

  const handleClick = async () => {
    setSending(true);
    try {
      if (await resend(email)) onSent();
    } finally {
      setSending(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      className="min-h-[44px] w-full"
      disabled={sending}
      onClick={handleClick}
    >
      {sending ? t("auth:verifyEmail.resending") : t("auth:verifyEmail.resend")}
    </Button>
  );
}

function ResendForm({ onSent }: { onSent: () => void }) {
  const { t } = useTranslation(["auth"]);

  const form = useForm({
    defaultValues: { email: "" },
    onSubmit: async ({ value }) => {
      if (await resend(value.email)) onSent();
    },
    validators: {
      onSubmit: z.object({
        email: z.email(),
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

      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <Button
            type="submit"
            className="min-h-[44px] w-full"
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? t("auth:verifyEmail.resending") : t("auth:verifyEmail.resend")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
