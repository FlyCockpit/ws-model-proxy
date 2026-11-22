import {
  PROVIDER_MODEL_SURFACES,
  type ProviderModelSurface,
} from "@ws-model-proxy/api/lib/provider-model-capabilities";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import { useId } from "react";
import { useTranslation } from "react-i18next";

/** The generation APIs a provider serves natively for a model; the others are adapted. */
export function SurfacesChoice({
  value,
  onChange,
  disabled = false,
}: {
  value: readonly ProviderModelSurface[];
  onChange: (next: ProviderModelSurface[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const id = useId();
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-1">
      <legend className="text-sm font-medium">{t("dashboard:providers.surfaces.title")}</legend>
      <p className="text-xs text-muted-foreground">{t("dashboard:providers.surfaces.hint")}</p>
      <div className="flex min-w-0 flex-wrap gap-x-4">
        {PROVIDER_MODEL_SURFACES.map((surface) => (
          <label
            key={surface}
            htmlFor={`${id}-${surface}`}
            className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-md p-2 hover:bg-muted"
          >
            <Checkbox
              id={`${id}-${surface}`}
              checked={value.includes(surface)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange(
                  PROVIDER_MODEL_SURFACES.filter((candidate) =>
                    candidate === surface ? checked === true : value.includes(candidate),
                  ),
                )
              }
            />
            <span className="text-sm">{t(`dashboard:providers.surfaces.${surface}`)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
