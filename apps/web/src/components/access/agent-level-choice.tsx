import { Label } from "@ws-model-proxy/ui/components/label";
import { useTranslation } from "react-i18next";

import { SegmentedControl } from "@/components/segmented-control";

export type AgentLevel = "READ" | "FULL";

/**
 * The level an agent gets unless the person picks Full: the agent token dialog and the MCP
 * consent page start from the same value.
 */
export const DEFAULT_AGENT_LEVEL: AgentLevel = "READ";

/**
 * Read-only / Full, with the explanation of the chosen level. One component for the agent
 * token dialog and the MCP consent page, so both say the same thing in the same words.
 */
export function AgentLevelChoice({
  value,
  onChange,
}: {
  value: AgentLevel;
  onChange: (next: AgentLevel) => void;
}) {
  const { t } = useTranslation(["access"]);
  return (
    <div className="min-w-0 space-y-2">
      <Label>{t("access:agents.level")}</Label>
      <SegmentedControl
        value={value}
        onChange={onChange}
        ariaLabel={t("access:agents.level")}
        items={[
          { value: "READ", label: t("access:agents.levelRead") },
          { value: "FULL", label: t("access:agents.levelFull") },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        {value === "FULL" ? t("access:agents.levelFullHint") : t("access:agents.levelReadHint")}
      </p>
    </div>
  );
}
