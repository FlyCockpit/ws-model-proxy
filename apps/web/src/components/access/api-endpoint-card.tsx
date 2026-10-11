import { Card, CardContent } from "@ws-model-proxy/ui/components/card";
import { useTranslation } from "react-i18next";

import { CodeSnippet } from "@/components/code-snippet";

/** The base URL and a curl example (with `model` when one is known). */
export function EndpointCard({ baseUrl, model }: { baseUrl: string; model?: string }) {
  const { t } = useTranslation(["access"]);
  const example = `curl ${baseUrl}/chat/completions \\\n  -H "Authorization: Bearer $WSMP_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${model ?? "<owner>/<pool>"}", "messages": [{"role": "user", "content": "Hello"}]}'`;
  return (
    <Card>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm font-medium">{t("access:apiKeys.endpoint")}</p>
          <CodeSnippet code={baseUrl} copyLabel={t("access:apiKeys.copyEndpoint")} />
        </div>
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm font-medium">{t("access:apiKeys.example")}</p>
          <CodeSnippet code={example} copyLabel={t("access:apiKeys.copyExample")} />
        </div>
      </CardContent>
    </Card>
  );
}
