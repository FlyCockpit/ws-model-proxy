import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Bot, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { AgentLevel } from "@/components/access/agent-level-choice";
import { ConfirmAction } from "@/components/access/confirm-action";
import { CreateAgentTokenDialog } from "@/components/access/create-agent-token-dialog";
import {
  CredentialDatesList,
  CredentialStatusBadge,
  credentialStatus,
} from "@/components/access/credential-meta";
import { CodeSnippet } from "@/components/code-snippet";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { SegmentedControl } from "@/components/segmented-control";
import { TimeAgo } from "@/components/time-ago";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/access/agents")({
  component: AccessAgentsPage,
});

type AgentTokenView = {
  id: string;
  name: string;
  level: AgentLevel;
  lookupPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

function AccessAgentsPage() {
  const { t } = useTranslation(["access"]);
  const tokens = useQuery(orpc.access.agentTokens.list.queryOptions());
  const flags = useQuery(orpc.app.flags.queryOptions());
  const mcpOff = flags.data?.mcpEnabled === false;
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading page="accessAgents" />
      {tokens.isPending ? (
        <Skeleton aria-hidden="true" className="h-20 w-full rounded-xl" />
      ) : tokens.isError ? null : (
        <Card>
          <CardContent className="min-w-0 space-y-1.5">
            <p className="text-sm font-medium">{t("access:agents.mcpUrl")}</p>
            <CodeSnippet code={tokens.data.mcpUrl} copyLabel={t("access:agents.copyMcpUrl")} />
            <p className="text-xs text-muted-foreground">{t("access:agents.mcpHint")}</p>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <CardTitle>{t("access:agents.tokensTitle")}</CardTitle>
            <CardDescription>{t("access:agents.tokensDescription")}</CardDescription>
          </div>
          <Button type="button" size="touch" disabled={mcpOff} onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden="true" />
            {t("access:agents.create")}
          </Button>
          {mcpOff ? (
            <p className="w-full text-sm text-muted-foreground">{t("access:agents.mcpOff")}</p>
          ) : null}
        </CardHeader>
        <CardContent className="min-w-0">
          {tokens.isPending ? (
            <div className="flex flex-col gap-3" aria-hidden="true">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : tokens.isError ? (
            <InlineRetry message={t("access:agents.loadFailed")} onRetry={() => tokens.refetch()} />
          ) : tokens.data.tokens.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Bot aria-hidden="true" className="size-4" />
              {t("access:agents.empty")}
            </p>
          ) : (
            <TokenList tokens={tokens.data.tokens} />
          )}
        </CardContent>
      </Card>
      <OAuthConnections />
      <CreateAgentTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        mcpUrl={tokens.data?.mcpUrl ?? null}
      />
    </div>
  );
}

function TokenList({ tokens }: { tokens: AgentTokenView[] }) {
  const now = Date.now();
  return (
    <ul className="flex min-w-0 flex-col divide-y">
      {tokens.map((token) => (
        <li key={token.id} className="py-3 first:pt-0 last:pb-0">
          <TokenRow token={token} now={now} />
        </li>
      ))}
    </ul>
  );
}

function LevelBadge({ level }: { level: AgentLevel }) {
  const { t } = useTranslation(["access"]);
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 text-xs">
      {level === "FULL" ? t("access:agents.levelFull") : t("access:agents.levelRead")}
    </span>
  );
}

function TokenRow({ token, now }: { token: AgentTokenView; now: number }) {
  const { t } = useTranslation(["access"]);
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const revoke = useMutation(
    orpc.access.agentTokens.revoke.mutationOptions({
      onSuccess: async () => {
        setConfirmOpen(false);
        toast.success(t("access:revoke.done"));
        await queryClient.invalidateQueries({ queryKey: orpc.access.agentTokens.list.key() });
      },
    }),
  );
  const status = credentialStatus(token, now);
  return (
    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-medium">{token.name}</span>
          <LevelBadge level={token.level} />
          <CredentialStatusBadge status={status} />
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">{token.lookupPrefix}…</p>
        <CredentialDatesList row={token} />
      </div>
      {status !== "revoked" ? (
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="self-start"
          onClick={() => setConfirmOpen(true)}
        >
          {t("access:revoke.action")}
        </Button>
      ) : null}
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("access:agents.revokeTitle", { name: token.name })}
        description={t("access:agents.revokeDescription")}
        confirmLabel={t("access:revoke.action")}
        pendingLabel={t("access:revoke.pending")}
        isPending={revoke.isPending}
        onConfirm={() => revoke.mutate({ agentTokenId: token.id })}
      />
    </div>
  );
}

function OAuthConnections() {
  const { t } = useTranslation(["access"]);
  const grants = useQuery(orpc.access.oauthGrants.list.queryOptions());
  const active = grants.data?.connections.filter((connection) => !connection.revokedAt) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("access:agents.oauthTitle")}</CardTitle>
        <CardDescription>{t("access:agents.oauthDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        {grants.isPending ? (
          <Skeleton aria-hidden="true" className="h-16 w-full" />
        ) : grants.isError ? (
          <InlineRetry
            message={t("access:agents.oauthLoadFailed")}
            onRetry={() => grants.refetch()}
          />
        ) : active.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("access:agents.oauthEmpty")}</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y">
            {active.map((connection) => (
              <li key={connection.grantId} className="py-3 first:pt-0 last:pb-0">
                <OAuthRow connection={connection} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function OAuthRow({
  connection,
}: {
  connection: {
    grantId: string;
    clientName: string | null;
    redirectHost: string | null;
    level: AgentLevel;
    fullAvailable: boolean;
    createdAt: string;
  };
}) {
  const { t } = useTranslation(["access"]);
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmFullOpen, setConfirmFullOpen] = useState(false);
  const name = connection.clientName ?? t("access:agents.unnamedClient");
  const revoke = useMutation(
    orpc.access.oauthGrants.revoke.mutationOptions({
      onSuccess: async () => {
        setConfirmOpen(false);
        toast.success(t("access:agents.disconnected"));
        await queryClient.invalidateQueries({ queryKey: orpc.access.oauthGrants.list.key() });
      },
    }),
  );
  // A failure is toasted by the global mutation error handler; the list stays the truth.
  const setLevel = useMutation(
    orpc.access.oauthGrants.setLevel.mutationOptions({
      onSuccess: async () => {
        setConfirmFullOpen(false);
        toast.success(t("access:agents.levelChanged"));
      },
      onSettled: () =>
        queryClient.invalidateQueries({ queryKey: orpc.access.oauthGrants.list.key() }),
    }),
  );
  const chooseLevel = (next: AgentLevel) => {
    if (next === connection.level || setLevel.isPending) return;
    // Raising gives the agent write access: say what Full allows first. Lowering is immediate.
    if (next === "FULL") setConfirmFullOpen(true);
    else setLevel.mutate({ grantId: connection.grantId, level: next });
  };
  // Without mcp:write in its approval the agent can never act at Full: nothing to raise to
  // (a Full grant from before stays lowerable).
  const levelLocked = !connection.fullAvailable && connection.level === "READ";
  return (
    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-medium">{name}</span>
          <LevelBadge level={connection.level} />
        </div>
        <p className="text-xs text-muted-foreground">
          {connection.redirectHost ? `${connection.redirectHost} · ` : null}
          <TimeAgo value={connection.createdAt} />
        </p>
        {levelLocked ? (
          <p className="text-xs text-muted-foreground">{t("access:agents.fullUnavailable")}</p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 self-start sm:self-center">
        {levelLocked ? null : (
          <SegmentedControl
            value={connection.level}
            onChange={chooseLevel}
            ariaLabel={t("access:agents.levelFor", { name })}
            items={[
              { value: "READ", label: t("access:agents.levelRead") },
              { value: "FULL", label: t("access:agents.levelFull") },
            ]}
          />
        )}
        <Button type="button" variant="outline" size="touch" onClick={() => setConfirmOpen(true)}>
          {t("access:agents.disconnect")}
        </Button>
      </div>
      <ConfirmAction
        open={confirmFullOpen}
        onOpenChange={setConfirmFullOpen}
        title={t("access:agents.raiseTitle", { name })}
        description={t("access:agents.levelFullHint")}
        confirmLabel={t("access:agents.raiseConfirm")}
        isPending={setLevel.isPending}
        onConfirm={() => setLevel.mutate({ grantId: connection.grantId, level: "FULL" })}
      />
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("access:agents.disconnectTitle", { name })}
        description={t("access:agents.disconnectDescription")}
        confirmLabel={t("access:agents.disconnect")}
        isPending={revoke.isPending}
        onConfirm={() => revoke.mutate({ grantId: connection.grantId })}
      />
    </div>
  );
}
