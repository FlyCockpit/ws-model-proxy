import { useForm } from "@tanstack/react-form";
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
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Bot, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { ConfirmAction } from "@/components/access/confirm-action";
import {
  CredentialDatesList,
  CredentialStatusBadge,
  credentialStatus,
  EXPIRY_CHOICES,
  type ExpiryChoice,
  expiryFromChoice,
} from "@/components/access/credential-meta";
import { SecretReveal } from "@/components/access/secret-reveal";
import { CodeSnippet } from "@/components/code-snippet";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { SegmentedControl } from "@/components/segmented-control";
import { TimeAgo } from "@/components/time-ago";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/access/agents")({
  component: AccessAgentsPage,
});

type AgentLevel = "READ" | "FULL";
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
    createdAt: string;
  };
}) {
  const { t } = useTranslation(["access"]);
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
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
      </div>
      <Button
        type="button"
        variant="outline"
        size="touch"
        className="self-start sm:self-center"
        onClick={() => setConfirmOpen(true)}
      >
        {t("access:agents.disconnect")}
      </Button>
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

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  level: z.enum(["READ", "FULL"]),
  expiry: z.enum(EXPIRY_CHOICES),
});

function CreateAgentTokenDialog({
  open,
  onOpenChange,
  mcpUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mcpUrl: string | null;
}) {
  const { t } = useTranslation(["access"]);
  const [secret, setSecret] = useState<string | null>(null);
  // Owned here so the dialog cannot close while the token is being minted (a late result would
  // otherwise reveal the secret later); `gcTime: 0` keeps it out of the mutation cache.
  const create = useMutation({ ...orpc.access.agentTokens.create.mutationOptions(), gcTime: 0 });
  const close = () => {
    if (create.isPending) return;
    setSecret(null);
    create.reset();
    onOpenChange(false);
  };
  const config =
    secret && mcpUrl
      ? JSON.stringify(
          {
            mcpServers: {
              "ws-model-proxy": {
                type: "http",
                url: mcpUrl,
                headers: { Authorization: `Bearer ${secret}` },
              },
            },
          },
          null,
          2,
        )
      : null;
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={secret ? t("access:agents.created") : t("access:agents.createTitle")}
      description={secret ? undefined : t("access:agents.tokensDescription")}
    >
      {secret ? (
        <SecretReveal value={secret} onDone={close}>
          {config ? (
            <div className="min-w-0 space-y-1.5">
              <p className="text-sm font-medium">{t("access:agents.configExample")}</p>
              <CodeSnippet code={config} copyLabel={t("access:agents.copyConfig")} />
            </div>
          ) : null}
        </SecretReveal>
      ) : open ? (
        <CreateAgentTokenForm
          create={create.mutateAsync}
          onCreated={(value) => {
            setSecret(value);
            create.reset();
          }}
        />
      ) : null}
    </ResponsiveDialog>
  );
}

type CreateAgentToken = (input: {
  name: string;
  level: AgentLevel;
  expiresAt: string | null;
}) => Promise<{ secret: string }>;

function CreateAgentTokenForm({
  create,
  onCreated,
}: {
  create: CreateAgentToken;
  onCreated: (secret: string) => void;
}) {
  const { t } = useTranslation(["access"]);
  const queryClient = useQueryClient();
  const flags = useQuery(orpc.app.flags.queryOptions());
  const noExpiryAllowed = flags.data?.agentTokenNoExpiryAllowed === true;
  const choices = EXPIRY_CHOICES.filter((choice) => choice !== "never" || noExpiryAllowed);
  const form = useForm({
    defaultValues: {
      name: "",
      level: "READ" as AgentLevel,
      expiry: "d90" as ExpiryChoice,
    },
    validators: { onSubmit: createSchema },
    onSubmit: async ({ value }) => {
      // A failure is toasted by the global mutation error handler.
      const result = await create({
        name: value.name.trim(),
        level: value.level,
        expiresAt: expiryFromChoice(value.expiry, Date.now()),
      }).catch(() => null);
      if (!result) return;
      await queryClient.invalidateQueries({ queryKey: orpc.access.agentTokens.list.key() });
      onCreated(result.secret);
    },
  });
  return (
    <form
      className="flex min-w-0 flex-col gap-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.Field name="name">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{t("access:fields.name")}</Label>
            <Input
              id={field.name}
              autoComplete="off"
              className="min-h-11"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              aria-invalid={field.state.meta.errors.length > 0}
              aria-describedby={
                field.state.meta.errors.length > 0 ? "agent-token-name-error" : undefined
              }
            />
            {field.state.meta.errors.length > 0 ? (
              <p id="agent-token-name-error" className="text-sm text-destructive">
                {t("access:fields.nameRequired")}
              </p>
            ) : null}
          </div>
        )}
      </form.Field>
      <form.Field name="level">
        {(field) => (
          <div className="min-w-0 space-y-2">
            <Label>{t("access:agents.level")}</Label>
            <SegmentedControl
              value={field.state.value}
              onChange={field.handleChange}
              ariaLabel={t("access:agents.level")}
              items={[
                { value: "READ", label: t("access:agents.levelRead") },
                { value: "FULL", label: t("access:agents.levelFull") },
              ]}
            />
            <p className="text-xs text-muted-foreground">
              {field.state.value === "FULL"
                ? t("access:agents.levelFullHint")
                : t("access:agents.levelReadHint")}
            </p>
          </div>
        )}
      </form.Field>
      <form.Field name="expiry">
        {(field) => (
          <div className="min-w-0 space-y-2">
            <Label>{t("access:fields.expiry")}</Label>
            <SegmentedControl
              value={field.state.value}
              onChange={field.handleChange}
              ariaLabel={t("access:fields.expiry")}
              items={choices.map((choice) => ({
                value: choice,
                label: t(`access:expiry.${choice}`),
              }))}
            />
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <Button type="submit" size="touch" disabled={isSubmitting}>
            {isSubmitting ? t("access:agents.creating") : t("access:agents.create")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
