import { useTranslation } from "react-i18next";

import { RouteContentSkeleton } from "@/components/route-content-skeleton";

/**
 * The content area of a page that is still loading, in the page's own shape (its route's
 * `staticData`: list, detail, form or dashboard; lib/pending-layout.ts). It goes where the page
 * goes (inside the app frame), never in place of the frame, so the sidebar, header and bottom nav
 * are on screen from the first frame.
 */
export function PageSkeleton({ pageContainer = false }: { pageContainer?: boolean }) {
  const { t } = useTranslation(["common"]);
  return (
    <div data-page-skeleton="" className="flex min-w-0 flex-col">
      <span role="status" className="sr-only">
        {t("common:loading")}
      </span>
      <RouteContentSkeleton pageContainer={pageContainer} />
    </div>
  );
}
