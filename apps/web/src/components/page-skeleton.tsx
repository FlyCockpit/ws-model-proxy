import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";

/**
 * The content area of a page that is still loading: a heading and two cards, the shape most
 * pages open with. It goes where the page goes (inside the app frame), never in place of the
 * frame, so the sidebar, header and bottom nav are on screen from the first frame.
 */
export function PageSkeleton() {
  const { t } = useTranslation(["common"]);
  return (
    <div data-page-skeleton="" className="flex min-w-0 flex-col gap-6">
      <span role="status" className="sr-only">
        {t("common:loading")}
      </span>
      <div aria-hidden="true" className="min-w-0 space-y-2">
        <Skeleton className="h-8 w-48 max-w-full" />
        <Skeleton className="h-5 w-72 max-w-full" />
      </div>
      <div aria-hidden="true" className="grid min-w-0 gap-4 md:grid-cols-2">
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    </div>
  );
}
