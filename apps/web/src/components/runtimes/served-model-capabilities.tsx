import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MODEL_CAPABILITIES, type ModelCapabilityWire } from "@ws-model-proxy/api/lib/runtime-spec";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { CapabilityChecks } from "@/components/runtimes/runtime-spec-fields";
import { SegmentedControl } from "@/components/segmented-control";
import { StatusPill } from "@/components/status-pill";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

type ServedModel = Awaited<ReturnType<AppRouterClient["runtimes"]["get"]>>["servedModels"][number];
type Capability = ServedModel["capabilities"][number];

const toWire = (capability: Capability) => capability.toLowerCase() as ModelCapabilityWire;
const fromWire = (capability: ModelCapabilityWire) => capability.toUpperCase() as Capability;

const DECLARATIONS = ["unknown", "yes", "no"] as const;
type Declaration = (typeof DECLARATIONS)[number];
const toDeclaration = (value: boolean | null): Declaration =>
  value === null ? "unknown" : value ? "yes" : "no";
const fromDeclaration = (value: Declaration): boolean | null =>
  value === "unknown" ? null : value === "yes";

/** The same capabilities, in any order. */
function sameCapabilities(a: readonly Capability[], b: readonly Capability[]): boolean {
  const other = new Set(b);
  return a.length === b.length && a.every((capability) => other.has(capability));
}

/**
 * A served model's capabilities: what the node detected, or the owner's override. People set
 * the override here; "Use detected" returns to what the node reports. Whether the model takes
 * tool calls and reasoning is the owner's declaration (unknown until declared).
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
      {model.tools === null ? null : (
        <StatusPill tone="muted">
          {model.tools
            ? t("dashboard:runtime.capabilities.tools.yes")
            : t("dashboard:runtime.capabilities.tools.no")}
        </StatusPill>
      )}
      {model.reasoning === null ? null : (
        <StatusPill tone="muted">
          {model.reasoning
            ? t("dashboard:runtime.capabilities.reasoning.yes")
            : t("dashboard:runtime.capabilities.reasoning.no")}
        </StatusPill>
      )}
      <Button type="button" variant="ghost" size="touch" onClick={() => setOpen(true)}>
        {t("dashboard:runtime.capabilities.change")}
      </Button>
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title={t("dashboard:runtime.capabilities.dialogTitle", { model: model.upstreamModelId })}
        description={t("dashboard:runtime.capabilities.dialogHint")}
      >
        {open ? <CapabilityForm model={model} onDone={() => setOpen(false)} /> : null}
      </ResponsiveDialog>
    </div>
  );
}

const schema = z.object({
  capabilities: z.array(z.enum(MODEL_CAPABILITIES)),
  tools: z.enum(DECLARATIONS),
  reasoning: z.enum(DECLARATIONS),
});

function CapabilityForm({ model, onDone }: { model: ServedModel; onDone: () => void }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const set = useMutation({
    ...orpc.runtimes.models.setCapabilities.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const save = async (
    input: Pick<Parameters<typeof set.mutateAsync>[0], "capabilities" | "tools" | "reasoning">,
  ) => {
    try {
      await set.mutateAsync({ runtimeModelId: model.id, ...input });
      await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
      await queryClient.invalidateQueries({ queryKey: orpc.models.key() });
      toast.success(t("dashboard:runtime.capabilities.saved"));
      onDone();
    } catch (error) {
      toast.error(refusalText(error));
    }
  };
  const form = useForm({
    defaultValues: {
      capabilities: model.capabilities.map(toWire),
      tools: toDeclaration(model.tools),
      reasoning: toDeclaration(model.reasoning),
    },
    validators: { onSubmit: schema },
    onSubmit: ({ value }) => {
      const capabilities = value.capabilities.map(fromWire);
      // Declaring tools alone must not turn the detected capabilities into an override.
      const capabilitiesChanged =
        model.capabilitiesOverridden || !sameCapabilities(capabilities, model.capabilities);
      return save({
        ...(capabilitiesChanged ? { capabilities } : {}),
        tools: fromDeclaration(value.tools),
        reasoning: fromDeclaration(value.reasoning),
      });
    },
  });
  const declarationItems = DECLARATIONS.map((value) => ({
    value,
    label: t(`dashboard:runtime.capabilities.declaration.${value}`),
  }));
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
      {(["tools", "reasoning"] as const).map((name) => (
        <form.Field key={name} name={name}>
          {(field) => (
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-medium">
                {t(`dashboard:runtime.capabilities.${name}.label`)}
              </span>
              <span className="text-sm text-muted-foreground">
                {t(`dashboard:runtime.capabilities.${name}.hint`)}
              </span>
              <SegmentedControl
                value={field.state.value}
                onChange={field.handleChange}
                items={declarationItems}
                ariaLabel={t(`dashboard:runtime.capabilities.${name}.label`)}
              />
            </div>
          )}
        </form.Field>
      ))}
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        {model.capabilitiesOverridden ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={set.isPending}
            onClick={() =>
              // Keep any Tools / Reasoning edits made in this dialog.
              save({
                capabilities: null,
                tools: fromDeclaration(form.state.values.tools),
                reasoning: fromDeclaration(form.state.values.reasoning),
              })
            }
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
