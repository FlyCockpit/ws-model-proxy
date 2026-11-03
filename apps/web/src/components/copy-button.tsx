import { Button } from "@ws-model-proxy/ui/components/button";
import { toast } from "@ws-model-proxy/ui/lib/toast";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCopyFeedback } from "@/hooks/use-copy-feedback";

/** Copies `value`; a 44px target with a short "copied" state. */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  /** Accessible name, e.g. "Copy ann/chat". */
  label: string;
  className?: string;
}) {
  const { t } = useTranslation(["common"]);
  const { feedback, copy } = useCopyFeedback(1_500);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-touch"
      aria-label={label}
      title={label}
      className={cn("shrink-0", className)}
      onClick={async () => {
        if (await copy(value)) toast.success(t("common:actions.copied"));
        else toast.error(t("common:somethingWentWrong"));
      }}
    >
      {feedback === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </Button>
  );
}

/** A monospace value with a copy button, wrapping long ids instead of widening the page. */
export function CopyableCode({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <code className="min-w-0 break-all rounded-md bg-muted px-2 py-1 font-mono text-sm">
        {value}
      </code>
      <CopyButton value={value} label={label} />
    </div>
  );
}
