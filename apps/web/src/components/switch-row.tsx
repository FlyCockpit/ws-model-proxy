import { Switch } from "@ws-model-proxy/ui/components/switch";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * A labelled on/off setting: the whole row toggles it (44px tall), and the current state is
 * written out ("On" / "Off") next to the switch, so it never depends on reading the thumb.
 */
export function SwitchRow({
  id,
  label,
  description,
  checked,
  disabled = false,
  onChange,
  ariaLabel,
  className,
}: {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  /** A fuller accessible name than the visible label (e.g. naming the row's model). */
  ariaLabel?: string;
  className?: string;
}) {
  const { t } = useTranslation(["common"]);
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex min-h-11 min-w-0 cursor-pointer items-center gap-3",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm break-words">{label}</span>
        {description ? (
          <span id={descriptionId} className="text-xs break-words text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      <span aria-hidden="true" className="shrink-0 text-xs font-medium text-muted-foreground">
        {checked ? t("common:switchState.on") : t("common:switchState.off")}
      </span>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={descriptionId}
        onCheckedChange={(next) => onChange(next === true)}
      />
    </label>
  );
}
