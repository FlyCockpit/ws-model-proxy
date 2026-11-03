import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";

/** Loading placeholder for the MCP login page and its re-authorization branch. */
export function McpPageSkeleton() {
  return (
    <div className="flex min-w-0 items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <Skeleton className="mx-auto h-8 w-40" />
          <Skeleton className="mx-auto h-4 w-56" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </div>
  );
}
