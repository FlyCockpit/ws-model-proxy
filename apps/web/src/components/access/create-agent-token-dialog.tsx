import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@ws-model-proxy/ui/components/sheet";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { type ReactNode, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AgentAccessChoice, agentAccessSummaryText } from "@/components/access/agent-access-choice";
import { SecretReveal } from "@/components/access/secret-reveal";
import { CodeSnippet } from "@/components/code-snippet";
import { InlineRetry } from "@/components/inline-retry";
import {
  agentAccessSchema,
  defaultAgentAccess,
  type EditableAgentAccess,
} from "@/lib/agent-access";
import {
  agentTokenExpiry,
  agentTokenExpiryPresets,
  localDateInputValue,
} from "@/lib/agent-token-expiry";
import { focusFirstInvalid } from "@/lib/form-focus";
import { orpc } from "@/utils/orpc";

/**
 * Access → Agents "Create agent token", a wide side sheet (too many choices for a dialog): name,
 * access level and permissions, nodes and expiry, with what will be created summed up next to
 * the Create button; then the token once, with an agent config and the next step.
 */
export function CreateAgentTokenDialog({
  open,
  onOpenChange,
  mcpUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mcpUrl: string | null;
}) {
  const { t } = useTranslation(["access", "common"]);
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
  const renderDialog = (children: ReactNode, footer?: ReactNode) => (
    <Sheet open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      {/* The long-form side sheet (template): header and action bar stay put, the body scrolls. */}
      <SheetContent size="wide" className="overflow-x-hidden pt-(--safe-area-top)">
        <SheetHeader>
          <SheetTitle className="text-base font-semibold">
            {secret ? t("access:agents.created") : t("access:agents.createTitle")}
          </SheetTitle>
          {secret ? null : (
            <SheetDescription className="text-sm">
              {t("access:agents.tokensDescription")}
            </SheetDescription>
          )}
        </SheetHeader>
        <SheetBody>{children}</SheetBody>
        {footer ? <SheetFooter className="sm:flex-col">{footer}</SheetFooter> : null}
      </SheetContent>
    </Sheet>
  );
  return secret ? (
    renderDialog(
      <div className="min-w-0 space-y-3">
        <p className="text-sm font-medium">
          {config ? t("access:agents.nextStep") : t("access:agents.nextStepNoConfig")}
        </p>
        <SecretReveal value={secret} onDone={close}>
          {config ? (
            <div className="min-w-0 space-y-1.5">
              <p className="text-sm font-medium">{t("access:agents.configExample")}</p>
              <CodeSnippet code={config} copyLabel={t("access:agents.copyConfig")} />
            </div>
          ) : null}
        </SecretReveal>
      </div>,
    )
  ) : open ? (
    <CreateAgentTokenForm
      renderDialog={renderDialog}
      onCancel={close}
      create={create.mutateAsync}
      onCreated={(value) => {
        setSecret(value);
        create.reset();
      }}
    />
  ) : null;
}

type CreateAgentToken = (input: {
  name: string;
  scopes: EditableAgentAccess["scopes"];
  nodeIds: string[] | null;
  expiresAt: string | null;
}) => Promise<{ secret: string }>;

function CreateAgentTokenForm(props: {
  renderDialog: (children: ReactNode, footer?: ReactNode) => ReactNode;
  onCancel: () => void;
  create: CreateAgentToken;
  onCreated: (secret: string) => void;
}) {
  const { t } = useTranslation(["access", "common"]);
  const flags = useQuery(orpc.app.flags.queryOptions());
  if (flags.isPending) return props.renderDialog(<Skeleton className="h-96 w-full" />);
  if (flags.isError)
    return props.renderDialog(
      <InlineRetry message={t("access:agents.policyFailed")} onRetry={() => flags.refetch()} />,
    );
  return (
    <ReadyAgentTokenForm
      {...props}
      maxLifetimeDays={flags.data.agentTokenMaxLifetimeDays}
      allowNoExpiry={flags.data.agentTokenNoExpiryAllowed}
    />
  );
}

function ReadyAgentTokenForm({
  renderDialog,
  onCancel,
  create,
  onCreated,
  maxLifetimeDays,
  allowNoExpiry,
}: {
  onCancel: () => void;
  create: CreateAgentToken;
  onCreated: (secret: string) => void;
  renderDialog: (children: ReactNode, footer?: ReactNode) => ReactNode;
  maxLifetimeDays: number;
  allowNoExpiry: boolean;
}) {
  const { t } = useTranslation(["access", "common"]);
  const queryClient = useQueryClient();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const choices = agentTokenExpiryPresets(maxLifetimeDays);
  const createSchema = z
    .object({
      name: z.string().trim().min(1).max(120),
      access: agentAccessSchema,
      expiry: z.string(),
      customDate: z.string(),
    })
    .refine(
      (value) =>
        agentTokenExpiry(
          value.expiry,
          value.customDate,
          Date.now(),
          maxLifetimeDays,
          allowNoExpiry,
        ) !== undefined,
      {
        path: ["expiry"],
        message: t("access:agents.expiryInvalid", { days: maxLifetimeDays }),
      },
    );
  const form = useForm({
    defaultValues: {
      name: "",
      access: defaultAgentAccess(),
      expiry: String(Math.min(90, maxLifetimeDays)),
      customDate: "",
    },
    validators: { onSubmit: createSchema },
    // Errors sit next to their field; focus moves to the first one (after React shows them).
    onSubmitInvalid: () => focusFirstInvalid(formRef.current),
    onSubmit: async ({ value }) => {
      const expiresAt = agentTokenExpiry(
        value.expiry,
        value.customDate,
        Date.now(),
        maxLifetimeDays,
        allowNoExpiry,
      );
      if (expiresAt === undefined) return;
      const result = await create({
        name: value.name.trim(),
        ...value.access,
        expiresAt,
      }).catch(() => null);
      if (!result) return;
      onCreated(result.secret);
      void queryClient.invalidateQueries({ queryKey: orpc.access.agentTokens.list.key() });
    },
  });
  const now = Date.now();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const expirySummary = (expiry: string, customDate: string) => {
    const expiresAt = agentTokenExpiry(expiry, customDate, now, maxLifetimeDays, allowNoExpiry);
    if (expiresAt === undefined) return t("access:agents.summary.pickDate");
    if (expiresAt === null) return t("access:agents.summary.noExpiry");
    return t("access:agents.summary.expiresOn", {
      date: new Date(expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" }),
    });
  };
  return renderDialog(
    <form
      id={formId}
      ref={formRef}
      noValidate
      className="flex min-w-0 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.Field name="name">
        {(field) => (
          <div className="min-w-0 space-y-2 sm:max-w-md">
            <Label htmlFor={field.name} className="text-base font-semibold">
              {t("access:fields.name")}
            </Label>
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
      <form.Field name="access">
        {(field) => <AgentAccessChoice value={field.state.value} onChange={field.handleChange} />}
      </form.Field>
      <form.Field name="expiry">
        {(field) => (
          <fieldset className="@container min-w-0 space-y-2">
            <legend className="mb-2 text-base font-semibold">{t("access:fields.expiry")}</legend>
            <p className="text-xs text-muted-foreground">
              {t("access:agents.maxLifetime", { days: maxLifetimeDays })}
            </p>
            <div className="grid min-w-0 grid-cols-2 gap-2 @md:grid-cols-3">
              {[
                ...choices.map((days) => ({
                  value: String(days),
                  label: t("access:agents.expiryDays", { count: days }),
                })),
                { value: "custom", label: t("access:agents.customDate") },
                ...(allowNoExpiry ? [{ value: "never", label: t("access:agents.noExpiry") }] : []),
              ].map((choice) => (
                <Button
                  key={choice.value}
                  type="button"
                  size="touch"
                  variant="outline"
                  className="h-auto min-h-11 min-w-0 whitespace-normal py-2 aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:ring-1 aria-pressed:ring-primary dark:aria-pressed:border-primary dark:aria-pressed:bg-primary/15"
                  aria-pressed={field.state.value === choice.value}
                  onClick={() => field.handleChange(choice.value)}
                >
                  {choice.label}
                </Button>
              ))}
            </div>
            {field.state.value === "never" ? (
              <p className="text-xs text-muted-foreground">{t("access:agents.noExpiryHint")}</p>
            ) : null}
            {field.state.value === "custom" ? (
              <form.Field name="customDate">
                {(dateField) => (
                  <div className="min-w-0 space-y-2 sm:max-w-xs">
                    <Label htmlFor="agent-token-date">{t("access:agents.customDate")}</Label>
                    <Input
                      id="agent-token-date"
                      type="date"
                      className="min-h-11"
                      min={localDateInputValue(tomorrow)}
                      max={localDateInputValue(new Date(now + maxLifetimeDays * 86_400_000))}
                      value={dateField.state.value}
                      onBlur={dateField.handleBlur}
                      onChange={(event) => dateField.handleChange(event.target.value)}
                      aria-invalid={field.state.meta.errors.length > 0}
                      aria-describedby={
                        field.state.meta.errors.length > 0 ? "agent-token-expiry-error" : undefined
                      }
                    />
                  </div>
                )}
              </form.Field>
            ) : null}
            {field.state.meta.errors.length > 0 ? (
              <p id="agent-token-expiry-error" className="text-sm text-destructive">
                {t("access:agents.expiryInvalid", { days: maxLifetimeDays })}
              </p>
            ) : null}
          </fieldset>
        )}
      </form.Field>
    </form>,
    <form.Subscribe selector={(state) => state}>
      {({ isSubmitting, values }) => (
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p
            data-testid="agent-token-summary"
            className="min-w-0 text-sm break-words text-muted-foreground"
          >
            {agentAccessSummaryText(t, values.access)} ·{" "}
            {expirySummary(values.expiry, values.customDate)}
          </p>
          <div className="flex min-w-0 shrink-0 flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="touch"
              disabled={isSubmitting}
              onClick={onCancel}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" form={formId} size="touch" disabled={isSubmitting}>
              {isSubmitting ? t("access:agents.creating") : t("access:agents.create")}
            </Button>
          </div>
        </div>
      )}
    </form.Subscribe>,
  );
}
