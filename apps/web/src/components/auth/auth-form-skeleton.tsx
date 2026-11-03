import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";

/** Loading placeholder shaped like the sign-in and sign-up cards (title, description, 3 rows). */
export function AuthFormSkeleton() {
  return (
    <div className="w-full max-w-md space-y-6">
      <div className="space-y-2 text-center">
        <Skeleton className="mx-auto h-8 w-40" />
        <Skeleton className="mx-auto h-4 w-56" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}
