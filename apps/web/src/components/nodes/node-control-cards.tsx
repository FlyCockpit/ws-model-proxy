import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { TimeAgo } from "@/components/time-ago";
import { orpc } from "@/utils/orpc";

import { CommandBlock, StatusPill, TrustBadge } from "./node-badges";
import type { LowerTrustPreview, NodeDetail } from "./node-types";
import { refusalToastOptions } from "./refusal";

function useInvalidateNodes() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.nodes.key() });
}

/** Trust: what the server may do here, and the Lower dialog. */
export function TrustCard({ node }: { node: NodeDetail }) {
  const { t } = useTranslation(["dashboard"]);
  const [lowering, setLowering] = useState(false);
  const full = node.trust.effective === "FULL";
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {t("dashboard:nodes.trustCard.title")}
          <TrustBadge trust={node.trust} />
        </CardTitle>
        <CardDescription>
          {full
            ? t("dashboard:nodes.trustCard.fullDescription")
            : t("dashboard:nodes.trustCard.relayDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {node.trust.changedAt ? (
          <p className="text-xs text-muted-foreground">
            {t("dashboard:nodes.trustCard.changed")} <TimeAgo value={node.trust.changedAt} />
          </p>
        ) : null}
        {full ? (
          <Button variant="outline" className="min-h-[44px]" onClick={() => setLowering(true)}>
            <ShieldAlert aria-hidden="true" />
            {t("dashboard:nodes.trustCard.lower")}
          </Button>
        ) : (
          <div className="space-y-1.5">
            <p className="text-sm">{t("dashboard:nodes.trustCard.raiseHint")}</p>
            <CommandBlock command="wsmp trust full" />
          </div>
        )}
      </CardContent>
      <LowerTrustDialog node={node} open={lowering} onOpenChange={setLowering} />
    </Card>
  );
}

function LowerTrustDialog({
  node,
  open,
  onOpenChange,
}: {
  node: NodeDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidateNodes();
  const preview = useQuery({
    ...orpc.nodes.lowerTrustPreview.queryOptions({ input: { nodeId: node.id } }),
    enabled: open,
  });
  const lower = useMutation({
    ...orpc.nodes.lowerTrust.mutationOptions({
      onSuccess: () => {
        toast.success(t("dashboard:nodes.trustCard.lowered"));
        invalidate();
        onOpenChange(false);
      },
    }),
    ...refusalToastOptions(t),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-x-hidden overflow-y-auto overscroll-contain sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("dashboard:nodes.trustCard.lowerTitle", { slug: node.slug })}
          </DialogTitle>
          <DialogDescription>{t("dashboard:nodes.trustCard.lowerDescription")}</DialogDescription>
        </DialogHeader>
        {preview.isPending ? (
          <div aria-hidden="true" className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : preview.isError ? (
          <InlineRetry onRetry={() => preview.refetch()} />
        ) : (
          <LowerTrustSummary preview={preview.data} />
        )}
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
            variant="destructive"
            className="min-h-[44px]"
            disabled={!preview.isSuccess || lower.isPending}
            onClick={() => lower.mutate({ nodeId: node.id })}
          >
            {t("dashboard:nodes.trustCard.lowerConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LowerTrustSummary({ preview }: { preview: LowerTrustPreview }) {
  const { t } = useTranslation(["dashboard"]);
  const agentFlag = (
    <StatusPill tone="warning">{t("dashboard:nodes.trustCard.agentWritten")}</StatusPill>
  );
  return (
    <div className="min-w-0 space-y-3 text-sm">
      <section className="space-y-1">
        <h3 className="font-medium">{t("dashboard:nodes.trustCard.keepsRunning")}</h3>
        {preview.frozenRuntimes.length === 0 && preview.frozenMetricCommands.length === 0 ? (
          <p className="text-muted-foreground">{t("dashboard:nodes.trustCard.nothingFrozen")}</p>
        ) : (
          <ul className="space-y-1">
            {preview.frozenRuntimes.map((runtime) => (
              <li key={runtime.versionId} className="flex flex-wrap items-center gap-2">
                <span>{runtime.name}</span>
                {runtime.running ? (
                  <StatusPill tone="success">{t("dashboard:nodes.trustCard.running")}</StatusPill>
                ) : null}
                {runtime.agentWritten ? agentFlag : null}
              </li>
            ))}
            {preview.frozenMetricCommands.map((command) => (
              <li key={command.name} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{command.name}</span>
                {command.agentWritten ? agentFlag : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {preview.frozenFabrics.length > 0 ? (
        <section className="space-y-1">
          <h3 className="font-medium">{t("dashboard:nodes.trustCard.fabricsFreeze")}</h3>
          <p className="text-muted-foreground">
            {preview.frozenFabrics.map((fabric) => `${fabric.name} (${fabric.ip})`).join(", ")}
          </p>
        </section>
      ) : null}
      {preview.secretNames.length > 0 ? (
        <section className="space-y-1">
          <h3 className="font-medium">{t("dashboard:nodes.trustCard.secrets")}</h3>
          <p className="font-mono text-xs text-muted-foreground">
            {preview.secretNames.join(", ")}
          </p>
        </section>
      ) : null}
      <section className="space-y-1">
        <h3 className="font-medium">{t("dashboard:nodes.trustCard.stops")}</h3>
        <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
          <li>{t("dashboard:nodes.trustCard.stopsList")}</li>
          {preview.runningCommands > 0 ? (
            <li className="font-medium text-foreground">
              {t("dashboard:nodes.trustCard.commandsKilled", { count: preview.runningCommands })}
            </li>
          ) : null}
          {preview.openBrowserTerminals > 0 ? (
            <li>
              {t("dashboard:nodes.trustCard.terminalsClose", {
                count: preview.openBrowserTerminals,
              })}
            </li>
          ) : null}
          {preview.queuedCommandsRefused > 0 ? (
            <li>
              {t("dashboard:nodes.trustCard.queuedRefused", {
                count: preview.queuedCommandsRefused,
              })}
            </li>
          ) : null}
        </ul>
      </section>
      <p className="text-xs text-muted-foreground">{t("dashboard:nodes.trustCard.sticky")}</p>
    </div>
  );
}

/** Hold: nothing is placed on the node, for anyone, until released. */
export function HoldCard({ node }: { node: NodeDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidateNodes();
  const [note, setNote] = useState("");
  const setHold = useMutation({
    ...orpc.nodes.setHold.mutationOptions({
      onSuccess: (summary) => {
        toast.success(
          summary.hold ? t("dashboard:nodes.hold.held") : t("dashboard:nodes.hold.released"),
        );
        setNote("");
        invalidate();
      },
    }),
    ...refusalToastOptions(t),
  });
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:nodes.hold.title")}</CardTitle>
        <CardDescription>{t("dashboard:nodes.hold.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {node.hold ? (
          <div className="space-y-2 text-sm">
            <p>
              {node.hold.profileId
                ? t("dashboard:nodes.hold.heldByProfile")
                : t("dashboard:nodes.hold.heldByPerson")}{" "}
              <TimeAgo value={node.hold.at} />
            </p>
            {node.hold.note ? <p className="text-muted-foreground">“{node.hold.note}”</p> : null}
            <Button
              variant="outline"
              className="min-h-[44px]"
              disabled={setHold.isPending}
              onClick={() => setHold.mutate({ nodeId: node.id, hold: false })}
            >
              {t("dashboard:nodes.hold.release")}
            </Button>
          </div>
        ) : (
          <form
            className="flex min-w-0 flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = note.trim();
              setHold.mutate({
                nodeId: node.id,
                hold: true,
                ...(trimmed ? { note: trimmed.slice(0, 500) } : {}),
              });
            }}
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="hold-note">{t("dashboard:nodes.hold.note")}</Label>
              <Input
                id="hold-note"
                className="min-h-[44px]"
                maxLength={500}
                placeholder={t("dashboard:nodes.hold.notePlaceholder")}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <Button type="submit" className="min-h-[44px]" disabled={setHold.isPending}>
              {t("dashboard:nodes.hold.hold")}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

const HOUR_MS = 3_600_000;

/** Temporary: deleted (releasing everything) after being offline this long. */
export function TemporaryCard({ node }: { node: NodeDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidateNodes();
  const [hours, setHours] = useState(() =>
    node.removeAfterOfflineMs === null ? "1" : String(node.removeAfterOfflineMs / HOUR_MS),
  );
  const save = useMutation({
    ...orpc.nodes.setTemporary.mutationOptions({
      onSuccess: () => {
        toast.success(t("dashboard:nodes.temporary.saved"));
        invalidate();
      },
    }),
    ...refusalToastOptions(t),
  });
  const parsedHours = Number(hours);
  const validHours = parsedHours >= 1 / 60 && parsedHours <= 720;
  const temporary = node.removeAfterOfflineMs !== null;
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:nodes.temporary.title")}</CardTitle>
        <CardDescription>{t("dashboard:nodes.temporary.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex min-h-[44px] items-center justify-between gap-3">
          <span className="text-sm font-medium">{t("dashboard:nodes.temporary.toggle")}</span>
          <Switch
            checked={temporary}
            disabled={save.isPending || (!temporary && !validHours)}
            onCheckedChange={(checked) =>
              save.mutate({
                nodeId: node.id,
                removeAfterOfflineMs: checked
                  ? Math.max(60_000, Math.round(parsedHours * HOUR_MS))
                  : null,
              })
            }
          />
        </label>
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="temporary-hours">{t("dashboard:nodes.temporary.hours")}</Label>
            <Input
              id="temporary-hours"
              inputMode="decimal"
              className="min-h-[44px]"
              value={hours}
              aria-invalid={!validHours}
              onChange={(event) => setHours(event.target.value)}
            />
          </div>
          {temporary ? (
            <Button
              variant="outline"
              className="min-h-[44px]"
              disabled={!validHours || save.isPending}
              onClick={() =>
                save.mutate({
                  nodeId: node.id,
                  removeAfterOfflineMs: Math.max(60_000, Math.round(parsedHours * HOUR_MS)),
                })
              }
            >
              {t("common:actions.save")}
            </Button>
          ) : null}
        </div>
        {!validHours ? (
          <p className="text-sm text-destructive">{t("dashboard:nodes.add.offlineHoursInvalid")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
