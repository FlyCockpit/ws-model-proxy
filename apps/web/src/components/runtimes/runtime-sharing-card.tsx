import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import {
  announceShared,
  type InviteLink,
  InviteLinkDialog,
  RuntimeShareRow,
  useInvalidateShares,
} from "@/components/access/pool-shares";
import { FieldErrors } from "@/components/field-errors";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

/**
 * Share this runtime's definition (read-only, every version) with people, who can fork it to
 * their own nodes. Sharing is for people only: the procedures refuse agents.
 */
export function RuntimeSharingCard({
  lang,
  runtime,
}: {
  lang: string;
  runtime: { id: string; name: string; shares: Array<{ id: string; email: string }> };
}) {
  const { t } = useTranslation(["dashboard", "access"]);
  const invalidate = useInvalidateShares();
  const [inviteLink, setInviteLink] = useState<InviteLink | null>(null);
  const create = useMutation({
    ...orpc.runtimes.shares.create.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const form = useForm({
    defaultValues: { email: "" },
    validators: {
      onSubmit: z.object({
        email: z
          .string()
          .trim()
          .toLowerCase()
          .email(t("dashboard:runtime.sharing.emailInvalid"))
          .max(320),
      }),
    },
    onSubmit: async ({ value, formApi }) => {
      const email = value.email.trim().toLowerCase();
      try {
        const result = await create.mutateAsync({ runtimeId: runtime.id, email });
        await invalidate();
        formApi.reset();
        announceShared(result, email, t, setInviteLink);
      } catch (error) {
        toast.error(refusalText(error));
      }
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:runtime.sharing.title")}</CardTitle>
        <CardDescription>{t("dashboard:runtime.sharing.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {runtime.shares.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard:runtime.sharing.none")}</p>
        ) : (
          <div className="flex min-w-0 flex-col divide-y">
            {runtime.shares.map((share) => (
              <RuntimeShareRow
                key={share.id}
                share={{ ...share, runtimeId: runtime.id }}
                name={runtime.name}
              />
            ))}
          </div>
        )}
        <form
          className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit();
          }}
        >
          <form.Field name="email">
            {(field) => (
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor="runtime-share-email">{t("dashboard:runtime.sharing.email")}</Label>
                <Input
                  id="runtime-share-email"
                  type="email"
                  autoComplete="off"
                  className="h-11"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldErrors field={field} />
              </div>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(submitting) => (
              <Button type="submit" size="touch" className="sm:mt-6" disabled={submitting}>
                {t("dashboard:runtime.sharing.share")}
              </Button>
            )}
          </form.Subscribe>
        </form>
        <Link
          to="/$lang/access/shares"
          params={{ lang }}
          className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
        >
          {t("dashboard:runtime.sharing.invitesLink")}
        </Link>
      </CardContent>
      <InviteLinkDialog value={inviteLink} onClose={() => setInviteLink(null)} />
    </Card>
  );
}
