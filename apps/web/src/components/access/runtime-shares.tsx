import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmAction } from "@/components/access/confirm-action";
import { SecretReveal } from "@/components/access/secret-reveal";
import { orpc } from "@/utils/orpc";

/** An invite link shown once (no e-mail could be sent). */
export type InviteLink = { email: string; link: string; expiresAt: string };

/** Shares and invites show on Access · Shares and on a runtime's page. */
export function useInvalidateShares() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.access.shares.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.runtimes.shares.list.key() }),
      // A runtime's page lists its shares too.
      queryClient.invalidateQueries({ queryKey: orpc.runtimes.get.key() }),
    ]);
}

/** One person a runtime definition is shared with, with stop sharing. */
export function RuntimeShareRow({
  share,
  name,
}: {
  share: { id: string; runtimeId: string; email: string };
  name: string;
}) {
  const { t } = useTranslation(["access"]);
  const invalidate = useInvalidateShares();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const remove = useMutation(
    orpc.runtimes.shares.delete.mutationOptions({
      onSuccess: async () => {
        setConfirmOpen(false);
        toast.success(t("access:shares.removed"));
        await invalidate();
      },
    }),
  );
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate font-medium">{share.email}</p>
        <p className="truncate text-xs text-muted-foreground">
          {t("access:shares.runtimeTarget", { name })}
        </p>
      </div>
      <Button type="button" variant="outline" size="touch" onClick={() => setConfirmOpen(true)}>
        {t("access:shares.remove")}
      </Button>
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("access:shares.removeRuntimeTitle", { runtime: name, email: share.email })}
        description={t("access:shares.removeRuntimeDescription")}
        confirmLabel={t("access:shares.remove")}
        isPending={remove.isPending}
        onConfirm={() => remove.mutate({ shareId: share.id })}
      />
    </div>
  );
}

/** The invite link of an invite no e-mail went out for, shown once. */
export function InviteLinkDialog({
  value,
  onClose,
}: {
  value: InviteLink | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation(["access"]);
  return (
    <ResponsiveDialog
      open={value !== null}
      onOpenChange={(next) => (next ? undefined : onClose())}
      title={t("access:shares.inviteLinkTitle")}
    >
      {value ? (
        <SecretReveal
          value={value.link}
          title={t("access:shares.inviteLinkTitle")}
          description={t("access:shares.inviteLinkDescription", {
            email: value.email,
            date: new Date(value.expiresAt).toLocaleDateString(i18n.language, {
              dateStyle: "medium",
            }),
          })}
          copyLabel={t("access:shares.copyInviteLink")}
          onDone={onClose}
        />
      ) : null}
    </ResponsiveDialog>
  );
}
