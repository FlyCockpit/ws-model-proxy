import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deploymentSpecSchema, isHiddenCodePoint } from "@ws-model-proxy/api/lib/deployment-spec";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@ws-model-proxy/ui/components/alert-dialog";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { useAuthSession } from "@/hooks/use-auth-session";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

function parseSpec(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
/** Points every variant's attachment at `poolId`, the only pool the server accepts. */
export function withAttachmentPool(text: string, poolId: string) {
  const spec = parseSpec(text);
  if (!spec || typeof spec !== "object" || !("variants" in spec) || !Array.isArray(spec.variants))
    return text;
  const variants = spec.variants.map((variant: unknown) =>
    variant &&
    typeof variant === "object" &&
    "attachment" in variant &&
    variant.attachment &&
    typeof variant.attachment === "object"
      ? { ...variant, attachment: { ...variant.attachment, poolId } }
      : variant,
  );
  return JSON.stringify({ ...spec, variants }, null, 2);
}
export const recipeJsonSchema = z
  .string()
  .max(1_000_000)
  .refine((text) => deploymentSpecSchema.safeParse(parseSpec(text)).success);

export function DeploymentsPage() {
  const { t } = useTranslation("dashboard");
  const [configCursor, setConfigCursor] = useState<string | undefined>();
  const [instanceCursor, setInstanceCursor] = useState<string | undefined>();
  const [pendingCursor, setPendingCursor] = useState<string | undefined>();
  const configs = useQuery(
    orpc.deployments.listConfigs.queryOptions({ input: { cursor: configCursor, limit: 50 } }),
  );
  const instances = useQuery(
    orpc.deployments.listInstances.queryOptions({
      input: { cursor: instanceCursor, limit: 50 },
      refetchInterval: 5000,
    }),
  );
  const pending = useQuery(
    orpc.deployments.pendingPlans.queryOptions({
      input: { cursor: pendingCursor, limit: 50 },
      refetchInterval: 5000,
    }),
  );
  const devices = useQuery(orpc.forwarderManagement.listCliDevices.queryOptions());
  const [editId, setEditId] = useState<string | null>(null);
  const selected = useQuery(
    orpc.deployments.getConfig.queryOptions({
      input: { id: editId ?? "" },
      enabled: editId !== null,
    }),
  );
  const [planId, setPlanId] = useState<string | null>(null);
  const planIntent = useRef(0);
  const beginPlan = () => {
    const intent = ++planIntent.current;
    return (id: string) => {
      if (intent === planIntent.current) setPlanId(id);
    };
  };
  const selectPlan = (id: string) => beginPlan()(id);
  const stop = useMutation(orpc.deployments.planStop.mutationOptions());
  const preempt = useMutation(orpc.deployments.setAgentsMayPreempt.mutationOptions());
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.deployments.key() });
  return (
    <section className="min-w-0 max-w-full space-y-6">
      <h1 className="text-2xl font-semibold">{t("deployments.title")}</h1>
      <p className="text-sm text-muted-foreground">{t("deployments.description")}</p>
      {configs.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : configs.isError ? (
        <p role="alert">{friendly(configs.error, t("deployments.failed"))}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="touch" variant="outline" onClick={() => setEditId(null)}>
            {t("deployments.newRecipe")}
          </Button>
          {configs.data?.items.map((config) => (
            <Button
              key={config.id}
              size="touch"
              variant="outline"
              onClick={() => setEditId(config.id)}
            >
              {config.name} · {config.Revisions[0]?.revision}
              {config.poolId ? null : ` · ${t("deployments.detachedLabel")}`}
            </Button>
          ))}
        </div>
      )}
      <PageButtons
        cursor={configCursor}
        next={configs.data?.nextCursor}
        setCursor={setConfigCursor}
      />
      {editId && selected.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : !editId || selected.data ? (
        <RecipeEditor
          key={selected.data?.id ?? "new"}
          config={editId ? selected.data : undefined}
          onSaved={() => {
            void refresh();
          }}
          onDeleted={() => {
            setEditId(null);
            void refresh();
          }}
        />
      ) : (
        <p role="alert">{t("deployments.failed")}</p>
      )}
      <StartPlanForm configs={configs.data?.items ?? []} beginPlan={beginPlan} />
      {planId ? (
        <PlanPreview
          key={planId}
          planId={planId}
          onApplied={() => {
            setPlanId((current) => (current === planId ? null : current));
            void refresh();
          }}
        />
      ) : null}
      <h2 className="text-xl font-semibold">{t("deployments.pending")}</h2>
      {pending.isError ? (
        <p role="alert">{t("deployments.failed")}</p>
      ) : pending.data?.items.length ? (
        pending.data.items.map((plan) => (
          <Button key={plan.id} size="touch" variant="outline" onClick={() => selectPlan(plan.id)}>
            {t("deployments.reviewPlan")} · {plan.id}
          </Button>
        ))
      ) : (
        <p>{t("deployments.none")}</p>
      )}
      <PageButtons
        cursor={pendingCursor}
        next={pending.data?.nextCursor}
        setCursor={setPendingCursor}
      />
      <h2 className="text-xl font-semibold">{t("deployments.instances")}</h2>
      {instances.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : instances.isError ? (
        <p role="alert">{t("deployments.failed")}</p>
      ) : (
        <ul className="space-y-3">
          {instances.data?.items.map((instance) => (
            <li key={instance.id} className="min-w-0 space-y-2 rounded-md border p-4">
              <p className="break-words font-medium">
                {instance.endpointSlug} · {t(`deployments.states.${instance.observedState}`)} ·{" "}
                {t(`deployments.states.${instance.desiredState}`)}
              </p>
              <ul className="text-sm">
                {instance.Nodes.map((node) => (
                  <li key={node.id} className="break-words">
                    {t("deployments.rankClaim", {
                      rank: node.rank,
                      node: node.cliDeviceId,
                      port: node.port,
                      held: t(node.claimHeld ? "deployments.yes" : "deployments.no"),
                    })}{" "}
                    <code>{JSON.stringify(node.resources)}</code>
                  </li>
                ))}
              </ul>
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  checked={instance.agentsMayPreempt}
                  disabled={preempt.isPending}
                  onChange={(event) =>
                    preempt.mutate(
                      { instanceId: instance.id, allow: event.target.checked },
                      {
                        onSuccess: () => {
                          void refresh();
                        },
                      },
                    )
                  }
                />
                {t("deployments.agentsMayPreempt")}
              </label>
              <Button
                size="touch"
                variant="outline"
                disabled={stop.isPending || instance.desiredState === "STOPPED"}
                onClick={() => {
                  const acceptPlan = beginPlan();
                  stop.mutate(
                    { instanceId: instance.id },
                    { onSuccess: (plan) => acceptPlan(plan.id) },
                  );
                }}
              >
                {t("deployments.planStop")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <PageButtons
        cursor={instanceCursor}
        next={instances.data?.nextCursor}
        setCursor={setInstanceCursor}
      />
      {stop.isError || preempt.isError ? <p role="alert">{t("deployments.failed")}</p> : null}
      <h2 className="text-xl font-semibold">{t("deployments.nodeGrants")}</h2>
      <p>{t("deployments.nodeGrantHint")}</p>
      {devices.data?.map((device) => (
        <NodeGrantForm key={device.id} device={device} />
      ))}
      <ContributionsSection devices={devices.data ?? []} />
    </section>
  );
}

type Config = Awaited<ReturnType<AppRouterClient["deployments"]["getConfig"]>>;
type Device = Awaited<ReturnType<AppRouterClient["forwarderManagement"]["listCliDevices"]>>[number];
type ConfigSummary = Awaited<
  ReturnType<AppRouterClient["deployments"]["listConfigs"]>
>["items"][number];

function PageButtons({
  cursor,
  next,
  setCursor,
}: {
  cursor?: string;
  next?: string | null;
  setCursor: (cursor?: string) => void;
}) {
  const { t } = useTranslation("dashboard");
  return (
    <div className="flex gap-2">
      <Button
        size="touch"
        variant="outline"
        disabled={!cursor}
        onClick={() => setCursor(undefined)}
      >
        {t("deployments.firstPage")}
      </Button>
      <Button
        size="touch"
        variant="outline"
        disabled={!next}
        onClick={() => setCursor(next ?? undefined)}
      >
        {t("deployments.nextPage")}
      </Button>
    </div>
  );
}

function RecipeEditor({
  config,
  onSaved,
  onDeleted,
}: {
  config?: Config;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation("dashboard");
  const pools = useQuery(orpc.forwarderManagement.listModelPools.queryOptions());
  const create = useMutation(orpc.deployments.createConfig.mutationOptions());
  const update = useMutation(orpc.deployments.updateConfig.mutationOptions());
  const remove = useMutation(orpc.deployments.deleteConfig.mutationOptions());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const latest = config?.Revisions[0];
  // The edit base is captured with the draft, not advanced by background
  // refetches. Only our successful save advances optimistic concurrency.
  const [expectedRevision, setExpectedRevision] = useState(latest?.revision ?? 1);
  const baseId = useId();
  const schema = z.object({
    name: z.string().min(1).max(128),
    slug: config ? z.string() : z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
    poolId: z.string().min(1),
    spec: recipeJsonSchema,
  });
  const form = useForm({
    defaultValues: {
      name: config?.name ?? "",
      slug: config?.slug ?? "",
      poolId: config?.poolId ?? "",
      spec: latest ? JSON.stringify(latest.spec, null, 2) : '{"variants": []}',
    },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const spec = deploymentSpecSchema.parse(parseSpec(value.spec));
      try {
        if (config && latest) {
          const revision = await update.mutateAsync({
            id: config.id,
            expectedRevision,
            name: value.name,
            // Moving a recipe (or rebinding one whose pool was deleted) needs its deployments stopped.
            ...(value.poolId !== config.poolId ? { poolId: value.poolId } : {}),
            spec,
          });
          setExpectedRevision(revision.revision);
        } else
          await create.mutateAsync({
            name: value.name,
            slug: value.slug,
            poolId: value.poolId,
            spec,
          });
        onSaved();
      } catch {
        /* mutation state retains the draft */
      }
    },
  });
  return (
    <form
      className="min-w-0 space-y-3 rounded-md border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <h2 className="text-xl font-semibold">{t("deployments.recipe")}</h2>
      <p className="text-sm text-muted-foreground">{t("deployments.recipeHint")}</p>
      {config && !config.poolId ? <p role="note">{t("deployments.recipeDetached")}</p> : null}
      {(["name", "slug"] as const).map((name) => (
        <form.Field key={name} name={name}>
          {(field) => (
            <div>
              <Label htmlFor={`${baseId}-${name}`}>{t(`deployments.${name}`)}</Label>
              <Input
                id={`${baseId}-${name}`}
                className="min-h-11"
                value={field.state.value}
                disabled={name === "slug" && !!config}
                onChange={(event) => field.handleChange(event.target.value)}
                aria-invalid={field.state.meta.errors.length > 0}
              />
              {field.state.meta.errors.length ? (
                <p role="alert">{t("deployments.invalid")}</p>
              ) : null}
            </div>
          )}
        </form.Field>
      ))}
      <form.Field name="poolId">
        {(field) => (
          <div>
            <Label htmlFor={`${baseId}-pool`}>{t("deployments.pool")}</Label>
            <select
              id={`${baseId}-pool`}
              className="min-h-11 w-full rounded-md border bg-background p-2"
              value={field.state.value}
              onChange={(event) => {
                field.handleChange(event.target.value);
                if (event.target.value)
                  form.setFieldValue(
                    "spec",
                    withAttachmentPool(form.getFieldValue("spec"), event.target.value),
                  );
              }}
            >
              <option value="">{t("deployments.choose")}</option>
              {pools.data?.map((pool) => (
                <option key={pool.id} value={pool.id}>
                  {pool.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </form.Field>
      <form.Field name="spec">
        {(field) => (
          <div>
            <Label htmlFor={`${baseId}-spec`}>{t("deployments.spec")}</Label>
            <textarea
              id={`${baseId}-spec`}
              rows={16}
              className="w-full min-w-0 rounded-md border bg-background p-3 font-mono text-sm"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              aria-invalid={field.state.meta.errors.length > 0}
              aria-describedby={`${baseId}-spec-help`}
            />
            <p id={`${baseId}-spec-help`} className="text-sm">
              {t("deployments.specHint")}
            </p>
            {field.state.meta.errors.length ? (
              <p role="alert">{t("deployments.invalidSpec")}</p>
            ) : null}
          </div>
        )}
      </form.Field>
      <div className="flex flex-wrap gap-2">
        <Button size="touch" type="submit" disabled={create.isPending || update.isPending}>
          {t("deployments.saveRecipe")}
        </Button>
        {config ? (
          <Button
            size="touch"
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => setDeleteOpen(true)}
          >
            {t("deployments.deleteRecipe")}
          </Button>
        ) : null}
      </div>
      {create.isError || update.isError || remove.isError ? (
        <p role="alert">
          {friendly(create.error ?? update.error ?? remove.error, t("deployments.failed"))}
        </p>
      ) : null}
      {config ? (
        <ConfirmDeleteDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={t("deployments.deleteRecipeTitle")}
          description={t("deployments.deleteRecipeDescription")}
          confirmToken={config.slug}
          typePrompt={t("deployments.deleteRecipePrompt")}
          copyAriaLabel={t("actions.copyConfirm")}
          isPending={remove.isPending}
          onConfirm={() =>
            remove.mutate(
              { id: config.id },
              {
                onSuccess: () => {
                  setDeleteOpen(false);
                  onDeleted();
                },
                onError: () => setDeleteOpen(false),
              },
            )
          }
        />
      ) : null}
    </form>
  );
}

function StartPlanForm({
  configs,
  beginPlan,
}: {
  configs: ConfigSummary[];
  beginPlan: () => (id: string) => void;
}) {
  const { t } = useTranslation("dashboard");
  const id = useId();
  const start = useMutation(orpc.deployments.planStart.mutationOptions());
  const form = useForm({
    defaultValues: { revisionId: "", variantKey: "", groupCount: "1", nodeIds: "" },
    validators: {
      onSubmit: z.object({
        revisionId: z.string().min(1),
        variantKey: z.string().min(1),
        groupCount: z
          .string()
          .regex(/^\d+$/)
          .refine((s) => Number(s) >= 1 && Number(s) <= 64),
        nodeIds: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      const acceptPlan = beginPlan();
      try {
        const plan = await start.mutateAsync({
          revisionId: value.revisionId,
          variantKey: value.variantKey,
          groupCount: Number(value.groupCount),
          ...(value.nodeIds.trim() ? { nodeIds: value.nodeIds.trim().split(/[\s,]+/) } : {}),
        });
        acceptPlan(plan.id);
      } catch {
        /* retain input */
      }
    },
  });
  return (
    <form
      className="space-y-3 rounded-md border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <h2 className="text-xl font-semibold">{t("deployments.planStart")}</h2>
      <form.Field name="revisionId">
        {(field) => (
          <div>
            <Label htmlFor={`${id}-revision`}>{t("deployments.revision")}</Label>
            <select
              id={`${id}-revision`}
              className="min-h-11 w-full rounded-md border bg-background p-2"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
            >
              <option value="">{t("deployments.choose")}</option>
              {configs.map((config) =>
                config.Revisions[0] ? (
                  <option key={config.id} value={config.Revisions[0].id}>
                    {config.name} · {config.Revisions[0].revision}
                  </option>
                ) : null,
              )}
            </select>
            {field.state.meta.errors.length ? <p role="alert">{t("deployments.invalid")}</p> : null}
          </div>
        )}
      </form.Field>
      {(["variantKey", "groupCount", "nodeIds"] as const).map((name) => (
        <form.Field key={name} name={name}>
          {(field) => (
            <div>
              <Label htmlFor={`${id}-${name}`}>{t(`deployments.${name}`)}</Label>
              <Input
                id={`${id}-${name}`}
                className="min-h-11"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              {field.state.meta.errors.length ? (
                <p role="alert">{t("deployments.invalid")}</p>
              ) : null}
            </div>
          )}
        </form.Field>
      ))}
      <p className="text-sm">{t("deployments.placementHint")}</p>
      <Button type="submit" size="touch" disabled={start.isPending}>
        {t("deployments.preview")}
      </Button>
      {start.isError ? <p role="alert">{friendly(start.error, t("deployments.failed"))}</p> : null}
    </form>
  );
}

/**
 * JSON for human review with every invisible or reordering character shown as
 * an escape, so what is read is exactly what runs.
 */
function reviewText(value: unknown): string {
  let text = "";
  for (const char of JSON.stringify(value, null, 2) ?? "") {
    const codePoint = char.codePointAt(0) ?? 0;
    text += isHiddenCodePoint(codePoint) ? `\\u{${codePoint.toString(16)}}` : char;
  }
  return text;
}

function PlanPreview({ planId, onApplied }: { planId: string; onApplied: () => void }) {
  const { t } = useTranslation("dashboard");
  const plan = useQuery(orpc.deployments.planStatus.queryOptions({ input: { id: planId } }));
  const contents = plan.data?.contents;
  const parsed = z
    .object({
      action: z.string(),
      stopIds: z.array(z.string()),
      affectedNodeIds: z.array(z.string()),
      start: z.object({ revisionId: z.string(), variantKey: z.string() }).optional(),
    })
    .safeParse(contents);
  const confirm = useMutation(
    orpc.deployments.confirmPlan.mutationOptions({ onSuccess: onApplied }),
  );
  const [accepted, setAccepted] = useState(false);
  const [confirmStops, setConfirmStops] = useState(false);
  const ready = !!plan.data && parsed.success;
  // Starting here would stop deployments that are running now: the person
  // confirms that explicitly, naming each one, single- or multi-node alike.
  const stopsRunning =
    parsed.success && parsed.data.action === "start" && parsed.data.stopIds.length > 0;
  const variant = plan.data?.preview.start;
  const commandsReady =
    ready &&
    (!parsed.success || !parsed.data.start || !!variant) &&
    plan.data?.preview.stopped.every((instance) => !!instance.variant);
  return (
    <section className="min-w-0 space-y-3 rounded-md border border-destructive p-4">
      <h2 className="text-xl font-semibold">{t("deployments.reviewPlan")}</h2>
      <p>{t("deployments.destructiveHint")}</p>
      {plan.isError ? (
        <p role="alert">{friendly(plan.error, t("deployments.failed"))}</p>
      ) : !ready ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <>
          <p className="break-words">
            {t("deployments.affectedNodes")}:{" "}
            {parsed.success ? parsed.data.affectedNodeIds.join(", ") : ""}
          </p>
          <p className="break-words">
            {t("deployments.stoppedGroups")}: {parsed.success ? parsed.data.stopIds.join(", ") : ""}
          </p>
          <pre className="min-w-0 whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
            {reviewText(contents)}
          </pre>
          {plan.data?.preview.agentEdited ? (
            <p
              role="note"
              className="rounded-md border border-state-warning/40 bg-state-warning/10 p-3 text-sm"
            >
              {t("deployments.agentEditedRevision")}
            </p>
          ) : null}
          <h3 className="font-medium">{t("deployments.commands")}</h3>
          {variant ? (
            <pre className="whitespace-pre-wrap break-all text-xs">
              {reviewText(variant.commands)}
            </pre>
          ) : null}
          {plan.data?.preview.stopped.map((instance) => (
            <div key={instance.id}>
              <p>{instance.endpointSlug}</p>
              <pre className="whitespace-pre-wrap break-all text-xs">
                {reviewText({ nodes: instance.nodes, commands: instance.variant?.commands })}
              </pre>
            </div>
          ))}
        </>
      )}
      <label className="flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
        />
        {t("deployments.confirmHint")}
      </label>
      <Button
        size="touch"
        variant="destructive"
        disabled={
          !commandsReady || !accepted || confirm.isPending || plan.data?.state === "APPLIED"
        }
        onClick={() => (stopsRunning ? setConfirmStops(true) : confirm.mutate({ planId }))}
      >
        {t("deployments.confirm")}
      </Button>
      <AlertDialog open={confirmStops} onOpenChange={setConfirmStops}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)]! sm:max-w-md! data-[size=default]:max-w-[calc(100%-2rem)]! data-[size=default]:sm:max-w-md! data-[size=sm]:max-w-[calc(100%-2rem)]! data-[size=sm]:sm:max-w-md!">
          <AlertDialogHeader>
            <AlertDialogTitle className="min-w-0 break-words">
              {t("deployments.preemptTitle", { count: plan.data?.preview.stopped.length ?? 0 })}
            </AlertDialogTitle>
            <AlertDialogDescription className="min-w-0 max-w-full break-words">
              {t("deployments.preemptBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="min-w-0 space-y-1 text-sm" data-testid="preempted-deployments">
            {plan.data?.preview.stopped.map((instance) => (
              <li key={instance.id} className="min-w-0 break-all font-mono">
                {instance.endpointSlug}
                <span className="ml-2 font-sans text-muted-foreground">
                  {t("deployments.preemptNodes", { count: instance.nodes.length })}
                </span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter className="sm:flex-wrap">
            <AlertDialogCancel className="min-h-[44px] w-full sm:w-auto">
              {t("deployments.preemptCancel", { count: plan.data?.preview.stopped.length ?? 0 })}
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-[44px] w-full sm:w-auto"
              variant="destructive"
              disabled={confirm.isPending}
              onClick={() => {
                setConfirmStops(false);
                confirm.mutate({ planId });
              }}
            >
              {t("deployments.preemptConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {plan.isError || confirm.isError ? (
        <p role="alert">{friendly(plan.error ?? confirm.error, t("deployments.failed"))}</p>
      ) : null}
    </section>
  );
}

function NodeGrantForm({ device }: { device: Device }) {
  const { t } = useTranslation("dashboard");
  const id = useId();
  const queryClient = useQueryClient();
  const grant = useMutation(
    orpc.deployments.setNodeGrant.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
      },
    }),
  );
  const form = useForm({
    defaultValues: {
      allow: device.deployment.allow,
      portStart: String(device.deployment.portStart),
      portEnd: String(device.deployment.portEnd),
    },
    validators: {
      onSubmit: z
        .object({
          allow: z.boolean(),
          portStart: z.string().regex(/^\d+$/),
          portEnd: z.string().regex(/^\d+$/),
        })
        .refine(
          (v) =>
            Number(v.portStart) >= 1024 &&
            Number(v.portEnd) <= 65535 &&
            Number(v.portStart) <= Number(v.portEnd),
        ),
    },
    onSubmit: async ({ value }) => {
      await grant
        .mutateAsync({
          nodeId: device.id,
          allow: value.allow,
          portStart: Number(value.portStart),
          portEnd: Number(value.portEnd),
        })
        .catch(() => undefined);
    },
  });
  return (
    <form
      className="space-y-2 rounded-md border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <h3 className="font-medium">{device.displayName}</h3>
      <p className="text-sm">
        {t("deployments.reported", {
          supported: t(
            device.deployment.reported === null
              ? "deployments.unknown"
              : device.deployment.reported
                ? "deployments.yes"
                : "deployments.no",
          ),
          mode: t(`deployments.modes.${device.features.commands.effectiveMode}`),
        })}
      </p>
      <form.Field name="allow">
        {(field) => (
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={field.state.value}
              onChange={(event) => field.handleChange(event.target.checked)}
            />
            {t("deployments.allow")}
          </label>
        )}
      </form.Field>
      {(["portStart", "portEnd"] as const).map((name) => (
        <form.Field key={name} name={name}>
          {(field) => (
            <div>
              <Label htmlFor={`${id}-${name}`}>{t(`deployments.${name}`)}</Label>
              <Input
                id={`${id}-${name}`}
                className="min-h-11"
                inputMode="numeric"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </div>
          )}
        </form.Field>
      ))}
      <form.Subscribe selector={(state) => state.errors}>
        {(errors) => (errors.length ? <p role="alert">{t("deployments.invalid")}</p> : null)}
      </form.Subscribe>
      <Button type="submit" size="touch" disabled={grant.isPending}>
        {t("deployments.saveGrant")}
      </Button>
      {grant.isError ? <p role="alert">{friendly(grant.error, t("deployments.failed"))}</p> : null}
    </form>
  );
}

function ContributionsSection({ devices }: { devices: Device[] }) {
  const { t } = useTranslation("dashboard");
  const session = useAuthSession();
  const userId = session.state.session?.user.id;
  const [cursor, setCursor] = useState<string | undefined>();
  const offers = useQuery(
    orpc.inferenceContributions.list.queryOptions({
      input: { limit: 50, ...(cursor ? { cursor } : {}) },
    }),
  );
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: orpc.inferenceContributions.key() });
  const offer = useMutation(
    orpc.inferenceContributions.offer.mutationOptions({
      onSuccess: () => {
        void refresh();
      },
    }),
  );
  const accept = useMutation(
    orpc.inferenceContributions.accept.mutationOptions({
      onSuccess: () => {
        void refresh();
      },
    }),
  );
  const revoke = useMutation(
    orpc.inferenceContributions.revoke.mutationOptions({
      onSuccess: () => {
        void refresh();
      },
    }),
  );
  const id = useId();
  const form = useForm({
    defaultValues: { poolId: "", discoveredModelId: "" },
    validators: {
      onSubmit: z.object({ poolId: z.string().min(1), discoveredModelId: z.string().min(1) }),
    },
    onSubmit: async ({ value }) => {
      await offer.mutateAsync(value).catch(() => undefined);
    },
  });
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">{t("deployments.contributions")}</h2>
      <p>{t("deployments.contributionHint")}</p>
      <form
        className="space-y-2 rounded-md border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="poolId">
          {(field) => (
            <div>
              <Label htmlFor={`${id}-pool`}>{t("deployments.friendPoolId")}</Label>
              <Input
                id={`${id}-pool`}
                className="min-h-11"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </div>
          )}
        </form.Field>
        <form.Field name="discoveredModelId">
          {(field) => (
            <div>
              <Label htmlFor={`${id}-model`}>{t("deployments.ownModel")}</Label>
              <select
                id={`${id}-model`}
                className="min-h-11 w-full rounded-md border bg-background p-2"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              >
                <option value="">{t("deployments.choose")}</option>
                {devices.flatMap((device) =>
                  device.endpoints.flatMap((endpoint) =>
                    endpoint.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {device.displayName} / {endpoint.slug} / {model.upstreamModelId}
                      </option>
                    )),
                  ),
                )}
              </select>
            </div>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.errors}>
          {(errors) => (errors.length ? <p role="alert">{t("deployments.invalid")}</p> : null)}
        </form.Subscribe>
        <Button type="submit" size="touch" disabled={offer.isPending}>
          {t("deployments.offer")}
        </Button>
      </form>
      {offers.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <ul className="space-y-2">
          {offers.data?.map((row) => (
            <li key={row.id} className="space-y-2 rounded-md border p-3">
              <p className="break-words">
                {row.poolId} / {row.discoveredModelId} · {t(`deployments.states.${row.state}`)}
              </p>
              {row.state === "PENDING" && row.poolOwnerUserId === userId ? (
                <Button
                  size="touch"
                  disabled={accept.isPending}
                  onClick={() => accept.mutate({ id: row.id })}
                >
                  {t("deployments.accept")}
                </Button>
              ) : null}
              {row.state !== "REVOKED" ? (
                <Button
                  size="touch"
                  variant="outline"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate({ id: row.id })}
                >
                  {t("deployments.revoke")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button
          size="touch"
          variant="outline"
          disabled={!cursor}
          onClick={() => setCursor(undefined)}
        >
          {t("deployments.firstPage")}
        </Button>
        <Button
          size="touch"
          variant="outline"
          disabled={offers.data?.length !== 50}
          onClick={() => setCursor(offers.data?.at(-1)?.id)}
        >
          {t("deployments.nextPage")}
        </Button>
      </div>
      {offers.isError || offer.isError || accept.isError || revoke.isError ? (
        <p role="alert">
          {friendly(
            offers.error ?? offer.error ?? accept.error ?? revoke.error,
            t("deployments.failed"),
          )}
        </p>
      ) : null}
    </section>
  );
}
