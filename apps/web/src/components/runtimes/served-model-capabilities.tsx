import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { openAiCompatibleCapabilitiesSchema } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import { MODEL_CAPABILITIES, type ModelCapabilityWire } from "@ws-model-proxy/api/lib/runtime-spec";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { CapabilityChecks } from "@/components/runtimes/runtime-spec-fields";
import { StatusPill } from "@/components/status-pill";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

type ServedModel = Awaited<ReturnType<AppRouterClient["runtimes"]["get"]>>["servedModels"][number];
type Capability = ServedModel["capabilities"][number];

const toWire = (capability: Capability) => capability.toLowerCase() as ModelCapabilityWire;
const fromWire = (capability: ModelCapabilityWire) => capability.toUpperCase() as Capability;

/**
 * A served model's capabilities: what the node detected, or the owner's override. People set
 * the override here; "Use detected" returns to what the node reports.
 */
export function ServedModelCapabilities({ model }: { model: ServedModel }) {
  const { t } = useTranslation(["dashboard"]);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">
        {t("dashboard:runtime.capabilities.title")}
      </span>
      {model.capabilities.length === 0 ? (
        <span className="text-sm text-muted-foreground">
          {t("dashboard:runtime.capabilities.none")}
        </span>
      ) : (
        model.capabilities.map((capability) => (
          <StatusPill key={capability} tone="muted">
            {t(`dashboard:runtime.capabilities.values.${toWire(capability)}`)}
          </StatusPill>
        ))
      )}
      <StatusPill tone={model.capabilitiesOverridden ? "info" : "muted"}>
        {model.capabilitiesOverridden
          ? t("dashboard:runtime.capabilities.overridden")
          : t("dashboard:runtime.capabilities.detected")}
      </StatusPill>
      <Button type="button" variant="ghost" size="touch" onClick={() => setOpen(true)}>
        {t("dashboard:runtime.capabilities.change")}
      </Button>
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title={t("dashboard:runtime.capabilities.dialogTitle", { model: model.upstreamModelId })}
        description={t("dashboard:runtime.capabilities.dialogHint")}
      >
        {open ? (
          <div className="flex flex-col gap-6">
            <CapabilityForm model={model} onDone={() => setOpen(false)} />
            <CapabilityMetadataForm model={model} />
          </div>
        ) : null}
      </ResponsiveDialog>
    </div>
  );
}

function CapabilityMetadataForm({ model }: { model: ServedModel }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const metadata = useMutation({
    ...orpc.runtimes.models.setCapabilityMetadata.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const [value, setValue] = useState(() =>
    JSON.stringify(model.capabilityMetadata ?? model.detectedCapabilityMetadata ?? {}, null, 2),
  );
  const save = async (capabilityMetadata: unknown | null) => {
    try {
      await metadata.mutateAsync({
        runtimeModelId: model.id,
        capabilityMetadata: capabilityMetadata as ServedModel["capabilityMetadata"],
      });
      await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
      await queryClient.invalidateQueries({ queryKey: orpc.models.key() });
      toast.success(t("dashboard:runtime.capabilities.saved"));
    } catch (error) {
      toast.error(refusalText(error));
    }
  };
  return (
    <form
      className="flex min-w-0 flex-col gap-3 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          toast.error(t("dashboard:runtime.capabilities.metadataInvalid"));
          return;
        }
        const result = openAiCompatibleCapabilitiesSchema.safeParse(parsed);
        if (!result.success) {
          toast.error(t("dashboard:runtime.capabilities.metadataInvalid"));
          return;
        }
        void save(result.data);
      }}
    >
      <label htmlFor={`capability-metadata-${model.id}`} className="text-sm font-medium">
        {t("dashboard:runtime.capabilities.metadataTitle")}
      </label>
      <p className="text-sm text-muted-foreground">
        {t("dashboard:runtime.capabilities.metadataHint")}
      </p>
      <Textarea
        id={`capability-metadata-${model.id}`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={10}
        spellCheck={false}
        className="font-mono text-xs"
      />
      <div className="flex justify-end gap-2">
        {model.capabilityMetadataOverridden ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={metadata.isPending}
            onClick={() => void save(null)}
          >
            {t("dashboard:runtime.capabilities.useDetectedMetadata")}
          </Button>
        ) : null}
        <Button type="submit" size="touch" disabled={metadata.isPending}>
          {t("common:actions.save")}
        </Button>
      </div>
    </form>
  );
}

const schema = z.object({ capabilities: z.array(z.enum(MODEL_CAPABILITIES)) });

function CapabilityForm({ model, onDone }: { model: ServedModel; onDone: () => void }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const set = useMutation({
    ...orpc.runtimes.models.setCapabilities.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const save = async (capabilities: Capability[] | null) => {
    try {
      await set.mutateAsync({ runtimeModelId: model.id, capabilities });
      await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
      await queryClient.invalidateQueries({ queryKey: orpc.models.key() });
      toast.success(t("dashboard:runtime.capabilities.saved"));
      onDone();
    } catch (error) {
      toast.error(refusalText(error));
    }
  };
  const form = useForm({
    defaultValues: { capabilities: model.capabilities.map(toWire) },
    validators: { onSubmit: schema },
    onSubmit: ({ value }) => save(value.capabilities.map(fromWire)),
  });
  return (
    <form
      className="flex min-w-0 flex-col gap-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        {t("dashboard:runtime.capabilities.detectedList", {
          list:
            model.detectedCapabilities
              .map((capability) => t(`dashboard:runtime.capabilities.values.${toWire(capability)}`))
              .join(", ") || t("dashboard:runtime.capabilities.none"),
        })}
      </p>
      <form.Field name="capabilities">
        {(field) => (
          <CapabilityChecks
            idBase={`capability-${model.id}`}
            value={field.state.value}
            onChange={field.handleChange}
          />
        )}
      </form.Field>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        {model.capabilitiesOverridden ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={set.isPending}
            onClick={() => save(null)}
          >
            {t("dashboard:runtime.capabilities.useDetected")}
          </Button>
        ) : null}
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" size="touch" disabled={submitting || set.isPending}>
              {submitting ? t("common:actions.saving") : t("common:actions.save")}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}
