import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { runtimeSpecSchema } from "@ws-model-proxy/api/lib/runtime-spec";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { useTranslation } from "react-i18next";
import z from "zod";

import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/runtimes/$runtimeId/definition")({
  component: RuntimeDefinitionPage,
});

type RuntimeDetail = Awaited<ReturnType<AppRouterClient["runtimes"]["get"]>>;

function RuntimeDefinitionPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { runtimeId } = Route.useParams();
  const runtime = useQuery(orpc.runtimes.get.queryOptions({ input: { runtimeId } }));
  const versions = useQuery(orpc.runtimes.versions.list.queryOptions({ input: { runtimeId } }));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {runtime.isPending ? (
        <Skeleton className="h-96 w-full rounded-xl" aria-hidden="true" />
      ) : runtime.isError ? (
        <InlineRetry
          message={t("dashboard:runtime.loadFailed")}
          onRetry={() => runtime.refetch()}
        />
      ) : // The node owns a node-origin definition: the server refuses any change
      // to it (`launch_change_on_node_origin`), so it is shown read-only.
      runtime.data.origin === "NODE" ? (
        <NodeOriginDefinition runtime={runtime.data} />
      ) : (
        <DefinitionForm key={runtime.data.currentVersion.id} runtime={runtime.data} />
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("dashboard:runtime.versions")}</CardTitle>
          <CardDescription>{t("dashboard:runtime.versionsHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          {versions.isPending ? (
            <Skeleton className="h-24 w-full" aria-hidden="true" />
          ) : versions.isError ? (
            <InlineRetry onRetry={() => versions.refetch()} />
          ) : (
            <ul className="flex min-w-0 flex-col divide-y">
              {versions.data.items.map((version) => (
                <li key={version.id} className="flex min-w-0 flex-wrap items-center gap-2 py-2">
                  <span className="font-mono text-sm">v{version.version}</span>
                  <StatusPill tone={version.editor.actor === "AGENT" ? "info" : "muted"}>
                    {t(`dashboard:runtime.editor.${version.editor.actor}`)}
                  </StatusPill>
                  {version.launchChanged ? (
                    <StatusPill tone="busy">{t("dashboard:runtime.needsRestartBadge")}</StatusPill>
                  ) : (
                    <StatusPill tone="good">{t("dashboard:runtime.appliesLive")}</StatusPill>
                  )}
                  <span className="text-xs text-muted-foreground">
                    <TimeAgo value={version.createdAt} />
                  </span>
                  {version.note ? (
                    <span className="min-w-0 basis-full break-words text-sm text-muted-foreground">
                      {version.note}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function NodeOriginDefinition({ runtime }: { runtime: RuntimeDetail }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:runtime.definition")}</CardTitle>
        <CardDescription id="definition-node-origin">
          <span className="block font-medium text-foreground">
            {t("dashboard:runtime.nodeOrigin")}
          </span>
          {t("dashboard:runtime.nodeOriginHint")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1.5">
          <Label htmlFor="definition-spec">{t("dashboard:runtime.form.spec")}</Label>
          <Textarea
            id="definition-spec"
            rows={22}
            readOnly
            spellCheck={false}
            aria-describedby="definition-node-origin"
            className="bg-muted/50 font-mono text-xs"
            value={JSON.stringify(runtime.current.spec, null, 2)}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function DefinitionForm({ runtime }: { runtime: RuntimeDetail }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const update = useMutation({
    ...orpc.runtimes.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const schema = z.object({
    spec: z.string().superRefine((text, ctx) => {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        ctx.addIssue({ code: "custom", message: t("dashboard:runtime.form.specNotJson") });
        return;
      }
      const parsed = runtimeSpecSchema.safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        ctx.addIssue({
          code: "custom",
          message: t("dashboard:runtime.form.specInvalid", {
            path: issue?.path.join(".") || "spec",
            detail: issue?.message ?? "",
          }),
        });
      }
    }),
    note: z.string().max(500),
    restartRunning: z.boolean(),
  });
  const form = useForm({
    defaultValues: {
      spec: JSON.stringify(runtime.current.spec, null, 2),
      note: "",
      restartRunning: false,
    },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      try {
        const result = await update.mutateAsync({
          runtimeId: runtime.id,
          spec: runtimeSpecSchema.parse(JSON.parse(value.spec)),
          ...(value.note.trim() ? { note: value.note.trim() } : {}),
          restartRunning: value.restartRunning,
        });
        await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
        await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
        await queryClient.invalidateQueries({ queryKey: orpc.models.key() });
        toast.success(
          t("dashboard:runtime.savedVersion", {
            version: result.version.version,
            live: result.adoptedLive.length,
            restart: result.needsRestart.length,
          }),
        );
        if (result.warnings.includes("binds_all_interfaces"))
          toast.warning(t("dashboard:runtime.bindsAllInterfaces"));
      } catch (error) {
        toast.error(refusalText(error));
      }
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:runtime.definition")}</CardTitle>
        <CardDescription>{t("dashboard:runtime.definitionHint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit();
          }}
        >
          <form.Field name="spec">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="definition-spec">{t("dashboard:runtime.form.spec")}</Label>
                <Textarea
                  id="definition-spec"
                  rows={22}
                  spellCheck={false}
                  className="font-mono text-xs"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldErrors field={field} />
              </div>
            )}
          </form.Field>
          <form.Field name="note">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="definition-note">{t("dashboard:runtime.form.note")}</Label>
                <Input
                  id="definition-note"
                  className="h-11"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </div>
            )}
          </form.Field>
          {runtime.kind === "STARTABLE" ? (
            <form.Field name="restartRunning">
              {(field) => (
                <div className="flex min-h-11 items-center gap-3">
                  <Checkbox
                    id="definition-restart"
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked === true)}
                  />
                  <Label htmlFor="definition-restart">
                    {t("dashboard:runtime.restartRunning")}
                  </Label>
                </div>
              )}
            </form.Field>
          ) : null}
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(submitting) => (
              <Button type="submit" size="touch" disabled={submitting}>
                {submitting ? t("common:actions.saving") : t("dashboard:runtime.saveVersion")}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </CardContent>
    </Card>
  );
}
