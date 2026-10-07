/** Read-mostly node detail cards: secrets, what runs, detected servers, credentials, activity. */
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { NODE_SECRET_PATTERN as SECRET_NAME } from "@ws-model-proxy/api/lib/runtime-spec";
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
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Trash } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { InlineRetry } from "@/components/inline-retry";
import { MarkStoppedAction, StopNotConfirmedHelp } from "@/components/runtimes/mark-stopped";
import { TimeAgo } from "@/components/time-ago";
import { orpc } from "@/utils/orpc";

import { ConfirmActionDialog } from "./confirm-action-dialog";
import { FieldError } from "./field-error";
import { CommandBlock, StatusPill } from "./node-badges";
import type { NodeDetail } from "./node-types";
import { refusalToastOptions } from "./refusal";

function useInvalidateNodes() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.nodes.key() });
}

/** Write-only node secrets: names and when they were set; values never come back. */
export function SecretsCard({ node }: { node: NodeDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const invalidate = useInvalidateNodes();
  const canWrite = node.trust.effective === "FULL" && node.connection === "ONLINE";
  const [deletingSecret, setDeletingSecret] = useState<string | null>(null);
  const set = useMutation({
    // The value is in the mutation's variables: keep them no longer than the call.
    gcTime: 0,
    ...orpc.nodes.secrets.set.mutationOptions({
      onSuccess: (result) => {
        toast.success(t("dashboard:nodes.secrets.saved", { name: result.name }));
        invalidate();
      },
    }),
    ...refusalToastOptions(t),
  });
  const remove = useMutation({
    ...orpc.nodes.secrets.delete.mutationOptions({
      onSuccess: () => {
        toast.success(t("dashboard:nodes.secrets.deleted"));
        invalidate();
      },
    }),
    ...refusalToastOptions(t),
  });
  const form = useForm({
    defaultValues: { name: "WSMP_SECRET_", value: "" },
    validators: {
      onChange: z.object({
        name: z.string().regex(SECRET_NAME, t("dashboard:nodes.secrets.nameInvalid")),
        value: z.string().min(1, t("dashboard:nodes.secrets.valueRequired")),
      }),
    },
    onSubmit: async ({ value, formApi }) => {
      try {
        await set.mutateAsync({ nodeId: node.id, name: value.name, value: value.value });
      } finally {
        // The value never stays in the page after it is sent, sent or not.
        formApi.reset();
        set.reset();
      }
    },
  });
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:nodes.secrets.title")}</CardTitle>
        <CardDescription>{t("dashboard:nodes.secrets.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {node.secrets.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard:nodes.secrets.empty")}</p>
        ) : (
          <ul className="divide-y">
            {node.secrets.map((secret) => (
              <li key={secret.name} className="flex min-w-0 items-center gap-2 py-1">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{secret.name}</span>
                <span className="text-xs text-muted-foreground">
                  <TimeAgo value={secret.updatedAt} />
                </span>
                {canWrite ? (
                  <Button
                    variant="ghost"
                    size="icon-touch"
                    aria-label={t("dashboard:nodes.secrets.delete", { name: secret.name })}
                    disabled={remove.isPending}
                    onClick={() => setDeletingSecret(secret.name)}
                  >
                    <Trash aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <ConfirmActionDialog
          open={deletingSecret !== null}
          onOpenChange={(open) => {
            if (!open) setDeletingSecret(null);
          }}
          title={t("dashboard:nodes.secrets.deleteTitle", { name: deletingSecret ?? "" })}
          description={t("dashboard:nodes.secrets.deleteDescription")}
          confirmLabel={t("common:actions.delete")}
          pending={remove.isPending}
          onConfirm={() => {
            if (deletingSecret) remove.mutate({ nodeId: node.id, name: deletingSecret });
          }}
        />
        {canWrite ? (
          <form
            className="space-y-2"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              form.handleSubmit().catch(() => undefined);
            }}
          >
            <form.Field name="name">
              {(field) => (
                <div className="space-y-1.5">
                  <Label htmlFor="secret-name">{t("dashboard:nodes.secrets.name")}</Label>
                  <Input
                    id="secret-name"
                    className="min-h-[44px] font-mono"
                    autoCapitalize="characters"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value.toUpperCase())}
                  />
                  <FieldError errors={field.state.meta.errors} />
                </div>
              )}
            </form.Field>
            <form.Field name="value">
              {(field) => (
                <div className="space-y-1.5">
                  <Label htmlFor="secret-value">{t("dashboard:nodes.secrets.value")}</Label>
                  <Input
                    id="secret-value"
                    type="password"
                    autoComplete="new-password"
                    className="min-h-[44px] font-mono"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldError errors={field.state.meta.errors} />
                </div>
              )}
            </form.Field>
            <Button type="submit" className="min-h-[44px]" disabled={set.isPending}>
              {t("dashboard:nodes.secrets.set")}
            </Button>
          </form>
        ) : (
          <div className="space-y-1.5">
            <p className="text-sm">
              {node.trust.effective === "FULL"
                ? t("dashboard:nodes.secrets.offline")
                : t("dashboard:nodes.secrets.relayHint")}
            </p>
            <CommandBlock command="wsmp secret set WSMP_SECRET_NAME" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const PHASE_TONE = {
  STARTING: "info",
  READY: "success",
  UNHEALTHY: "warning",
  UNAVAILABLE: "warning",
  STOPPING: "muted",
  STOPPED: "muted",
  FAILED: "destructive",
} as const;

/** Instances with a part here, held definitions and detected local servers. */
export function RunsHereCard({ node, lang }: { node: NodeDetail; lang: string }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:nodes.runs.title")}</CardTitle>
        <CardDescription>{t("dashboard:nodes.runs.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {node.instances.length === 0 ? (
          <p className="text-muted-foreground">{t("dashboard:nodes.runs.empty")}</p>
        ) : (
          <ul className="space-y-1">
            {node.instances.map((instance) => (
              <li
                key={`${instance.instanceId}-${instance.nodeNumber}`}
                className="flex flex-wrap items-center gap-2"
              >
                <Link
                  to="/$lang/runtimes/$runtimeId"
                  params={{ lang, runtimeId: instance.runtimeId }}
                  className="inline-flex min-h-[44px] items-center font-medium hover:underline"
                >
                  {instance.runtimeSlug}
                </Link>
                <StatusPill tone={PHASE_TONE[instance.phase]}>
                  {t(`dashboard:nodes.phase.${instance.phase}`)}
                </StatusPill>
                {instance.nodeCount > 1 ? (
                  <span className="text-xs text-muted-foreground">
                    {t("dashboard:nodes.runs.part", {
                      number: instance.nodeNumber,
                      count: instance.nodeCount,
                    })}
                  </span>
                ) : null}
                {instance.needsOperator === "MARK_STOPPED" ? (
                  <>
                    <StatusPill tone="warning">
                      {t("dashboard:runtime.needsOperator.MARK_STOPPED")}
                    </StatusPill>
                    <StopNotConfirmedHelp />
                    {/* Only this node's part, and only while it still waits for its stop. */}
                    {instance.reserved === "HELD" ? (
                      <MarkStoppedAction
                        runtimeId={instance.runtimeId}
                        instanceId={instance.instanceId}
                        nodeNumber={instance.nodeNumber}
                      />
                    ) : null}
                  </>
                ) : instance.needsOperator ? (
                  <StatusPill tone="warning">{t("dashboard:nodes.runs.needsYou")}</StatusPill>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <section className="space-y-1">
          <h3 className="font-medium">{t("dashboard:nodes.runs.held")}</h3>
          {node.heldDefinitions.length === 0 ? (
            <p className="text-muted-foreground">{t("dashboard:nodes.runs.heldEmpty")}</p>
          ) : (
            <ul className="space-y-0.5">
              {node.heldDefinitions.map((held) => (
                <li key={held.versionId} className="flex flex-wrap items-center gap-2">
                  <Link
                    to="/$lang/runtimes/$runtimeId"
                    params={{ lang, runtimeId: held.runtimeId }}
                    className="inline-flex min-h-[44px] items-center font-mono text-xs hover:underline"
                  >
                    {held.launchHash.slice(0, 12)}
                  </Link>
                  {held.current ? null : (
                    <StatusPill tone="muted">{t("dashboard:nodes.runs.olderVersion")}</StatusPill>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="space-y-1">
          <h3 className="font-medium">
            {t("dashboard:nodes.runs.detected")}{" "}
            {node.detectedAt ? (
              <span className="text-xs font-normal text-muted-foreground">
                <TimeAgo value={node.detectedAt} />
              </span>
            ) : null}
          </h3>
          {node.detectedServers.length === 0 ? (
            <p className="text-muted-foreground">{t("dashboard:nodes.runs.detectedEmpty")}</p>
          ) : (
            <ul className="space-y-1">
              {node.detectedServers.map((server) => (
                <li key={server.baseUrl} className="min-w-0">
                  <p className="font-mono text-xs break-all">{server.baseUrl}</p>
                  <p className="text-xs text-muted-foreground">
                    {server.engine} · {server.models.join(", ") || "—"}
                    {server.runtimeId ? ` · ${t("dashboard:nodes.runs.added")}` : null}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

export function CredentialsCard({ node }: { node: NodeDetail }) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState<string | null>(null);
  const credentials = useQuery(
    orpc.nodes.credentials.list.queryOptions({ input: { nodeId: node.id } }),
  );
  const revoke = useMutation({
    ...orpc.nodes.credentials.revoke.mutationOptions({
      onSuccess: () => {
        toast.success(t("dashboard:nodes.credentials.revoked"));
        queryClient.invalidateQueries({ queryKey: orpc.nodes.key() });
      },
    }),
    ...refusalToastOptions(t),
  });
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:nodes.credentials.title")}</CardTitle>
        <CardDescription>{t("dashboard:nodes.credentials.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {credentials.isPending ? (
          <Skeleton aria-hidden="true" className="h-10 w-full" />
        ) : credentials.isError ? (
          <InlineRetry onRetry={() => credentials.refetch()} />
        ) : credentials.data.credentials.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard:nodes.credentials.empty")}</p>
        ) : (
          <ul className="divide-y text-sm">
            {credentials.data.credentials.map((credential) => (
              <li key={credential.id} className="flex min-w-0 flex-wrap items-center gap-2 py-1">
                <div className="min-w-0 flex-1 text-xs">
                  <p>
                    {t("dashboard:nodes.credentials.created")}{" "}
                    <TimeAgo value={credential.createdAt} />
                    {" · "}
                    {t("dashboard:nodes.credentials.lastUsed")}{" "}
                    <TimeAgo value={credential.lastUsedAt} />
                  </p>
                  {credential.lastRefusedReason ? (
                    <p className="text-muted-foreground">
                      {t("dashboard:nodes.credentials.refused", {
                        reason: t(`dashboard:refusals.${credential.lastRefusedReason}`, {
                          defaultValue: credential.lastRefusedReason,
                        }),
                      })}
                    </p>
                  ) : null}
                </div>
                {credential.revokedAt ? (
                  <StatusPill tone="muted">
                    {t("dashboard:nodes.credentials.revokedBadge")}
                  </StatusPill>
                ) : (
                  <Button
                    variant="outline"
                    className="min-h-[44px]"
                    disabled={revoke.isPending}
                    onClick={() => setRevoking(credential.id)}
                  >
                    {t("dashboard:nodes.credentials.revoke")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <ConfirmActionDialog
          open={revoking !== null}
          onOpenChange={(open) => {
            if (!open) setRevoking(null);
          }}
          title={t("dashboard:nodes.credentials.revokeTitle")}
          description={t("dashboard:nodes.credentials.revokeDescription")}
          confirmLabel={t("dashboard:nodes.credentials.revoke")}
          pending={revoke.isPending}
          onConfirm={() => {
            if (revoking) revoke.mutate({ credentialId: revoking });
          }}
        />
      </CardContent>
    </Card>
  );
}

export function NodeActivityCard({ node }: { node: NodeDetail }) {
  const { t } = useTranslation(["dashboard"]);
  const activity = useQuery(
    orpc.nodes.activity.list.queryOptions({ input: { nodeId: node.id, limit: 20 } }),
  );
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:nodes.activity.title")}</CardTitle>
        <CardDescription>{t("dashboard:nodes.activity.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {activity.isPending ? (
          <div aria-hidden="true" className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : activity.isError ? (
          <InlineRetry onRetry={() => activity.refetch()} />
        ) : activity.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard:nodes.activity.empty")}</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {activity.data.items.map((event) => (
              <li key={event.id} className="flex min-w-0 flex-wrap items-center gap-x-2">
                <span className="text-muted-foreground">
                  <TimeAgo value={event.createdAt} />
                </span>
                <span>{t(`dashboard:nodes.activity.actor.${event.actor}`)}</span>
                <span className="font-medium">
                  {t(`dashboard:nodes.activity.kind.${event.kind}`)}
                </span>
                <span className="min-w-0 truncate font-mono text-muted-foreground">
                  {event.subject}
                </span>
                <span>{t(`dashboard:nodes.activity.outcome.${event.outcome}`)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
