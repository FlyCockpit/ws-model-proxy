import { Link } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { useTranslation } from "react-i18next";

export function ChatEmptyState({
  hasModels,
  lang,
  onSamplePrompt,
}: {
  hasModels: boolean;
  lang: string;
  onSamplePrompt: (prompt: string) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground sm:p-8">
      {!hasModels ? (
        <div className="space-y-3">
          <p>{t("dashboard:chatTest.emptyModels")}</p>
          <Link
            to="/$lang/dashboard/pools/new"
            params={{ lang }}
            className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-background px-3.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            {t("dashboard:chatTest.createPool")}
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          <p>{t("dashboard:chatTest.emptyTranscript")}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {["samplePromptOne", "samplePromptTwo"].map((key) => {
              const prompt = t(`dashboard:chatTest.${key}`);
              return (
                <Button
                  key={key}
                  type="button"
                  variant="outline"
                  size="touch"
                  onClick={() => onSamplePrompt(prompt)}
                >
                  {prompt}
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
