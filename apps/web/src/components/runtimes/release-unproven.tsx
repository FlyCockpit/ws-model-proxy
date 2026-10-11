import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmAction } from "@/components/access/confirm-action";
import { InlineRetry } from "@/components/inline-retry";
import { StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

type Instance = Awaited<ReturnType<AppRouterClient["runtimes"]["get"]>>["instanceList"][number];
type Rank = Instance["ranks"][number];
type ReleaseRequest = Awaited<
  ReturnType<AppRouterClient["runtimes"]["releaseRequests"]["list"]>
>["items"][number];

/**
 * Why the node cannot prove the stop right now, as the server records it on release: the node is
 * gone or offline, else the last automatic check's code (`status_running`, `port_in_use`, ...).
 */
export function stopUnprovenReason(rank: Rank): string {
  if (rank.nodeConnection === null) return "node_removed";
  if (rank.nodeConnection.state === "OFFLINE") return "node_offline";
  if (rank.lastStopCheck === null) return "no_check";
  return rank.lastStopCheck.errorCode ?? "not_stopped";
}

function useInvalidateAfterRelease() {
  const queryClient = useQueryClient();
  // Freed capacity changes runtimes (and the instance), nodes, pools and models; Needs you
  // drops the request.
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.nodes.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.pools.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.models.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.activity.needsYou.key() }),
    ]);
}

/**
 * "Release resources…" for a node part marked stopped whose stop its node cannot prove
 * (HELD_UNKNOWN). A person-only action: the dialog says plainly that it frees the reserved
 * capacity while the old process may still be running, and shows why the node cannot prove the
 * stop. With `requestId`, it reviews an agent's request instead: the agent's findings are shown
 * as its own unverified words, and the person approves (the same release) or declines.
 */
export function ReleaseUnprovenAction({
  runtimeId,
  instanceId,
  nodeNumber,
  requestId,
}: {
  runtimeId: string;
  instanceId: string;
  nodeNumber: number;
  requestId?: string | null;
}) {
  const { t } = useTranslation(["dashboard"]);
  const invalidate = useInvalidateAfterRelease();
  const [open, setOpen] = useState(false);
  const release = useMutation({
    ...orpc.runtimes.instances.releaseUnproven.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const approve = useMutation({
    ...orpc.runtimes.releaseRequests.approve.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const decline = useMutation({
    ...orpc.runtimes.releaseRequests.decline.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const pending = release.isPending || approve.isPending || decline.isPending;
  const review = Boolean(requestId);

  async function confirm() {
    try {
      if (requestId) await approve.mutateAsync({ requestId });
      else await release.mutateAsync({ instanceId, nodeNumber });
    } catch (error) {
      toast.error(refusalText(error));
      return;
    }
    setOpen(false);
    toast.success(t("dashboard:runtime.releaseUnproven.done"));
    await invalidate();
  }

  async function refuse() {
    if (!requestId) return;
    try {
      await decline.mutateAsync({ requestId });
    } catch (error) {
      toast.error(refusalText(error));
      return;
    }
    setOpen(false);
    toast.success(t("dashboard:runtime.releaseUnproven.declined"));
    await invalidate();
  }

  return (
    <>
      <Button variant="outline" size="touch" onClick={() => setOpen(true)}>
        {review
          ? t("dashboard:runtime.releaseUnproven.review")
          : t("dashboard:runtime.releaseUnproven.action")}
      </Button>
      <ConfirmAction
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
        }}
        title={t("dashboard:runtime.releaseUnproven.title")}
        description={t("dashboard:runtime.releaseUnproven.description")}
        confirmLabel={
          review
            ? t("dashboard:runtime.releaseUnproven.approve")
            : t("dashboard:runtime.releaseUnproven.confirm")
        }
        pendingLabel={t("dashboard:runtime.releaseUnproven.pending")}
        isPending={pending}
        onConfirm={() => void confirm()}
      >
        {open ? (
          <ReleaseEvidence runtimeId={runtimeId} instanceId={instanceId} nodeNumber={nodeNumber} />
        ) : null}
        {open && requestId ? <AgentFindings instanceId={instanceId} requestId={requestId} /> : null}
        {review ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={pending}
            onClick={() => void refuse()}
          >
            {t("dashboard:runtime.releaseUnproven.decline")}
          </Button>
        ) : null}
      </ConfirmAction>
    </>
  );
}

/** Where the part runs and why its stop cannot be proven (read from the runtime). */
function ReleaseEvidence({
  runtimeId,
  instanceId,
  nodeNumber,
}: {
  runtimeId: string;
  instanceId: string;
  nodeNumber: number;
}) {
  const { t } = useTranslation(["dashboard"]);
  const runtime = useQuery(orpc.runtimes.get.queryOptions({ input: { runtimeId } }));
  if (runtime.isPending)
    return (
      <div className="flex flex-col gap-2" aria-hidden="true">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  const rank = runtime.data?.instanceList
    .find((row) => row.id === instanceId)
    ?.ranks.find((row) => row.nodeNumber === nodeNumber);
  if (!rank)
    return (
      <InlineRetry
        message={t("dashboard:runtime.markStopped.evidence.loadFailed")}
        onRetry={() => runtime.refetch()}
      />
    );
  const reason = stopUnprovenReason(rank);
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm">
      <h3 className="font-medium">{t("dashboard:runtime.markStopped.evidence.title")}</h3>
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t("dashboard:runtime.releaseUnproven.where")}</dt>
        <dd className="break-all">
          {t("dashboard:runtime.releaseUnproven.place", {
            node: rank.nodeSlug ?? t("dashboard:runtime.nodeGone"),
            port: rank.port,
          })}
        </dd>
        <dt className="text-muted-foreground">
          {t("dashboard:runtime.releaseUnproven.reasonLabel")}
        </dt>
        <dd className="min-w-0 break-words">
          {t(`dashboard:runtime.releaseUnproven.reason.${reason}`, {
            defaultValue: t(`dashboard:runtime.markStopped.evidence.reason.${reason}`, {
              defaultValue: reason,
            }),
          })}
          {rank.lastStopCheck ? (
            <span className="ml-2 text-xs text-muted-foreground">
              <TimeAgo value={rank.lastStopCheck.at} />
            </span>
          ) : null}
        </dd>
      </dl>
    </section>
  );
}

/**
 * The agent's findings, shown as untrusted text: plain text only (never markup or links), with
 * a label saying the agent wrote it and wsmp did not check it.
 */
function AgentFindings({ instanceId, requestId }: { instanceId: string; requestId: string }) {
  const { t } = useTranslation(["dashboard"]);
  const requests = useQuery(
    orpc.runtimes.releaseRequests.list.queryOptions({ input: { instanceId } }),
  );
  if (requests.isPending) return <Skeleton aria-hidden="true" className="h-16 w-full" />;
  const request = requests.data?.items.find((item) => item.id === requestId);
  if (!request)
    return (
      <InlineRetry
        message={t("dashboard:runtime.releaseUnproven.request.loadFailed")}
        onRetry={() => requests.refetch()}
      />
    );
  return <FindingsBody request={request} />;
}

function FindingsBody({ request }: { request: ReleaseRequest }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <section
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-amber-500/40 p-3 text-sm"
      aria-label={t("dashboard:runtime.releaseUnproven.request.title")}
    >
      <h3 className="font-medium">
        {t("dashboard:runtime.releaseUnproven.request.title")}{" "}
        <span className="text-xs font-normal text-muted-foreground">
          <TimeAgo value={request.createdAt} />
        </span>
      </h3>
      <p className="text-xs text-muted-foreground">
        {request.agentName
          ? t("dashboard:runtime.releaseUnproven.request.untrustedNamed", {
              agent: request.agentName,
            })
          : t("dashboard:runtime.releaseUnproven.request.untrusted")}
      </p>
      <pre className="max-h-48 min-w-0 overflow-x-auto overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
        {request.findings}
      </pre>
      {request.evidence.map((entry, index) => (
        // The agent's list never changes while shown; entries have no identity of their own.
        <div key={index} className="flex min-w-0 flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            {t("dashboard:runtime.releaseUnproven.request.command")}
          </p>
          <pre className="min-w-0 overflow-x-auto overscroll-x-contain whitespace-pre rounded bg-muted p-2 text-xs">
            {entry.command}
          </pre>
          {entry.output ? (
            <pre className="max-h-40 min-w-0 overflow-x-auto overflow-y-auto overscroll-contain whitespace-pre rounded bg-muted p-2 text-xs">
              {entry.output}
            </pre>
          ) : null}
        </div>
      ))}
    </section>
  );
}

/**
 * The parts of an instance marked stopped whose stop is still not proven (HELD_UNKNOWN), each
 * with its release action, or the agent's pending request to review. Nothing when none.
 */
export function HeldPartsRelease({
  runtimeId,
  instance,
}: {
  runtimeId: string;
  instance: Instance;
}) {
  const { t } = useTranslation(["dashboard"]);
  const held = instance.ranks.filter((rank) => rank.reserved === "HELD_UNKNOWN");
  if (held.length === 0) return null;
  return (
    <ul className="flex w-full min-w-0 basis-full flex-col gap-1">
      {held.map((rank) => (
        <li key={rank.nodeNumber} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 break-all text-muted-foreground">
            {t("dashboard:runtime.releaseUnproven.place", {
              node: rank.nodeSlug ?? t("dashboard:runtime.nodeGone"),
              port: rank.port,
            })}
          </span>
          {rank.releaseRequestId ? (
            <StatusPill tone="busy">{t("dashboard:runtime.releaseUnproven.requested")}</StatusPill>
          ) : null}
          <ReleaseUnprovenAction
            runtimeId={runtimeId}
            instanceId={instance.id}
            nodeNumber={rank.nodeNumber}
            requestId={rank.releaseRequestId}
          />
        </li>
      ))}
    </ul>
  );
}
