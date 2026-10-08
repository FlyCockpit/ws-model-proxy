import { Label } from "@ws-model-proxy/ui/components/label";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { NativeSelect } from "@/components/native-select";
import { type PillTone, StatusPill } from "@/components/status-pill";
import type { TestTarget } from "@/lib/test-relay";

const STATUS_TONE: Record<TestTarget["status"], PillTone> = {
  serving: "good",
  starting: "busy",
  unavailable: "muted",
};

function optionLabel(target: TestTarget): string {
  return target.source === "runtime" ? `${target.servedModel} · ${target.label}` : target.label;
}

/**
 * The Test page's target: callable IDs (pools, own and shared) and the person's own runtimes'
 * served models (direct, never callable with an API key).
 */
export function TargetPicker({
  targets,
  value,
  onChange,
  disabled,
}: {
  targets: TestTarget[];
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const id = useId();
  const pools = targets.filter((target) => target.source === "pool");
  const direct = targets.filter((target) => target.source === "runtime");
  const selected = targets.find((target) => target.model === value);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor={id}>{t("dashboard:test.target.label")}</Label>
      <NativeSelect
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {pools.length > 0 ? (
          <optgroup label={t("dashboard:test.target.pools")}>
            {pools.map((target) => (
              <option key={target.model} value={target.model}>
                {optionLabel(target)}
              </option>
            ))}
          </optgroup>
        ) : null}
        {direct.length > 0 ? (
          <optgroup label={t("dashboard:test.target.direct")}>
            {direct.map((target) => (
              <option key={target.model} value={target.model}>
                {optionLabel(target)}
              </option>
            ))}
          </optgroup>
        ) : null}
      </NativeSelect>
      {selected ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="target-facts">
          <StatusPill tone="info">{t(`dashboard:models.type.${selected.type}`)}</StatusPill>
          <StatusPill tone={STATUS_TONE[selected.status]}>
            {t(`dashboard:models.status.${selected.status}`)}
          </StatusPill>
          <StatusPill tone="muted">
            {selected.source === "runtime"
              ? t("dashboard:test.target.directPill")
              : t("dashboard:test.target.poolPill")}
          </StatusPill>
          {selected.external ? (
            <StatusPill tone="busy">{t("dashboard:models.external")}</StatusPill>
          ) : null}
          <code className="min-w-0 break-all font-mono text-xs text-muted-foreground">
            {selected.model}
          </code>
        </div>
      ) : null}
      {selected?.status === "unavailable" ? (
        <p className="text-sm text-muted-foreground">{t("dashboard:test.target.notServing")}</p>
      ) : null}
      {selected?.source === "runtime" ? (
        <p className="text-sm text-muted-foreground">{t("dashboard:test.target.directHint")}</p>
      ) : null}
    </div>
  );
}
