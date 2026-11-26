/**
 * What a route looks like while it loads, declared on the route itself
 * (`staticData`) so the skeleton the user sees first has the page's shape:
 * a list, a detail view, a form or a dashboard, at the page's width, inside
 * the layout chrome (the admin sub-nav, the settings side nav) that the page
 * sits in.
 * See patterns/loading-and-errors.md § Route pending states
 *
 *   export const Route = createFileRoute("/$lang/_app/_auth/projects")({
 *     staticData: { pendingShape: "list", pendingWidth: "narrow" },
 *     component: ProjectsPage,
 *   });
 *
 * A layout route that draws its own chrome around its children sets
 * `pendingFrame`; leaf routes set `pendingShape` (default "list") and
 * `pendingWidth` (default "default", the `PageShell` widths).
 */
export type PendingShape = "list" | "detail" | "form" | "dashboard";
export type PendingFrame = "admin" | "settings";
export type PendingWidth = "narrow" | "default" | "wide";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    pendingShape?: PendingShape;
    pendingWidth?: PendingWidth;
    pendingFrame?: PendingFrame;
  }
}

export type PendingLayout = {
  shape: PendingShape;
  width: PendingWidth;
  frames: PendingFrame[];
};

type MatchLike = {
  routeId: string;
  staticData?: {
    pendingShape?: PendingShape;
    pendingWidth?: PendingWidth;
    pendingFrame?: PendingFrame;
  };
};

/**
 * The skeleton for the matches from `fromRouteId` (the route whose pending
 * boundary is showing) down to the leaf. Frames above that route are already
 * on screen (their layout rendered), so only the ones at or below it are
 * drawn; the leaf decides the shape and width.
 */
export function resolvePendingLayout(
  matches: readonly MatchLike[],
  fromRouteId: string | undefined,
): PendingLayout {
  const start = fromRouteId ? matches.findIndex((match) => match.routeId === fromRouteId) : 0;
  const below = matches.slice(Math.max(start, 0));
  const frames: PendingFrame[] = [];
  for (const match of below) {
    const frame = match.staticData?.pendingFrame;
    if (frame) frames.push(frame);
  }
  const leaf = [...below].reverse().find((match) => match.staticData?.pendingShape);
  const widthMatch = [...below].reverse().find((match) => match.staticData?.pendingWidth);
  return {
    shape: leaf?.staticData?.pendingShape ?? "list",
    width: widthMatch?.staticData?.pendingWidth ?? "default",
    frames,
  };
}
