import type { RegistryEntry } from "@ws-model-proxy/config/pool-defaults";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { NativeSelect } from "@/components/native-select";
import { StatusPill } from "@/components/status-pill";

export type RegistryValue = number | boolean | string | null;
export type EffectiveView = { effective: RegistryValue; source: string } | undefined;

/**
 * One Advanced setting (pool or runtime registries): its effective value and source, an
 * override input bounded by the registry, and "back to automatic". `onSave(null)` clears.
 */
export function RegistryOverrideRow({
  id,
  label,
  entry,
  view,
  pending,
  onSave,
}: {
  id: string;
  label: string;
  entry: RegistryEntry;
  view: EffectiveView;
  pending: boolean;
  onSave: (value: RegistryValue) => Promise<boolean>;
}) {
  const { t } = useTranslation(["dashboard"]);
  const [draft, setDraft] = useState<string>(
    view?.source === "override" && view.effective !== null ? String(view.effective) : "",
  );
  const parsed = ((): RegistryValue | undefined => {
    if (entry.kind === "bool")
      return draft === "true" ? true : draft === "false" ? false : undefined;
    if (entry.kind === "enum") return entry.values.includes(draft) ? draft : undefined;
    const number = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(number)) return undefined;
    if (entry.kind === "int" && !Number.isInteger(number)) return undefined;
    return number >= entry.min && number <= entry.max ? number : undefined;
  })();
  return (
    <form
      className="flex min-w-0 flex-col gap-2 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (parsed !== undefined) onSave(parsed);
      }}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Label htmlFor={id} className="font-medium">
          {label}
        </Label>
        <StatusPill tone={view?.source === "override" ? "info" : "muted"}>
          {t(`dashboard:pool.advanced.source.${view?.source ?? "default"}`)}
        </StatusPill>
        <span className="text-sm text-muted-foreground">
          {view?.effective === null || view?.effective === undefined
            ? t("dashboard:pool.advanced.unknown")
            : typeof view.effective === "string"
              ? t(`dashboard:pool.advanced.values.${view.effective}`, {
                  defaultValue: view.effective,
                })
              : String(view.effective)}
          {"unit" in entry && entry.unit
            ? ` ${t(`dashboard:pool.advanced.units.${entry.unit}`)}`
            : ""}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
        {entry.kind === "bool" || entry.kind === "enum" ? (
          <NativeSelect
            id={id}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="sm:max-w-xs"
          >
            <option value="">{t("dashboard:pool.advanced.pick")}</option>
            {(entry.kind === "bool" ? ["true", "false"] : entry.values).map((value) => (
              <option key={value} value={value}>
                {entry.kind === "bool"
                  ? t(`dashboard:pool.advanced.bool.${value}`)
                  : t(`dashboard:pool.advanced.values.${value}`, { defaultValue: value })}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <Input
            id={id}
            inputMode={entry.kind === "int" ? "numeric" : "decimal"}
            className="h-11 sm:max-w-xs"
            placeholder={`${entry.min} – ${entry.max}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        )}
        <Button type="submit" size="touch" disabled={parsed === undefined || pending}>
          {t("dashboard:pool.advanced.override")}
        </Button>
        {view?.source === "override" ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={pending}
            onClick={async () => {
              if (await onSave(null)) setDraft("");
            }}
          >
            {t("dashboard:pool.advanced.automatic")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
