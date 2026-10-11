import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { TestErrorInfo } from "@/lib/test-relay";

/**
 * A failed Test request: what wsmp said (with the HTTP status and code) and, when the runtime
 * answered with an error of its own, a quote of it.
 */
export function TestErrorNotice({ error }: { error: TestErrorInfo }) {
  const { t } = useTranslation(["dashboard"]);
  const meta = [error.status !== null ? `HTTP ${error.status}` : null, error.code]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return (
    <div
      role="alert"
      className="flex min-w-0 flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
    >
      <p className="flex min-w-0 items-start gap-2 font-medium text-destructive">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 break-words">{error.message}</span>
      </p>
      {meta ? <p className="break-all font-mono text-xs text-muted-foreground">{meta}</p> : null}
      {error.upstream ? (
        <figure className="min-w-0">
          <figcaption className="text-xs font-medium text-muted-foreground">
            {t("dashboard:test.errors.upstream")}
          </figcaption>
          <blockquote className="mt-1 whitespace-pre-wrap break-words border-s-2 border-destructive/40 ps-3 font-mono text-xs">
            {error.upstream}
          </blockquote>
        </figure>
      ) : null}
    </div>
  );
}
