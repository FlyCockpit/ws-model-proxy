import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";

export function ChatTestSkeleton() {
  return (
    <div className="grid h-full min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] rounded-md border p-2 sm:p-3">
      <div className="mb-2 flex items-center gap-2 sm:mb-3">
        <Skeleton className="h-6 w-28 sm:h-7 sm:w-40" />
        <Skeleton className="ml-auto h-11 min-w-0 flex-1 md:max-w-80" />
        <Skeleton className="size-11 shrink-0" />
      </div>
      <div className="min-h-0 space-y-4 overflow-hidden border-y py-4">
        <Skeleton className="h-24 w-3/4" />
        <Skeleton className="ml-auto h-32 w-4/5" />
        <Skeleton className="h-24 w-2/3" />
      </div>
      <div className="mt-2 flex items-end gap-2 sm:mt-3">
        <Skeleton className="size-11 shrink-0" />
        <Skeleton className="h-11 min-w-0 flex-1 sm:h-20" />
        <Skeleton className="size-11 shrink-0" />
      </div>
    </div>
  );
}
