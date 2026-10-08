import { createFileRoute } from "@tanstack/react-router";

import { TestPage } from "@/components/test/test-page";

/** `?target=` preselects a callable ID or `runtime:<runtimeId>:<model>` (Models page links). */
function parseTestSearch(search: Record<string, unknown>): { target?: string } {
  const target = search.target;
  return typeof target === "string" && target.length > 0 && target.length <= 512 ? { target } : {};
}

export const Route = createFileRoute("/$lang/_auth/_app/test")({
  validateSearch: parseTestSearch,
  component: TestRoute,
});

function TestRoute() {
  const { lang } = Route.useParams();
  const { target } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <TestPage
      lang={lang}
      target={target}
      onTargetChange={(next) => void navigate({ search: { target: next }, replace: true })}
    />
  );
}
