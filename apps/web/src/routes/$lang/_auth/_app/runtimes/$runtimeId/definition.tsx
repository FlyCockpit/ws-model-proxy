import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { AdvancedSection, FormActionBar } from "@ws-model-proxy/ui/components/form-page";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { toast } from "@ws-model-proxy/ui/lib/toast";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";
import { InlineRetry } from "@/components/inline-retry";
import { RuntimeSpecFields } from "@/components/runtimes/runtime-spec-fields";
import { VersionHistory } from "@/components/runtimes/version-history";
import { StatusPill } from "@/components/status-pill";
import { SwitchRow } from "@/components/switch-row";
import { useAppForm } from "@/hooks/use-app-form";
import { rejectedDefinesWarning } from "@/lib/define-rejections";
import { focusFirstInvalid } from "@/lib/form-focus";
import { refusalText } from "@/lib/refusal-text";
import {
  editorValues,
  type RuntimeKind,
  readSpecEditor,
  type SpecEditorValues,
  sameSpec,
} from "@/lib/runtime-spec-draft";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/runtimes/$runtimeId/definition")({
  staticData: { pendingShape: "form" },
  component: RuntimeDefinitionPage,
});

type RuntimeDetail = Awaited<ReturnType<AppRouterClient["runtimes"]["get"]>>;

function RuntimeDefinitionPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { runtimeId } = Route.useParams();
  const runtime = useQuery(orpc.runtimes.get.queryOptions({ input: { runtimeId } }));

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
      {runtime.isSuccess ? <VersionHistory runtimeId={runtimeId} kind={runtime.data.kind} /> : null}
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
  const kind: RuntimeKind = runtime.kind;
  const messages = {
    notJson: t("dashboard:runtime.form.specNotJson"),
    wrongKind: t(`dashboard:runtime.specForm.wrongKind.${kind}`),
  };
  const schema = z
    .object({
      spec: z.custom<SpecEditorValues>(),
      note: z.string().max(500, t("dashboard:runtime.form.noteTooLong")),
      restartRunning: z.boolean(),
    })
    .superRefine((value, ctx) => {
      const reading = readSpecEditor(value.spec, kind, messages);
      if (!reading.ok)
        for (const issue of reading.issues)
          ctx.addIssue({ code: "custom", path: ["spec", ...issue.path], message: issue.message });
    });
  const formRef = useRef<HTMLFormElement>(null);
  const form = useAppForm({
    defaultValues: {
      spec: editorValues(runtime.current.spec, kind),
      note: "",
      restartRunning: false,
    },
    validators: { onSubmit: schema },
    onSubmitInvalid: () => focusFirstInvalid(formRef.current),
    onSubmit: async ({ value }) => {
      const reading = readSpecEditor(value.spec, kind, messages);
      if (!reading.ok) return;
      try {
        const result = await update.mutateAsync({
          runtimeId: runtime.id,
          spec: reading.spec,
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
        const rejected = rejectedDefinesWarning(t, result.define);
        if (rejected) toast.warning(rejected);
      } catch (error) {
        toast.error(refusalText(error));
      }
    },
  });
  return (
    <form
      ref={formRef}
      noValidate
      aria-labelledby="definition-title"
      className="flex min-w-0 flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <div className="min-w-0 space-y-1">
        <h2 id="definition-title" className="text-lg font-semibold">
          {t("dashboard:runtime.definition")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("dashboard:runtime.definitionHint")}</p>
      </div>
      <RuntimeSpecFields
        form={form}
        fields="spec"
        kind={kind}
        idPrefix="definition"
        advanced={
          <form.Subscribe selector={(state) => state.values.note}>
            {(note) => (
              <AdvancedSection
                gridClassName="lg:grid-cols-1"
                title={t("dashboard:runtime.form.versionNote")}
                summary={
                  note.trim()
                    ? t("dashboard:runtime.form.summaryNote")
                    : t("dashboard:runtime.form.summaryNoNote")
                }
              >
                <form.Field name="note">
                  {(field) => (
                    <div className="min-w-0 space-y-1.5">
                      <Label htmlFor="definition-note">{t("dashboard:runtime.form.note")}</Label>
                      <Input
                        id="definition-note"
                        className="h-11"
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                        aria-invalid={field.state.meta.errors.length > 0 || undefined}
                        aria-describedby={
                          field.state.meta.errors.length > 0 ? "definition-note-error" : undefined
                        }
                      />
                      {field.state.meta.errors.length > 0 ? (
                        <p id="definition-note-error" className="text-sm text-destructive">
                          {t("dashboard:runtime.form.noteTooLong")}
                        </p>
                      ) : null}
                    </div>
                  )}
                </form.Field>
              </AdvancedSection>
            )}
          </form.Subscribe>
        }
      />
      {kind === "STARTABLE" ? (
        <form.Field name="restartRunning">
          {(field) => (
            <SwitchRow
              id="definition-restart"
              label={t("dashboard:runtime.restartRunning")}
              description={t("dashboard:runtime.restartRunningHint")}
              checked={field.state.value}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
      ) : null}
      <form.Subscribe selector={(state) => state}>
        {({ isSubmitting, values }) => (
          <FormActionBar>
            <div className="min-w-0 basis-full text-sm break-words text-muted-foreground sm:mr-auto sm:basis-0 sm:flex-1">
              <EditHint runtime={runtime} spec={values.spec} messages={messages} />
            </div>
            <Button type="submit" size="touch" disabled={isSubmitting}>
              {isSubmitting ? t("common:actions.saving") : t("dashboard:runtime.saveVersion")}
            </Button>
          </FormActionBar>
        )}
      </form.Subscribe>
    </form>
  );
}

/**
 * Whether saving the edit applies live: a version with the same spec keeps the launch hash,
 * so running instances adopt it; any change to the spec is a new launch, which they only use
 * after a restart.
 */
function EditHint({
  runtime,
  spec,
  messages,
}: {
  runtime: RuntimeDetail;
  spec: SpecEditorValues;
  messages: { notJson: string; wrongKind: string };
}) {
  const { t } = useTranslation(["dashboard"]);
  const reading = readSpecEditor(spec, runtime.kind, messages);
  if (!reading.ok) return null;
  const live = sameSpec(reading.spec, runtime.current.spec);
  return (
    <p
      className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground"
      aria-live="polite"
    >
      <StatusPill tone={live ? "good" : "busy"}>
        {live ? t("dashboard:runtime.appliesLive") : t("dashboard:runtime.needsRestartBadge")}
      </StatusPill>
      <span className="min-w-0">
        {live
          ? t("dashboard:runtime.specForm.hintLive")
          : t(`dashboard:runtime.specForm.hintRestart.${runtime.kind}`)}
      </span>
    </p>
  );
}
