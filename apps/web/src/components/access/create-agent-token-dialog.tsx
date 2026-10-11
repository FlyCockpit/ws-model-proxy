import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import {
  type AgentLevel,
  AgentLevelChoice,
  DEFAULT_AGENT_LEVEL,
} from "@/components/access/agent-level-choice";
import {
  EXPIRY_CHOICES,
  type ExpiryChoice,
  expiryFromChoice,
} from "@/components/access/credential-meta";
import { SecretReveal } from "@/components/access/secret-reveal";
import { CodeSnippet } from "@/components/code-snippet";
import { SegmentedControl } from "@/components/segmented-control";
import { orpc } from "@/utils/orpc";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  level: z.enum(["READ", "FULL"]),
  expiry: z.enum(EXPIRY_CHOICES),
});

/** Access → Agents "Create agent token": the form, then the token once with an agent config. */
export function CreateAgentTokenDialog({
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
      level: DEFAULT_AGENT_LEVEL,
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
      // Reveal at once: the dialog may close while the list refreshes, and a late reveal would
      // leave the secret behind for the next open.
      onCreated(result.secret);
      void queryClient.invalidateQueries({ queryKey: orpc.access.agentTokens.list.key() });
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
        {(field) => <AgentLevelChoice value={field.state.value} onChange={field.handleChange} />}
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
