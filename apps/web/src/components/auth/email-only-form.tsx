import { useForm } from "@tanstack/react-form";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { useTranslation } from "react-i18next";
import z from "zod";

/**
 * A form with one email field and a submit button (resend verification, forgot password).
 * The caller decides what a submit does and labels the button.
 */
export function EmailOnlyForm({
  onSubmit,
  submitLabel,
  submittingLabel,
}: {
  onSubmit: (email: string) => Promise<void>;
  submitLabel: string;
  submittingLabel: string;
}) {
  const { t } = useTranslation(["auth"]);

  const form = useForm({
    defaultValues: { email: "" },
    onSubmit: async ({ value }) => {
      await onSubmit(value.email);
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
            {isSubmitting ? submittingLabel : submitLabel}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
