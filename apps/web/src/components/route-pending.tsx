import { useRouterState } from "@tanstack/react-router";

import { AppFrame, useInAppFrame } from "@/components/app-frame";
import { PageSkeleton } from "@/components/page-skeleton";
import { shellPartsOf } from "@/components/shell-skeleton";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";

/**
 * The router's pending state for any route without its own. Inside the app frame it is the page's
 * skeleton only. Outside it (a layout's code chunk still loading on a reload, before the frame
 * has rendered) it draws the frame itself around the skeleton, so the sidebar and the page
 * padding never drop out and come back.
 */
export function RoutePending() {
  const inFrame = useInAppFrame();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (inFrame) return <PageSkeleton />;
  const segment = pathname.split("/")[1];
  const lang = isSupportedLocale(segment) ? segment : DEFAULT_LOCALE;
  if (shellPartsOf(pathname).sidebar)
    return (
      <AppFrame lang={lang}>
        <PageSkeleton />
      </AppFrame>
    );
  return (
    <div className="container mx-auto flex min-w-0 max-w-6xl flex-col px-4 py-4 md:py-6">
      <PageSkeleton />
    </div>
  );
}
