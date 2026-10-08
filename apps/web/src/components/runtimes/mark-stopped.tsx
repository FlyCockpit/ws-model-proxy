import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmAction } from "@/components/access/confirm-action";
import { Help } from "@/components/help";
import { InlineRetry } from "@/components/inline-retry";
import { FieldError } from "@/components/nodes/field-error";
import { StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

type Instance = Awaited<ReturnType<AppRouterClient["runtimes"]["get"]>>["instanceList"][number];
type Rank = Instance["ranks"][number];

/** `noteSchema` on the server: trimmed, at most 500 characters (an empty note is left out). */
const NOTE_MAX = 500;

/** What "Stop not confirmed" means and what to do about it (click, so it works on touch). */
export function StopNotConfirmedHelp() {
  const { t } = useTranslation(["dashboard"]);
  return (
    <Help title={t("dashboard:runtime.needsOperator.MARK_STOPPED")}>
      <p>{t("dashboard:runtime.markStopped.help")}</p>
    </Help>
  );
}

/** Why the node could not confirm a stop, in words (an unknown code is shown as is). */
function useCheckReason() {
  const { t } = useTranslation(["dashboard"]);
  return (code: string) =>
    t(`dashboard:runtime.markStopped.evidence.reason.${code}`, { defaultValue: code });
}

/**
 * An instance that needs nobody but still holds resources until its stop is confirmed (a rank
 * marked stopped: HELD_UNKNOWN, also once the instance is STOPPED). wsmp keeps checking on the
 * node; the help says why the last check could not confirm it.
 */
export function HeldUntilConfirmed({ instance }: { instance: Instance }) {
  const { t } = useTranslation(["dashboard"]);
  const reason = useCheckReason();
  const held = instance.ranks.filter((rank) => rank.reserved === "HELD_UNKNOWN");
  if (instance.needsOperator !== null || held.length === 0) return null;
  return (
    <>
      <StatusPill tone="busy">{t("dashboard:runtime.markStopped.held.pill")}</StatusPill>
      <Help title={t("dashboard:runtime.markStopped.held.pill")}>
        <p>{t("dashboard:runtime.markStopped.held.help")}</p>
        {held.map((rank) => (
          <p key={rank.nodeNumber} className="break-words">
            {t("dashboard:runtime.markStopped.evidence.node", {
              node: rank.nodeSlug ?? t("dashboard:runtime.nodeGone"),
            })}
            {": "}
            {rank.lastStopCheck && !rank.lastStopCheck.proven
              ? reason(rank.lastStopCheck.errorCode ?? "not_stopped")
              : t("dashboard:runtime.markStopped.evidence.checkNone")}
          </p>
        ))}
      </Help>
    </>
  );
}

/**
 * "Mark as stopped…" for an instance whose stop its node could not confirm (`needsOperator:
 * MARK_STOPPED`): a person reads what wsmp knows (when the stop was requested, the last
 * automatic check, the node's connection), adds an optional note and confirms. `nodeNumber`
 * marks only that node's part of a multi-node instance.
 */
export function MarkStoppedAction({
  runtimeId,
  instanceId,
  nodeNumber,
}: {
  runtimeId: string;
  instanceId: string;
  nodeNumber?: number;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const noteId = useId();
  const [open, setOpen] = useState(false);
  const markStopped = useMutation({
    ...orpc.runtimes.instances.markStopped.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const form = useForm({
    defaultValues: { note: "" },
    validators: {
      onChange: z.object({
        note: z
          .string()
          .refine(
            (value) => value.trim().length <= NOTE_MAX,
            t("dashboard:runtime.markStopped.noteTooLong"),
          ),
      }),
    },
    onSubmit: async ({ value }) => {
      const note = value.note.trim();
      try {
        await markStopped.mutateAsync({
          instanceId,
          ...(nodeNumber === undefined ? {} : { nodeNumber }),
          ...(note ? { note } : {}),
        });
      } catch (error) {
        toast.error(refusalText(error));
        return;
      }
      setOpen(false);
      form.reset();
      toast.success(t("dashboard:runtime.markStopped.done"));
      // The instance settles STOPPED: runtimes list it, nodes their parts, pools and models its
      // availability; Needs you (Overview and the nav badge) no longer lists it.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.nodes.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.pools.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.models.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.activity.needsYou.key() }),
      ]);
    },
  });
  return (
    <>
      <Button variant="outline" size="touch" onClick={() => setOpen(true)}>
        {t("dashboard:runtime.markStopped.action")}
      </Button>
      <ConfirmAction
        open={open}
        onOpenChange={(next) => {
          if (markStopped.isPending) return;
          setOpen(next);
          if (!next) form.reset();
        }}
        title={t("dashboard:runtime.markStopped.title")}
        description={t("dashboard:runtime.markStopped.description")}
        confirmLabel={t("dashboard:runtime.markStopped.confirm")}
        pendingLabel={t("dashboard:runtime.markStopped.pending")}
        isPending={markStopped.isPending}
        onConfirm={() => void form.handleSubmit()}
      >
        {open ? (
          <StopEvidence runtimeId={runtimeId} instanceId={instanceId} nodeNumber={nodeNumber} />
        ) : null}
        <form
          className="flex min-w-0 flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="note">
            {(field) => (
              <>
                <Label htmlFor={noteId}>{t("dashboard:runtime.markStopped.noteLabel")}</Label>
                <Textarea
                  id={noteId}
                  className="min-h-20"
                  placeholder={t("dashboard:runtime.markStopped.notePlaceholder")}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError errors={field.state.meta.errors} />
              </>
            )}
          </form.Field>
        </form>
      </ConfirmAction>
    </>
  );
}

/**
 * The evidence wsmp holds about the stop, read from the runtime (the runtime page has it cached;
 * the node page loads it when the dialog opens).
 */
function StopEvidence({
  runtimeId,
  instanceId,
  nodeNumber,
}: {
  runtimeId: string;
  instanceId: string;
  nodeNumber?: number;
}) {
  const { t } = useTranslation(["dashboard"]);
  const runtime = useQuery(orpc.runtimes.get.queryOptions({ input: { runtimeId } }));
  if (runtime.isPending)
    return (
      <div className="flex flex-col gap-2" aria-hidden="true">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  const instance = runtime.data?.instanceList.find((row) => row.id === instanceId);
  if (!instance)
    return (
      <InlineRetry
        message={t("dashboard:runtime.markStopped.evidence.loadFailed")}
        onRetry={() => runtime.refetch()}
      />
    );
  const ranks = instance.ranks.filter(
    (rank) => nodeNumber === undefined || rank.nodeNumber === nodeNumber,
  );
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm">
      <h3 className="font-medium">{t("dashboard:runtime.markStopped.evidence.title")}</h3>
      {instance.phase === "STOPPING" ? (
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">
            {t("dashboard:runtime.markStopped.evidence.stopRequested")}
          </dt>
          <dd>
            <TimeAgo value={instance.phaseChangedAt} />
          </dd>
        </dl>
      ) : null}
      {ranks.map((rank) => (
        <RankEvidence key={rank.nodeNumber} rank={rank} />
      ))}
    </section>
  );
}

function RankEvidence({ rank }: { rank: Rank }) {
  const { t } = useTranslation(["dashboard"]);
  const reason = useCheckReason();
  const check = rank.lastStopCheck;
  const connection = rank.nodeConnection;
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t pt-2">
      <p className="break-all font-medium">
        {t("dashboard:runtime.markStopped.evidence.node", {
          node: rank.nodeSlug ?? t("dashboard:runtime.nodeGone"),
        })}
      </p>
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">
          {connection === null
            ? t("dashboard:runtime.markStopped.evidence.removed")
            : connection.since === null
              ? t(
                  connection.state === "ONLINE"
                    ? "dashboard:runtime.markStopped.evidence.onlineNoTime"
                    : "dashboard:runtime.markStopped.evidence.offlineNoTime",
                )
              : t(
                  connection.state === "ONLINE"
                    ? "dashboard:runtime.markStopped.evidence.online"
                    : "dashboard:runtime.markStopped.evidence.offline",
                )}
        </dt>
        <dd>{connection?.since ? <TimeAgo value={connection.since} /> : null}</dd>
        <dt className="text-muted-foreground">
          {t("dashboard:runtime.markStopped.evidence.lastCheck")}
        </dt>
        <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 break-words">
          {check === null ? (
            t("dashboard:runtime.markStopped.evidence.checkNone")
          ) : (
            <>
              <span>
                {t(
                  check.proven
                    ? "dashboard:runtime.markStopped.evidence.checkProven"
                    : "dashboard:runtime.markStopped.evidence.checkNotProven",
                )}
              </span>
              <span className="text-muted-foreground">
                <TimeAgo value={check.at} />
              </span>
              {check.errorCode ? (
                <span className="break-words text-xs text-muted-foreground">
                  {reason(check.errorCode)}
                </span>
              ) : null}
            </>
          )}
        </dd>
      </dl>
    </div>
  );
}
