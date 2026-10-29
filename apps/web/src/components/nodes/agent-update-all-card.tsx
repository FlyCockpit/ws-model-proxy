import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Label } from "@ws-model-proxy/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ws-model-proxy/ui/components/select";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { CircleStop, Download } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { useAgentUpdateOverview } from "@/hooks/use-agent-update-overview";
import {
  BATCH_STOP_REASONS,
  type BatchRowStatus,
  batchRows,
  forceOffered,
  knownOr,
} from "@/lib/agent-update";
import { orpc } from "@/utils/orpc";

import { StatusPill } from "./node-badges";
import type { AgentUpdateBatchView, AgentUpdateOverview, NodeAgentUpdateView } from "./node-types";
import { refusalToastOptions } from "./refusal";

const K = "dashboard:nodes.agentUpdate.all";
const AUTO = "auto";

/**
 * "Update all" (plan D7): a canary first, then the rest one at a time, stopping at the first
 * failure. Shown only when some node needs a newer wsmp or a batch exists.
 */
export function AgentUpdateAllCard() {
  const { t } = useTranslation(["dashboard"]);
  const overview = useAgentUpdateOverview();
  // The card shows only when there is something to update, so no placeholder while loading:
  // a skeleton that then disappears would shift the page for most owners.
  if (overview.isPending) return null;
  if (overview.isError)
    return (
      <InlineRetry
        message={t("dashboard:nodes.agentUpdate.loadFailed")}
        onRetry={() => overview.refetch()}
      />
    );
  return <AgentUpdateAllPanel overview={overview.data} />;
}

export function AgentUpdateAllPanel({ overview }: { overview: AgentUpdateOverview }) {
  const { t } = useTranslation(["dashboard"]);
  const [choosing, setChoosing] = useState(false);
  const eligible = overview.nodes.filter((node) => node.outdated && node.canUpdate);
  const outdated = overview.nodes.filter((node) => node.outdated).length;
  const batch = overview.batch;
  const running = batch?.state === "running";
  if (outdated === 0 && !batch) return null;
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{t(`${K}.title`)}</CardTitle>
        <CardDescription>
          {t(`${K}.description`, { version: overview.server.version })}
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4 text-sm">
        {batch ? <BatchProgress batch={batch} nodes={overview.nodes} /> : null}
        {running ? null : (
          <div className="min-w-0 space-y-2">
            <p className="text-muted-foreground">
              {t(`${K}.summary`, { count: outdated, eligible: eligible.length })}
            </p>
            {eligible.length > 0 ? (
              <Button className="min-h-[44px]" onClick={() => setChoosing(true)}>
                <Download aria-hidden="true" />
                {t(`${K}.start`, { count: eligible.length })}
              </Button>
            ) : null}
          </div>
        )}
      </CardContent>
      {eligible.length > 0 && !running ? (
        <StartAllDialog
          eligible={eligible}
          defaultCanaryNodeId={overview.defaultCanaryNodeId}
          open={choosing}
          onOpenChange={setChoosing}
        />
      ) : null}
    </Card>
  );
}

const ROW_TONE: Record<BatchRowStatus, "success" | "warning" | "info" | "muted" | "destructive"> = {
  waiting: "muted",
  untouched: "muted",
  updating: "info",
  updated: "success",
  rolled_back: "warning",
  failed: "destructive",
};

function BatchProgress({
  batch,
  nodes,
}: {
  batch: AgentUpdateBatchView;
  nodes: readonly NodeAgentUpdateView[];
}) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const stop = useMutation({
    ...orpc.nodes.agentUpdate.stopAll.mutationOptions({
      onSuccess: () => {
        toast.success(t(`${K}.stopRequested`));
        queryClient.invalidateQueries({ queryKey: orpc.nodes.key() });
      },
    }),
    ...refusalToastOptions(t),
  });
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const rows = batchRows(batch, (nodeId) => byId.get(nodeId)?.latest);
  const slugOf = (nodeId: string) => byId.get(nodeId)?.slug ?? nodeId;
  const current = batch.currentNodeId;
  const untouched = batch.untouchedNodeIds.map(slugOf);
  return (
    <section className="min-w-0 space-y-3" aria-live="polite">
      {batch.state === "running" ? (
        <p className="font-medium">
          {current === batch.canaryNodeId
            ? t(`${K}.canaryRunning`, { slug: slugOf(batch.canaryNodeId) })
            : current
              ? t(`${K}.running`, { slug: slugOf(current) })
              : t(`${K}.runningIdle`)}
        </p>
      ) : batch.state === "done" ? (
        <p className="font-medium">{t(`${K}.done`, { count: batch.nodeIds.length })}</p>
      ) : (
        <div className="min-w-0 space-y-1">
          <p className="font-medium">
            {t(`${K}.stoppedReason.${knownOr(BATCH_STOP_REASONS, batch.stoppedReason, "other")}`)}
          </p>
          {untouched.length > 0 ? (
            <p className="text-muted-foreground">
              {t(`${K}.untouched`, { count: untouched.length, slugs: untouched.join(", ") })}
            </p>
          ) : null}
        </div>
      )}
      <ol className="min-w-0 divide-y rounded-md border">
        {rows.map((row) => (
          <li
            key={row.nodeId}
            className="flex min-h-11 min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono">{slugOf(row.nodeId)}</span>
              {row.nodeId === batch.canaryNodeId ? (
                <StatusPill tone="info">{t(`${K}.canary`)}</StatusPill>
              ) : null}
            </span>
            <StatusPill tone={ROW_TONE[row.status]}>{t(`${K}.row.${row.status}`)}</StatusPill>
          </li>
        ))}
      </ol>
      {batch.state === "running" ? (
        <div className="space-y-1.5">
          <Button
            variant="outline"
            className="min-h-[44px]"
            disabled={stop.isPending}
            onClick={() => stop.mutate({ batchId: batch.id })}
          >
            <CircleStop aria-hidden="true" />
            {t(`${K}.stop`)}
          </Button>
          <p className="text-xs text-muted-foreground">{t(`${K}.stopHint`)}</p>
        </div>
      ) : null}
    </section>
  );
}

function StartAllDialog({
  eligible,
  defaultCanaryNodeId,
  open,
  onOpenChange,
}: {
  eligible: readonly NodeAgentUpdateView[];
  /** The node `startAll` picks with no `canaryNodeId` (fewest running instances, then slug). */
  defaultCanaryNodeId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<string | null>(null);
  const startAll = useMutation({
    ...orpc.nodes.agentUpdate.startAll.mutationOptions({
      onSuccess: () => {
        toast.success(t(`${K}.started`));
        onOpenChange(false);
        queryClient.invalidateQueries({ queryKey: orpc.nodes.key() });
      },
    }),
    ...refusalToastOptions(t),
  });
  const isEligible = (nodeId: string | null) =>
    nodeId !== null && eligible.some((node) => node.nodeId === nodeId);
  const suggested = isEligible(defaultCanaryNodeId) ? defaultCanaryNodeId : null;
  // The server's pick unless the owner picked another; with no pick, the server decides.
  const chosen = (isEligible(picked) ? picked : null) ?? suggested ?? AUTO;
  const waiting = eligible.filter(forceOffered).map((node) => node.slug);
  const wsl = eligible.some((node) => node.wsl);
  const slugOf = (value: string) => eligible.find((node) => node.nodeId === value)?.slug ?? value;
  const labelOf = (value: string) =>
    value === AUTO
      ? t(`${K}.canaryAuto`)
      : value === suggested
        ? t(`${K}.canarySuggested`, { slug: slugOf(value) })
        : slugOf(value);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-x-hidden overflow-y-auto overscroll-contain sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(`${K}.dialogTitle`, { count: eligible.length })}</DialogTitle>
          <DialogDescription>{t(`${K}.dialogDescription`)}</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-3 text-sm">
          <div className="space-y-1.5">
            <Label htmlFor="update-all-canary">{t(`${K}.canaryLabel`)}</Label>
            <Select
              value={chosen}
              onValueChange={(next) => {
                if (typeof next === "string") setPicked(next);
              }}
            >
              <SelectTrigger id="update-all-canary" className="min-h-[44px] w-full">
                <SelectValue>{labelOf(chosen)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {suggested ? null : <SelectItem value={AUTO}>{t(`${K}.canaryAuto`)}</SelectItem>}
                {eligible.map((node) => (
                  <SelectItem key={node.nodeId} value={node.nodeId}>
                    {labelOf(node.nodeId)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t(`${K}.canaryHint`)}</p>
          </div>
          <section className="min-w-0 space-y-1">
            <h3 className="font-medium">{t(`${K}.willUpdate`, { count: eligible.length })}</h3>
            <p className="break-words font-mono text-xs text-muted-foreground">
              {eligible.map((node) => node.slug).join(", ")}
            </p>
          </section>
          {waiting.length > 0 ? (
            <p className="text-muted-foreground">
              {t(`${K}.waitsForIdle`, { count: waiting.length, slugs: waiting.join(", ") })}
            </p>
          ) : null}
          {wsl ? (
            <p className="text-muted-foreground">{t("dashboard:nodes.agentUpdate.wslWarning")}</p>
          ) : null}
        </div>
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
            disabled={startAll.isPending}
            onClick={() =>
              startAll.mutate(
                chosen === AUTO || chosen === suggested ? {} : { canaryNodeId: chosen },
              )
            }
          >
            {t(`${K}.confirm`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
