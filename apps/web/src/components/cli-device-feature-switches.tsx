import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type CommandFeature,
  commandModeOptionState,
  type FeatureSwitchReason,
  featureReasonKey,
  featureSwitchState,
  MCP_COMMAND_MODES,
  type McpCommandMode,
  readCliDeviceFeatures,
  recommendTerminalApproval,
} from "@/lib/cli-device-features";
import { orpc } from "@/utils/orpc";

type OptimisticGrants = {
  terminal?: boolean;
  commands?: McpCommandMode;
};

function FeatureSwitch({
  id,
  label,
  checked,
  disabled,
  pending,
  reason,
  onCheckedChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  pending: boolean;
  reason: FeatureSwitchReason | null;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation("dashboard");
  const reasonId = `${id}-reason`;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-h-11 items-center gap-3">
        <Switch
          id={id}
          checked={checked}
          disabled={disabled || pending}
          aria-describedby={reason ? reasonId : undefined}
          onCheckedChange={onCheckedChange}
        />
        <Label htmlFor={id} className="min-h-11 flex-1 cursor-pointer">
          {label}
        </Label>
      </div>
      {reason ? (
        <p id={reasonId} className="text-xs text-muted-foreground">
          {t(featureReasonKey(reason))}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Off / Supervised / Unsupervised. Modes above what the CLI allows are
 * disabled. Unsupervised is styled as dangerous (any agent with an MCP token
 * for this account can run arbitrary commands, unconfirmed) and Supervised is
 * marked as the recommended mode.
 */
function CommandModeControl({
  id,
  feature,
  selected,
  pending,
  onSelect,
}: {
  id: string;
  feature: CommandFeature;
  selected: McpCommandMode;
  pending: boolean;
  onSelect: (mode: McpCommandMode) => void;
}) {
  const { t } = useTranslation("dashboard");
  const reasons = MCP_COMMAND_MODES.map((mode) => commandModeOptionState(feature, mode).reason);
  const firstReason = reasons.find((reason) => reason !== null) ?? null;
  const reasonId = `${id}-reason`;
  return (
    <fieldset className="min-w-0 flex-1" aria-describedby={firstReason ? reasonId : undefined}>
      <legend className="flex min-h-11 items-center text-sm font-medium">
        {t("dashboard:clis.features.commands")}
      </legend>
      <div className="flex flex-wrap gap-2">
        {MCP_COMMAND_MODES.map((mode) => {
          const state = commandModeOptionState(feature, mode);
          const optionId = `${id}-${mode}`;
          const checked = selected === mode;
          const dangerous = mode === "unsupervised";
          return (
            <label
              key={mode}
              htmlFor={optionId}
              className={cn(
                "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm has-focus-visible:outline-2 has-focus-visible:outline-ring",
                dangerous
                  ? checked
                    ? "border-destructive text-destructive ring-1 ring-destructive"
                    : "border-destructive/50 text-destructive"
                  : checked
                    ? "border-primary bg-primary/10"
                    : "border-border",
                state.disabled || pending
                  ? "cursor-not-allowed opacity-50"
                  : dangerous
                    ? "hover:bg-destructive/10"
                    : "hover:bg-muted",
              )}
            >
              <input
                id={optionId}
                type="radio"
                name={`${id}-mode`}
                value={mode}
                className={cn("size-4", dangerous ? "accent-destructive" : "accent-primary")}
                checked={checked}
                disabled={state.disabled || pending}
                onChange={() => onSelect(mode)}
              />
              {dangerous ? <TriangleAlert className="size-4 shrink-0" aria-hidden="true" /> : null}
              {t(`dashboard:clis.features.commandModes.${mode}`)}
              {mode === "supervised" ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                  {t("dashboard:clis.features.commandModeRecommended")}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
      <p
        className={cn(
          "mt-1 text-xs",
          selected === "unsupervised" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {t(`dashboard:clis.features.commandModeHelp.${selected}`)}
      </p>
      {firstReason ? (
        <p id={reasonId} className="text-xs text-muted-foreground">
          {t(featureReasonKey(firstReason))}
        </p>
      ) : null}
    </fieldset>
  );
}

export function CliDeviceFeatureSwitches({
  cliDeviceId,
  deviceName,
  device,
}: {
  cliDeviceId: string;
  /** Shown in the Unsupervised confirm dialog. */
  deviceName: string;
  device: Parameters<typeof readCliDeviceFeatures>[0];
}) {
  const { t } = useTranslation("dashboard");
  const queryClient = useQueryClient();
  const baseId = useId();
  const features = readCliDeviceFeatures(device);
  const [optimistic, setOptimistic] = useState<OptimisticGrants>({});
  // Switching TO Unsupervised waits here for an explicit confirm; the radio
  // stays on the current mode until then, so cancelling changes nothing.
  const [confirmUnsupervised, setConfirmUnsupervised] = useState(false);
  const grants = useMutation({
    ...orpc.forwarderManagement.setCliDeviceFeatureGrants.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:clis.features.saved"));
        setOptimistic({});
      },
      onError: () => {
        setOptimistic({});
      },
    }),
    meta: { errorFallbackKey: "dashboard:clis.features.saveFailed" },
  });
  const terminalFeature = features.features.terminal;
  const commandFeature = features.features.commands;
  const terminalGate = featureSwitchState(terminalFeature, "terminal");
  const commandMode = optimistic.commands ?? commandFeature.mode;
  const setCommandMode = (mode: McpCommandMode) => {
    setOptimistic((current) => ({ ...current, commands: mode }));
    grants.mutate({ cliDeviceId, mcpCommandMode: mode });
  };
  const showApproval = recommendTerminalApproval(
    { ...commandFeature, mode: commandMode },
    terminalFeature,
  );

  return (
    <div className="flex flex-col gap-3 border-b p-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <FeatureSwitch
          id={`${baseId}-terminal`}
          label={t("dashboard:clis.features.terminal")}
          checked={optimistic.terminal ?? terminalFeature.granted}
          disabled={terminalGate.disabled}
          pending={grants.isPending}
          reason={terminalGate.reason}
          onCheckedChange={(checked) => {
            setOptimistic((current) => ({ ...current, terminal: checked }));
            grants.mutate({ cliDeviceId, humanTerminal: checked });
          }}
        />
        <CommandModeControl
          id={`${baseId}-commands`}
          feature={commandFeature}
          selected={commandMode}
          pending={grants.isPending}
          onSelect={(mode) => {
            if (mode === "unsupervised" && commandMode !== "unsupervised") {
              setConfirmUnsupervised(true);
              return;
            }
            setCommandMode(mode);
          }}
        />
      </div>
      <AlertDialog open={confirmUnsupervised} onOpenChange={setConfirmUnsupervised}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)]! sm:max-w-md! data-[size=default]:max-w-[calc(100%-2rem)]! data-[size=default]:sm:max-w-md! data-[size=sm]:max-w-[calc(100%-2rem)]! data-[size=sm]:sm:max-w-md!">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex min-w-0 items-center gap-2 break-words">
              <TriangleAlert className="size-5 shrink-0 text-destructive" aria-hidden="true" />
              {t("dashboard:clis.features.unsupervisedConfirm.title", { name: deviceName })}
            </AlertDialogTitle>
            <AlertDialogDescription className="min-w-0 max-w-full break-words">
              {t("dashboard:clis.features.unsupervisedConfirm.description", {
                name: deviceName,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:flex-wrap">
            <AlertDialogCancel className="min-h-[44px] w-full sm:w-auto">
              {t("dashboard:clis.features.unsupervisedConfirm.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="min-h-[44px] w-full sm:w-auto"
              onClick={() => {
                setConfirmUnsupervised(false);
                setCommandMode("unsupervised");
              }}
            >
              {t("dashboard:clis.features.unsupervisedConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {showApproval ? (
        <div className="flex min-w-0 gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
          <div className="min-w-0">
            <p>{t("dashboard:clis.features.approvalRecommended")}</p>
            <code className="mt-1 block max-w-full overflow-x-auto overflow-y-hidden overscroll-x-contain font-mono text-xs">
              wsmp config set-terminal-approval on
            </code>
          </div>
        </div>
      ) : null}
    </div>
  );
}
