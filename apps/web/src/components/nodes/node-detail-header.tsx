import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ws-model-proxy/ui/components/dialog";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Pencil, RefreshCcw, Trash } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { TimeAgo } from "@/components/time-ago";
import { orpc } from "@/utils/orpc";

import { AddNodeDialog } from "./add-node-dialog";
import { FieldError } from "./field-error";
import { ConnectionBadge, NodeFlags, TrustBadge } from "./node-badges";
import type { NodeDetail } from "./node-types";
import { refusalToastOptions } from "./refusal";

export function NodeDetailHeader({ node, lang }: { node: NodeDetail; lang: string }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const [renaming, setRenaming] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const remove = useMutation({
    ...orpc.nodes.delete.mutationOptions({
      onSuccess: (result) => {
        toast.success(
          t("dashboard:nodes.detail.deleted", { count: result.stoppedInstances.length }),
        );
        queryClient.invalidateQueries({ queryKey: orpc.nodes.key() });
        navigate({ to: "/$lang/nodes", params: { lang } });
      },
    }),
    ...refusalToastOptions(t),
  });

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="flex min-w-0 items-center gap-2 text-2xl font-semibold">
            <span className="truncate">{node.name ?? node.slug}</span>
            <Button
              variant="ghost"
              size="icon-touch"
              aria-label={t("dashboard:nodes.detail.rename")}
              onClick={() => setRenaming(true)}
            >
              <Pencil aria-hidden="true" />
            </Button>
          </h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{node.slug}</span>
            {node.hostname ? ` · ${node.hostname}` : null}
            {node.version ? ` · wsmp ${node.version}` : null}
            {" · "}
            {t("dashboard:nodes.card.lastSeen")} <TimeAgo value={node.lastHeartbeatAt} />
          </p>
          <div className="flex flex-wrap gap-1.5">
            <ConnectionBadge connection={node.connection} />
            <TrustBadge trust={node.trust} />
            <NodeFlags node={node} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="min-h-[44px]" onClick={() => setReplacing(true)}>
            <RefreshCcw aria-hidden="true" />
            {t("dashboard:nodes.detail.replace")}
          </Button>
          <Button
            variant="outline"
            className="min-h-[44px] text-destructive"
            onClick={() => setDeleting(true)}
          >
            <Trash aria-hidden="true" />
            {t("common:actions.delete")}
          </Button>
        </div>
      </div>

      <RenameNodeDialog node={node} open={renaming} onOpenChange={setRenaming} />
      <AddNodeDialog
        open={replacing}
        onOpenChange={setReplacing}
        lang={lang}
        replace={{ nodeId: node.id, slug: node.slug }}
      />
      <ConfirmDeleteDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("dashboard:nodes.detail.deleteTitle")}
        description={t("dashboard:nodes.detail.deleteDescription")}
        confirmToken={node.slug}
        typePrompt={t("dashboard:nodes.detail.typeSlug")}
        copyAriaLabel={t("dashboard:nodes.copy")}
        isPending={remove.isPending}
        onConfirm={() => remove.mutate({ nodeId: node.id })}
      />
    </div>
  );
}

function RenameNodeDialog({
  node,
  open,
  onOpenChange,
}: {
  node: NodeDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dashboard:nodes.detail.renameTitle")}</DialogTitle>
          <DialogDescription>{t("dashboard:nodes.detail.renameDescription")}</DialogDescription>
        </DialogHeader>
        {open ? <RenameNodeForm node={node} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameNodeForm({ node, onClose }: { node: NodeDetail; onClose: () => void }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const rename = useMutation({
    ...orpc.nodes.rename.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.nodes.key() });
        onClose();
      },
    }),
    ...refusalToastOptions(t),
  });
  const form = useForm({
    defaultValues: { name: node.name ?? "" },
    validators: {
      onChange: z.object({
        name: z.string().max(120, t("dashboard:nodes.detail.nameTooLong")),
      }),
    },
    onSubmit: async ({ value }) => {
      const name = value.name.trim();
      await rename.mutateAsync({ nodeId: node.id, name: name === "" ? null : name });
    },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit().catch(() => undefined);
      }}
    >
      <form.Field name="name">
        {(field) => (
          <div className="space-y-1.5">
            <Label htmlFor="node-name">{t("dashboard:nodes.detail.name")}</Label>
            <Input
              id="node-name"
              className="min-h-[44px]"
              placeholder={node.slug}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            <FieldError errors={field.state.meta.errors} />
          </div>
        )}
      </form.Field>
      <DialogFooter>
        <Button type="button" variant="ghost" className="min-h-[44px]" onClick={onClose}>
          {t("common:actions.cancel")}
        </Button>
        <Button type="submit" className="min-h-[44px]" disabled={rename.isPending}>
          {t("common:actions.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function NodeDetailSkeleton() {
  return (
    <div aria-hidden="true" className="flex min-w-0 flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-20" />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}
