import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";

type VersionDetail = Awaited<ReturnType<AppRouterClient["runtimes"]["versions"]["get"]>>;

/** Settings changed from automatic: the effective value of every override. */
function overrides(view: Record<string, { effective: unknown; source: string } | undefined>) {
  return Object.fromEntries(
    Object.entries(view).flatMap(([key, value]) =>
      value?.source === "override" ? [[key, value.effective]] : [],
    ),
  );
}

/** What a version defines, as the diff shows it (limits and advanced: overrides only). */
export function versionDocument(version: VersionDetail | null): unknown {
  if (!version) return {};
  return {
    spec: version.spec,
    limits: overrides(version.limits as Record<string, { effective: unknown; source: string }>),
    advanced: overrides(
      version.advanced as unknown as Record<string, { effective: unknown; source: string }>,
    ),
    compat: version.compat,
  };
}
