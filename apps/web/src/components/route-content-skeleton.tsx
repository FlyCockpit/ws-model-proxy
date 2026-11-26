import { useMatch, useRouterState } from "@tanstack/react-router";
import { Card, CardContent, CardHeader } from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import type { ReactNode } from "react";

import {
  type PendingFrame,
  type PendingLayout,
  type PendingShape,
  type PendingWidth,
  resolvePendingLayout,
} from "@/lib/pending-layout";

/*
 * ws-model-proxy's take on the template's `components/route-content-skeleton.tsx`
 * (template 2145d95): the same shapes and the same `staticData` contract
 * (lib/pending-layout.ts, an identical copy), drawn for this app's geometry.
 * The difference: here the app frame (`AppFrame`) owns the page container
 * and its padding, so an unframed skeleton draws only the page's content;
 * the admin pages (their own tab strip and `container … py-8` pages) are the
 * one layout frame, and match the template's "admin" frame.
 */

// The admin pages' container widths, so the skeleton's columns line up with the page.
const WIDTH_CLASS: Record<PendingWidth, string> = {
  narrow: "max-w-4xl",
  default: "max-w-5xl",
  wide: "max-w-7xl",
};

/**
 * The content skeleton for the route that is loading, shaped by its `staticData`. It never draws
 * app chrome: it goes where the page goes.
 */
export function RouteContentSkeleton({ pageContainer = false }: { pageContainer?: boolean }) {
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  // The matches of the location being loaded (a pending route is already in them), leaf last.
  const matches = useRouterState({ select: (state) => state.matches });
  return (
    <ContentSkeleton
      layout={resolvePendingLayout(matches, routeId)}
      pageContainer={pageContainer}
    />
  );
}

/**
 * The skeleton markup for a resolved layout. `pageContainer`: outside the app frame (an admin or
 * public page), an unframed skeleton draws the page's own container, as the template's does.
 */
export function ContentSkeleton({
  layout,
  pageContainer = false,
}: {
  layout: PendingLayout;
  pageContainer?: boolean;
}) {
  let body: ReactNode = <ShapeSkeleton shape={layout.shape} />;
  for (const frame of [...layout.frames].reverse())
    body = (
      <FrameSkeleton frame={frame} width={layout.width}>
        {body}
      </FrameSkeleton>
    );
  return (
    <div
      data-route-skeleton={layout.shape}
      aria-busy="true"
      className={cn(
        "flex min-w-0 flex-col",
        layout.frames.length === 0 && "gap-6",
        layout.frames.length === 0 &&
          pageContainer && ["container mx-auto px-4 py-8", WIDTH_CLASS[layout.width]],
      )}
    >
      {body}
    </div>
  );
}

function FrameSkeleton({
  frame,
  width,
  children,
}: {
  frame: PendingFrame;
  width: PendingWidth;
  children: ReactNode;
}) {
  if (frame === "admin")
    // The admin layout: a sticky, full-bleed tab strip of 44px links, then the page in its own
    // container.
    return (
      <>
        <div className="border-b">
          <div className="container mx-auto flex max-w-7xl gap-1 overflow-hidden px-4 py-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-11 w-24 shrink-0 rounded-md" />
            ))}
          </div>
        </div>
        <div className={cn("container mx-auto space-y-6 px-4 py-8", WIDTH_CLASS[width])}>
          {children}
        </div>
      </>
    );
  // The settings layout (inside the app frame): its title, then a side nav (a row on phones).
  return (
    <div className="mx-auto w-full min-w-0 max-w-4xl">
      <Skeleton className="mb-6 h-8 w-32" />
      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <div className="flex gap-1 md:w-48 md:shrink-0 md:flex-col">
          {Array.from({ length: 2 }, (_, index) => (
            <Skeleton key={index} className="h-11 w-24 shrink-0 rounded-md md:w-full" />
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-6">{children}</div>
      </div>
    </div>
  );
}

function HeaderSkeleton({ action }: { action?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-2">
        <Skeleton className="h-8 w-48 max-w-full" />
        <Skeleton className="h-5 w-72 max-w-full" />
      </div>
      {action ? <Skeleton className="h-11 w-32" /> : null}
    </div>
  );
}

function ListRows({ count }: { count: number }) {
  return (
    <ul className="divide-y">
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-8 w-16" />
        </li>
      ))}
    </ul>
  );
}

function ShapeSkeleton({ shape }: { shape: PendingShape }) {
  switch (shape) {
    case "list":
      return (
        <>
          <HeaderSkeleton action />
          <Card>
            <CardHeader className="space-y-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent className="p-0">
              <ListRows count={4} />
            </CardContent>
          </Card>
        </>
      );
    case "detail":
      return (
        <>
          <HeaderSkeleton action />
          <Skeleton className="h-48 w-full rounded-lg" />
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </>
      );
    case "form":
      return (
        <>
          <HeaderSkeleton />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-11 w-full" />
              </div>
            ))}
          </div>
          <Skeleton className="h-11 w-32" />
        </>
      );
    case "dashboard":
      return (
        <>
          <HeaderSkeleton />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-32 w-full rounded-xl" />
          </div>
        </>
      );
  }
}
