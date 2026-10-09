import i18n from "i18next";

type IssueLike = { readonly message: string; readonly params?: unknown };

/**
 * The text to show for an issue of a shared definition schema (`@ws-model-proxy/api/lib/
 * runtime-spec`). Its custom issues carry English for the API and MCP plus `params.i18n`
 * (`lib/spec-issues.ts`), which names the localized copy in `validation:runtimeSpec`; every
 * other issue was already localized by the zod error map (`i18n/zod.ts`).
 */
export function specIssueText(issue: IssueLike): string {
  const params = issue.params;
  if (typeof params !== "object" || params === null) return issue.message;
  const id = Reflect.get(params, "i18n");
  if (typeof id !== "string") return issue.message;
  const key = `validation:runtimeSpec.${id}`;
  return i18n.exists(key) ? i18n.t(key, { ...params }) : issue.message;
}
