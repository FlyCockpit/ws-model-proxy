import { useForm } from "@tanstack/react-form";
import { type AgentScope, accessNarrowed } from "@ws-model-proxy/api/contracts";
import { Button } from "@ws-model-proxy/ui/components/button";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { AlertTriangle } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { AgentAccessChoice } from "@/components/access/agent-access-choice";
import { agentAccessSchema, type EditableAgentAccess } from "@/lib/agent-access";

/** Mount only while open so each edit starts from the current server values. */
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
  const form = useForm({
    defaultValues: {
      scopes: [...access.scopes],
      nodeIds: access.nodeIds === null ? null : [...access.nodeIds],
    },
    validators: { onSubmit: agentAccessSchema },
    onSubmit: async ({ value }) => {
      const saved = await onSave(value)
        .then(() => true)
        .catch(() => false);
      if (saved) onClose();
    },
  });
  return (
    <form.Subscribe selector={(state) => state.isSubmitting}>
      {(pending) => (
        <ResponsiveDialog
          open
          onOpenChange={(open) => {
            if (!open && !pending) onClose();
          }}
          title={t("access:agents.editTitle", { name })}
          description={t("access:agents.editDescription")}
          className="md:max-h-[calc(100dvh-2rem)] md:grid-rows-[auto_minmax(0,1fr)_auto] [&>[data-slot=drawer-header]]:shrink-0 [&>[data-slot=drawer-footer]]:shrink-0"
          footer={
            <div className="flex min-w-0 flex-wrap justify-end gap-2">
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
          }
        >
          <form
            id={formId}
            className="min-w-0 space-y-4 pb-4 md:overflow-x-hidden md:overflow-y-auto md:overscroll-contain"
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
        </ResponsiveDialog>
      )}
    </form.Subscribe>
  );
}
