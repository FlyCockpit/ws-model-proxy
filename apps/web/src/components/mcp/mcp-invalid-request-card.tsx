import { Card, CardDescription, CardHeader, CardTitle } from "@ws-model-proxy/ui/components/card";
import { useTranslation } from "react-i18next";

/**
 * Localized terminal invalid-request card shared by the MCP login branches
 * (unusable signed transaction, failed reauth probe). Extracted from
 * `routes/$lang/mcp-login.tsx` (Part H pass 3) so both the route and the
 * reauth branch render the identical terminal state.
 */
export function McpInvalidRequestCard() {
  const { t } = useTranslation(["auth"]);
  return (
    <div className="flex min-w-0 items-center justify-center px-4 py-10">
      <Card className="w-full min-w-0 max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t("auth:mcpLogin.invalidTitle")}</CardTitle>
          <CardDescription className="min-w-0 break-words">
            {t("auth:mcpLogin.invalidDescription")}
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
