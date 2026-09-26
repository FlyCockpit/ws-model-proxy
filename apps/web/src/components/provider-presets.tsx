import { PROVIDER_PRESET_BASE_URL } from "@ws-model-proxy/api/lib/provider-protocol";
import { Button } from "@ws-model-proxy/ui/components/button";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useTranslation } from "react-i18next";

export type ProviderPreset = {
  key: "openrouter" | "openai" | "anthropic" | "custom";
  providerType: string;
  baseUrl: string;
  authType: "API_KEY" | "BEARER";
};

/**
 * Account presets. Base URLs are API roots: request paths such as
 * `/v1/chat/completions` are appended. "Custom" keeps the base URL empty for
 * any OpenAI-compatible endpoint.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    key: "openrouter",
    providerType: "openrouter",
    baseUrl: PROVIDER_PRESET_BASE_URL.openrouter,
    authType: "BEARER",
  },
  { key: "openai", providerType: "openai", baseUrl: "https://api.openai.com", authType: "BEARER" },
  {
    key: "anthropic",
    providerType: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authType: "API_KEY",
  },
  { key: "custom", providerType: "openai-compatible", baseUrl: "", authType: "BEARER" },
];

export function ProviderPresetButtons({
  onApply,
  className,
}: {
  onApply: (preset: ProviderPreset) => void;
  className?: string;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <fieldset className={cn("min-w-0 space-y-2", className)}>
      <legend className="text-sm font-medium">
        {t("dashboard:providerCatalog.presets.label")}
      </legend>
      <div className="flex flex-wrap gap-2">
        {PROVIDER_PRESETS.map((preset) => (
          <Button
            key={preset.key}
            type="button"
            variant="outline"
            size="touch"
            onClick={() => onApply(preset)}
          >
            {t(`dashboard:providerCatalog.presets.${preset.key}`)}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t("dashboard:providerCatalog.presets.hint")}</p>
    </fieldset>
  );
}
