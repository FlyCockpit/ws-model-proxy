import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";

import { AUTH_SCREEN_CLASS } from "./auth-card";

/** Loading placeholder shaped like the sign-in and sign-up cards (title, description, 3 rows). */
export function AuthFormSkeleton() {
  return (
    <div className="w-full max-w-md space-y-6">
      <div className="space-y-2 text-center">
        <Skeleton className="mx-auto h-8 w-40" />
        <Skeleton className="mx-auto h-4 w-56" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-11 w-full md:h-8" />
        <Skeleton className="h-11 w-full md:h-8" />
        <Skeleton className="h-11 w-full md:h-8" />
      </div>
    </div>
  );
}

/** Centered full-screen placeholder for signed-out auth routes and their SSR shell skeleton. */
export function AuthScreenSkeleton() {
  return (
    <div className={AUTH_SCREEN_CLASS}>
      <AuthFormSkeleton />
    </div>
  );
}
