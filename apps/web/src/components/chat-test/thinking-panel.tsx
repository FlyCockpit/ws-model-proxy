import { useTranslation } from "react-i18next";

export function ThinkingPanel({ thinking, streaming }: { thinking: string; streaming: boolean }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <details
      open={streaming || undefined}
      className="mt-3 rounded-md border border-border/70 bg-muted/30 p-2 text-sm"
    >
      <summary className="flex min-h-11 cursor-pointer items-center font-medium">
        {t("dashboard:chatTest.reasoning.thinkingSummary")}
      </summary>
      <div className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{thinking}</div>
    </details>
  );
}
