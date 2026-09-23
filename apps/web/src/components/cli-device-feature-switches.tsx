import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type CommandFeature,
  type FeatureSwitchReason,
  featureReasonKey,
  featureSwitchState,
  readCliDeviceFeatures,
  type TerminalFeature,
} from "@/lib/cli-device-features";
import { orpc } from "@/utils/orpc";

type OptimisticGrants = {
  terminal?: boolean;
  commands?: boolean;
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

export function CliDeviceFeatureSwitches({
  cliDeviceId,
  device,
}: {
  cliDeviceId: string;
  device: Parameters<typeof readCliDeviceFeatures>[0];
}) {
  const { t } = useTranslation("dashboard");
  const queryClient = useQueryClient();
  const baseId = useId();
  const features = readCliDeviceFeatures(device);
  const [optimistic, setOptimistic] = useState<OptimisticGrants>({});
  const grants = useMutation(
    orpc.forwarderManagement.setCliDeviceFeatureGrants.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:clis.features.saved"));
        setOptimistic({});
      },
      onError: () => {
        toast.error(t("dashboard:clis.features.saveFailed"));
        setOptimistic({});
      },
    }),
  );
  const terminal = switchView(features.features.terminal, "terminal", optimistic.terminal);
  const commands = switchView(features.features.commands, "commands", optimistic.commands);

  return (
    <div className="flex flex-col gap-2 border-b p-4 sm:flex-row">
      <FeatureSwitch
        id={`${baseId}-terminal`}
        label={t("dashboard:clis.features.terminal")}
        checked={terminal.checked}
        disabled={terminal.disabled}
        pending={grants.isPending}
        reason={terminal.reason}
        onCheckedChange={(checked) => {
          setOptimistic((current) => ({ ...current, terminal: checked }));
          grants.mutate({ cliDeviceId, humanTerminal: checked });
        }}
      />
      <FeatureSwitch
        id={`${baseId}-commands`}
        label={t("dashboard:clis.features.commands")}
        checked={commands.checked}
        disabled={commands.disabled}
        pending={grants.isPending}
        reason={commands.reason}
        onCheckedChange={(checked) => {
          setOptimistic((current) => ({ ...current, commands: checked }));
          grants.mutate({ cliDeviceId, mcpCommands: checked });
        }}
      />
    </div>
  );
}

function switchView(
  feature: TerminalFeature | CommandFeature,
  kind: "terminal" | "commands",
  optimistic: boolean | undefined,
): { checked: boolean; disabled: boolean; reason: FeatureSwitchReason | null } {
  const gate = featureSwitchState(feature, kind);
  return {
    checked: optimistic ?? feature.granted,
    disabled: gate.disabled,
    reason: gate.reason,
  };
}
