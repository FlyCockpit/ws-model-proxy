import { Button } from "@ws-model-proxy/ui/components/button";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { WideContent } from "@/components/wide-content";

/** A copyable block of code or shell commands. Long lines scroll sideways inside the block. */
export function CodeSnippet({
  code,
  copyLabel,
  className,
}: {
  code: string;
  /** Accessible name of the copy button. */
  copyLabel: string;
  className?: string;
}) {
  const { t } = useTranslation(["common"]);
  return (
    <div className={cn("flex min-w-0 items-start gap-1 rounded-md border bg-muted/50", className)}>
      <WideContent className="flex-1 py-2.5 pl-3">
        <pre className="w-max font-mono text-xs leading-relaxed text-foreground">
          <code>{code}</code>
        </pre>
      </WideContent>
      <Button
        type="button"
        size="icon-touch"
        variant="ghost"
        className="shrink-0"
        aria-label={copyLabel}
        onClick={() => {
          void navigator.clipboard
            .writeText(code)
            .then(() => toast.success(t("common:actions.copied")));
        }}
      >
        <Copy aria-hidden="true" className="size-4" />
      </Button>
    </div>
  );
}
