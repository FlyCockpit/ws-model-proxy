import type {
  ChatTestReasoningSelection,
  ReasoningSelectorState,
} from "@ws-model-proxy/api/lib/reasoning-contract";
import { Label } from "@ws-model-proxy/ui/components/label";
import { useTranslation } from "react-i18next";

import type {
  ChatTestRoutingMode,
  ChatTestSurface,
  ChatTestSurfaceSelection,
  ModelOption,
} from "./chat-test-types";

export function RequestSettingsFields({
  idPrefix,
  isPool,
  selectedModel,
  surfaceSelection,
  effectiveSurface,
  recommendedSurface,
  routingMode,
  selectorState,
  effectiveReasoningSelection,
  reasoningHelp,
  anthropicMaxTokens,
  onAnthropicMaxTokensChange,
  disabled,
  onSurfaceChange,
  onRoutingModeChange,
  onReasoningChange,
}: {
  idPrefix: string;
  isPool: boolean;
  selectedModel: ModelOption | undefined;
  surfaceSelection: ChatTestSurfaceSelection;
  effectiveSurface: ChatTestSurface | null;
  recommendedSurface: string | null | undefined;
  routingMode: ChatTestRoutingMode;
  selectorState: ReasoningSelectorState;
  effectiveReasoningSelection: ChatTestReasoningSelection;
  reasoningHelp: string;
  anthropicMaxTokens: number;
  onAnthropicMaxTokensChange: (value: number) => void;
  disabled: boolean;
  onSurfaceChange: (value: ChatTestSurfaceSelection) => void;
  onRoutingModeChange: (value: ChatTestRoutingMode) => void;
  onReasoningChange: (value: ChatTestReasoningSelection) => void;
}) {
  const { t } = useTranslation(["dashboard"]);

  return (
    <div className="space-y-4">
      {isPool ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-surface`}>{t("dashboard:chatTest.surface.label")}</Label>
          <select
            id={`${idPrefix}-surface`}
            className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
            value={surfaceSelection}
            disabled={disabled}
            aria-invalid={surfaceSelection === "PREFERRED" && effectiveSurface === null}
            onChange={(event) => {
              onSurfaceChange(event.target.value as ChatTestSurfaceSelection);
            }}
          >
            <option value="PREFERRED">{t("dashboard:chatTest.surface.PREFERRED")}</option>
            <option value="OPENAI_CHAT_COMPLETIONS">
              {t("dashboard:chatTest.surface.OPENAI_CHAT_COMPLETIONS")}
            </option>
            <option value="OPENAI_RESPONSES">
              {t("dashboard:chatTest.surface.OPENAI_RESPONSES")}
            </option>
            <option value="ANTHROPIC_MESSAGES">
              {t("dashboard:chatTest.surface.ANTHROPIC_MESSAGES")}
            </option>
          </select>
          <p className="text-xs text-muted-foreground">
            {surfaceSelection === "PREFERRED" && recommendedSurface
              ? t("dashboard:chatTest.surface.preferredHelp", { surface: recommendedSurface })
              : t("dashboard:chatTest.surface.explicitHelp")}
          </p>
        </div>
      ) : null}
      {isPool ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-routing-mode`}>
            {t("dashboard:chatTest.routingMode.label")}
          </Label>
          <select
            id={`${idPrefix}-routing-mode`}
            className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
            value={routingMode}
            disabled={disabled}
            onChange={(event) => onRoutingModeChange(event.target.value as ChatTestRoutingMode)}
          >
            <option value="PREFER_NATIVE">
              {t("dashboard:chatTest.routingMode.PREFER_NATIVE")}
            </option>
            <option value="REQUIRE_NATIVE">
              {t("dashboard:chatTest.routingMode.REQUIRE_NATIVE")}
            </option>
            <option value="REQUIRE_ADAPTED">
              {t("dashboard:chatTest.routingMode.REQUIRE_ADAPTED")}
            </option>
          </select>
          <p className="text-xs text-muted-foreground">
            {t("dashboard:chatTest.routingMode.help")}
          </p>
        </div>
      ) : selectedModel ? (
        <p className="text-xs text-muted-foreground">
          {t("dashboard:chatTest.routingMode.directHelp")}
        </p>
      ) : null}
      {!selectorState.hidden ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-reasoning`}>{t("dashboard:chatTest.reasoning.label")}</Label>
          <select
            id={`${idPrefix}-reasoning`}
            className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
            value={effectiveReasoningSelection}
            disabled={disabled}
            onChange={(event) =>
              onReasoningChange(event.target.value as ChatTestReasoningSelection)
            }
          >
            {selectorState.options.map((level) => (
              <option key={level} value={level}>
                {t(`dashboard:chatTest.reasoning.levels.${level}`)}
                {level !== "unset" && selectorState.defaultLevel === level
                  ? ` (${t("dashboard:chatTest.reasoning.default")})`
                  : ""}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{reasoningHelp}</p>
        </div>
      ) : null}
      {effectiveSurface === "ANTHROPIC_MESSAGES" ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-max-tokens`}>
            {t("dashboard:chatTest.maxTokens.label")}
          </Label>
          <input
            id={`${idPrefix}-max-tokens`}
            type="number"
            min={1}
            step={1}
            className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
            value={anthropicMaxTokens}
            disabled={disabled}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isInteger(next) && next > 0) onAnthropicMaxTokensChange(next);
            }}
          />
          <p className="text-xs text-muted-foreground">{t("dashboard:chatTest.maxTokens.help")}</p>
        </div>
      ) : null}
    </div>
  );
}
