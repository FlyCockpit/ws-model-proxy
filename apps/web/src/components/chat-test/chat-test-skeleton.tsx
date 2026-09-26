import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";

/** Mirrors ChatTestPage's fill-pane geometry: header, transcript, composer. */
export function ChatTestSkeleton() {
  return (
    <div
      aria-busy="true"
      className="grid h-full min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] bg-background"
    >
      <div className="flex min-w-0 items-center gap-2 border-b p-2 sm:p-3">
        <Skeleton className="h-6 w-28 sm:h-7 sm:w-40" />
        <Skeleton className="ml-auto h-11 min-w-0 flex-1 md:max-w-80" />
        <Skeleton className="size-11 shrink-0" />
      </div>
      <div className="min-h-0 overflow-hidden p-2 sm:p-3">
        <div className="mx-auto max-w-3xl space-y-4">
          <Skeleton className="h-24 w-3/4" />
          <Skeleton className="ml-auto h-32 w-4/5" />
          <Skeleton className="h-24 w-2/3" />
        </div>
      </div>
      <div className="border-t p-2 sm:p-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <Skeleton className="size-11 shrink-0" />
          <Skeleton className="h-11 min-w-0 flex-1 sm:h-20" />
          <Skeleton className="size-11 shrink-0" />
        </div>
      </div>
    </div>
  );
}
