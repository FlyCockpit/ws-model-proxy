import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ws-model-proxy/ui/components/dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { StatusPill } from "@/components/nodes/node-badges";
import type { NodeSummary, ProfileView, StartPreview } from "@/components/nodes/node-types";
import { refusalMessage, refusalReasonOf } from "@/components/nodes/refusal";
import { orpc } from "@/utils/orpc";

/**
 * Apply → preview → Confirm (D13): the preview is fetched when the dialog opens and the
 * person confirms exactly it (its fingerprint). A stale preview is fetched again.
 */
export function ApplyProfileDialog({
  profile,
  open,
  onOpenChange,
}: {
  profile: ProfileView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions(), enabled: open });
  // A preview is a mutation procedure (it plans against live state); it is safe to repeat.
  const preview = useQuery({
    queryKey: ["profiles", "applyPreview", profile.id, profile.updatedAt],
    queryFn: async () => {
      const result = await orpc.profiles.apply.call({ profileId: profile.id, preview: true });
      if (result.mode !== "preview") throw new Error("Expected a preview.");
      return result.preview;
    },
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  const apply = useMutation({
    ...orpc.profiles.apply.mutationOptions({
      onSuccess: () => {
        toast.success(t("dashboard:profiles.apply.applied", { name: profile.name }));
        queryClient.invalidateQueries({ queryKey: orpc.profiles.key() });
        queryClient.invalidateQueries({ queryKey: orpc.nodes.key() });
        onOpenChange(false);
      },
      onError: (error) => {
        if (refusalReasonOf(error) === "preview_stale") preview.refetch();
        toast.error(refusalMessage(t, error));
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });

  const nodeById = new Map((nodes.data?.nodes ?? []).map((node) => [node.id, node]));
  const data = preview.data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-x-hidden overflow-y-auto overscroll-contain sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("dashboard:profiles.apply.title", { name: profile.name })}</DialogTitle>
          <DialogDescription>{t("dashboard:profiles.apply.description")}</DialogDescription>
        </DialogHeader>
        {preview.isPending ? (
          <div aria-hidden="true" className="space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : preview.isError ? (
          <InlineRetry
            message={refusalMessage(t, preview.error)}
            onRetry={() => preview.refetch()}
          />
        ) : data ? (
          <PreviewSummary preview={data} profile={profile} nodeById={nodeById} />
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            className="min-h-[44px]"
            onClick={() => onOpenChange(false)}
          >
            {t("common:actions.cancel")}
          </Button>
          <Button
            className="min-h-[44px]"
            disabled={!data || data.refusals.length > 0 || apply.isPending}
            onClick={() => {
              if (data) apply.mutate({ profileId: profile.id, fingerprint: data.fingerprint });
            }}
          >
            {apply.isPending
              ? t("dashboard:profiles.apply.applying")
              : t("dashboard:profiles.apply.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewSummary({
  preview,
  profile,
  nodeById,
}: {
  preview: StartPreview;
  profile: ProfileView;
  nodeById: ReadonlyMap<string, NodeSummary>;
}) {
  const { t } = useTranslation(["dashboard"]);
  const slug = (nodeId: string) => nodeById.get(nodeId)?.slug ?? nodeId;
  const runtimeSlug = (runtimeId: string) =>
    profile.items.find((item) => item.runtimeId === runtimeId)?.runtimeSlug ?? runtimeId;
  const holdLines = new Set(profile.holds.map((hold) => hold.nodeId));
  // The contract's preview has no hold list (contract gap): derived here from the profile and
  // the nodes' current holds, the same rule the server applies (planProfileHolds).
  const releases = profile.nodeIds.filter(
    (nodeId) => !holdLines.has(nodeId) && nodeById.get(nodeId)?.hold,
  );
  return (
    <div className="min-w-0 space-y-3 text-sm">
      {preview.refusals.length > 0 ? (
        <section className="space-y-1 rounded-md border border-destructive/40 p-2" role="alert">
          <h3 className="flex items-center gap-1.5 font-medium text-destructive">
            <CircleAlert aria-hidden="true" className="size-4" />
            {t("dashboard:profiles.apply.cannot")}
          </h3>
          <ul className="list-disc space-y-0.5 pl-5">
            {preview.refusals.map((refusal) => (
              <li key={`${refusal.reason}-${refusal.subjectId}`}>
                {t(`dashboard:refusals.${refusal.reason}`, { defaultValue: refusal.message })}
                {refusal.subjectId && nodeById.has(refusal.subjectId)
                  ? ` (${slug(refusal.subjectId)})`
                  : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="space-y-1">
        <h3 className="font-medium">{t("dashboard:profiles.apply.starts")}</h3>
        {preview.starts.length === 0 ? (
          <p className="text-muted-foreground">{t("dashboard:profiles.apply.nothingToStart")}</p>
        ) : (
          <ul className="space-y-0.5">
            {preview.starts.map((start, index) => (
              <li key={`${start.versionId}-${index}`}>
                <span className="font-medium">{runtimeSlug(start.runtimeId)}</span>{" "}
                <span className="text-muted-foreground">
                  →{" "}
                  {start.placements
                    .map((placement) => `${placement.nodeSlug}:${placement.port}`)
                    .join(", ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-1">
        <h3 className="font-medium">{t("dashboard:profiles.apply.stops")}</h3>
        {preview.stops.length === 0 ? (
          <p className="text-muted-foreground">{t("dashboard:profiles.apply.nothingToStop")}</p>
        ) : (
          <ul className="space-y-0.5">
            {preview.stops.map((stop) => (
              <li key={stop.instanceId} className="font-mono text-xs">
                {stop.runtimeId} · {stop.instanceId}
              </li>
            ))}
          </ul>
        )}
      </section>
      {preview.kept.length > 0 ? (
        <p className="text-muted-foreground">
          {t("dashboard:profiles.apply.kept", { count: preview.kept.length })}
        </p>
      ) : null}
      {profile.holds.length > 0 || releases.length > 0 ? (
        <section className="space-y-1">
          <h3 className="font-medium">{t("dashboard:profiles.apply.holds")}</h3>
          <ul className="space-y-0.5">
            {profile.holds.map((hold) => (
              <li key={hold.nodeId}>
                {t("dashboard:profiles.apply.holdsNode", { slug: slug(hold.nodeId) })}
              </li>
            ))}
            {releases.map((nodeId) => (
              <li key={nodeId}>
                {t("dashboard:profiles.apply.releasesNode", { slug: slug(nodeId) })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {preview.warnings.length > 0 ? (
        <section className="space-y-1">
          <h3 className="font-medium">{t("dashboard:profiles.apply.warnings")}</h3>
          <ul className="flex flex-wrap gap-1.5">
            {preview.warnings.map((warning) => (
              <li key={`${warning.code}-${warning.nodeId}-${warning.detail}`}>
                <StatusPill tone="warning">
                  {t(`dashboard:profiles.warning.${warning.code}`)}
                  {warning.nodeId ? ` · ${slug(warning.nodeId)}` : ""}
                </StatusPill>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
