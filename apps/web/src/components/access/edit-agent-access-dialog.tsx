import { useForm } from "@tanstack/react-form";
import { type AgentScope, accessNarrowed } from "@ws-model-proxy/api/contracts";
import { Button } from "@ws-model-proxy/ui/components/button";
import { AlertTriangle } from "lucide-react";
import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AgentAccessChoice, agentAccessSummaryText } from "@/components/access/agent-access-choice";
import { FormSheet, focusFirstInvalid } from "@/components/form-surface";
import { agentAccessSchema, type EditableAgentAccess } from "@/lib/agent-access";

/**
 * "Edit access" for an agent token or OAuth connection, a wide side sheet like minting. Mount
 * only while open so each edit starts from the current server values.
 */
export function EditAgentAccessDialog({
  name,
  access,
  availableScopes,
  onSave,
  onClose,
}: {
  name: string;
  access: EditableAgentAccess;
  availableScopes?: readonly AgentScope[];
  onSave: (access: EditableAgentAccess) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation(["access", "common"]);
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const form = useForm({
    defaultValues: {
      scopes: [...access.scopes],
      nodeIds: access.nodeIds === null ? null : [...access.nodeIds],
    },
    validators: { onSubmit: agentAccessSchema },
    onSubmitInvalid: () => window.setTimeout(() => focusFirstInvalid(formRef.current), 0),
    onSubmit: async ({ value }) => {
      const saved = await onSave(value)
        .then(() => true)
        .catch(() => false);
      if (saved) onClose();
    },
  });
  return (
    <form.Subscribe selector={(state) => state}>
      {({ isSubmitting: pending, values }) => (
        <FormSheet
          open
          onOpenChange={(open) => {
            if (!open && !pending) onClose();
          }}
          title={t("access:agents.editTitle", { name })}
          description={t("access:agents.editDescription")}
          footer={
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0 text-sm break-words text-muted-foreground">
                {agentAccessSummaryText(t, values, availableScopes)}
              </p>
              <div className="flex min-w-0 shrink-0 flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  disabled={pending}
                  onClick={onClose}
                >
                  {t("common:actions.cancel")}
                </Button>
                <Button form={formId} type="submit" size="touch" disabled={pending}>
                  {pending ? t("access:agents.saving") : t("access:agents.save")}
                </Button>
              </div>
            </div>
          }
        >
          <form
            id={formId}
            ref={formRef}
            className="min-w-0 space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void form.handleSubmit();
            }}
          >
            <form.Subscribe selector={(state) => state.values}>
              {(value) => (
                <>
                  <AgentAccessChoice
                    value={value}
                    availableScopes={availableScopes}
                    disabled={pending}
                    onChange={(next) => {
                      form.setFieldValue("scopes", next.scopes);
                      form.setFieldValue("nodeIds", next.nodeIds);
                    }}
                  />
                  {accessNarrowed(access, value) ? (
                    <p
                      role="alert"
                      className="flex min-w-0 items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm text-destructive"
                    >
                      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0">{t("access:agents.narrowWarning")}</span>
                    </p>
                  ) : null}
                </>
              )}
            </form.Subscribe>
          </form>
        </FormSheet>
      )}
    </form.Subscribe>
  );
}
