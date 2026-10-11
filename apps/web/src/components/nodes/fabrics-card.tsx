import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
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
import { Network } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { Help } from "@/components/help";
import { InlineRetry } from "@/components/inline-retry";
import { orpc } from "@/utils/orpc";
import { FieldError } from "./field-error";
import type { FabricView } from "./node-types";
import { refusalToastOptions } from "./refusal";

export const FABRIC_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

/** Fabrics (fast links between nodes) with rename and delete; membership is set per node. */
export function FabricsCard({ lang }: { lang: string }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const fabrics = useQuery(orpc.nodes.fabrics.list.queryOptions());
  const [renaming, setRenaming] = useState<FabricView | null>(null);
  const [deleting, setDeleting] = useState<FabricView | null>(null);
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: orpc.nodes.key() });
  };
  const remove = useMutation({
    ...orpc.nodes.fabrics.delete.mutationOptions({
      onSuccess: () => {
        toast.success(t("dashboard:nodes.fabrics.deleted"));
        setDeleting(null);
        invalidate();
      },
    }),
    ...refusalToastOptions(t),
  });

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Network aria-hidden="true" className="size-4 text-muted-foreground" />
          {t("dashboard:nodes.fabrics.title")}
          <Help>{t("dashboard:nodes.fabrics.help")}</Help>
        </CardTitle>
        <CardDescription>{t("dashboard:nodes.fabrics.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {fabrics.isPending ? (
          <Skeleton aria-hidden="true" className="h-12 w-full" />
        ) : fabrics.isError ? (
          <InlineRetry onRetry={() => fabrics.refetch()} />
        ) : fabrics.data.fabrics.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard:nodes.fabrics.empty")}</p>
        ) : (
          <ul className="divide-y">
            {fabrics.data.fabrics.map((fabric) => (
              <li key={fabric.id} className="flex min-w-0 flex-wrap items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm">{fabric.name}</p>
                  <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    {fabric.members.map((member) => (
                      <Link
                        key={member.nodeId}
                        to="/$lang/nodes/$nodeId"
                        params={{ lang, nodeId: member.nodeId }}
                        className="inline-flex min-h-[44px] items-center hover:underline"
                      >
                        {member.slug} ({member.ip})
                      </Link>
                    ))}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  className="min-h-[44px]"
                  onClick={() => setRenaming(fabric)}
                >
                  {t("dashboard:nodes.fabrics.rename")}
                </Button>
                <Button
                  variant="ghost"
                  className="min-h-[44px] text-destructive"
                  onClick={() => setDeleting(fabric)}
                >
                  {t("common:actions.delete")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <RenameFabricDialog fabric={renaming} onClose={() => setRenaming(null)} onDone={invalidate} />
      <ConfirmDeleteDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t("dashboard:nodes.fabrics.deleteTitle")}
        description={t("dashboard:nodes.fabrics.deleteDescription")}
        confirmToken={deleting?.name ?? ""}
        typePrompt={t("dashboard:nodes.fabrics.typeName")}
        copyAriaLabel={t("dashboard:nodes.copy")}
        isPending={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate({ fabricId: deleting.id });
        }}
      />
    </Card>
  );
}

function RenameFabricDialog({
  fabric,
  onClose,
  onDone,
}: {
  fabric: FabricView | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <Dialog
      open={fabric !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dashboard:nodes.fabrics.renameTitle")}</DialogTitle>
          <DialogDescription>{t("dashboard:nodes.fabrics.renameDescription")}</DialogDescription>
        </DialogHeader>
        {fabric ? (
          <RenameFabricForm key={fabric.id} fabric={fabric} onClose={onClose} onDone={onDone} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameFabricForm({
  fabric,
  onClose,
  onDone,
}: {
  fabric: FabricView;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const rename = useMutation({
    ...orpc.nodes.fabrics.rename.mutationOptions({
      onSuccess: () => {
        toast.success(t("dashboard:nodes.fabrics.renamed"));
        onDone();
        onClose();
      },
    }),
    ...refusalToastOptions(t),
  });
  const form = useForm({
    defaultValues: { name: fabric.name },
    validators: {
      onChange: z.object({
        name: z.string().regex(FABRIC_NAME_PATTERN, t("dashboard:nodes.fabrics.nameInvalid")),
      }),
    },
    onSubmit: async ({ value }) => {
      await rename.mutateAsync({ fabricId: fabric.id, name: value.name });
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
            <Label htmlFor="fabric-name">{t("dashboard:nodes.fabrics.name")}</Label>
            <Input
              id="fabric-name"
              className="min-h-[44px] font-mono"
              autoCapitalize="none"
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
