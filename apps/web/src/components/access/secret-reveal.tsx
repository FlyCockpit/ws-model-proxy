import { Button } from "@ws-model-proxy/ui/components/button";
import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CodeSnippet } from "@/components/code-snippet";

/**
 * A secret shown exactly once (API key, agent token, invite link): a warning, the value with a
 * copy button, and an explicit "I copied it" that closes the view. The parent drops the value
 * from state when this closes, so it never renders again.
 */
export function SecretReveal({
  value,
  title,
  description,
  copyLabel,
  onDone,
  children,
}: {
  value: string;
  title?: string;
  description?: string;
  copyLabel?: string;
  onDone: () => void;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation(["access"]);
  return (
    <div className="flex min-w-0 flex-col gap-3 pb-4" data-secret-reveal>
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{title ?? t("access:secret.title")}</p>
          <p className="text-muted-foreground">{description ?? t("access:secret.description")}</p>
        </div>
      </div>
      <CodeSnippet code={value} copyLabel={copyLabel ?? t("access:secret.copy")} />
      {children}
      <Button type="button" size="touch" onClick={onDone}>
        {t("access:secret.done")}
      </Button>
    </div>
  );
}
