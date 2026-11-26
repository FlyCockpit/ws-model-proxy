"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ws-model-proxy/ui/components/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@ws-model-proxy/ui/components/drawer";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useSyncExternalStore } from "react";

/**
 * Dialog on desktop, bottom Drawer on mobile — the repo's documented
 * "View Details → Dialog on desktop, Drawer on mobile" responsive overlay
 * pattern, packaged once so callers don't re-implement the media-query split.
 *
 * Self-contained: it does not import the web app's `useMediaQuery` (that would
 * couple `packages/ui` to `apps/web`); it inlines an SSR-safe
 * `useSyncExternalStore` matcher instead. The server snapshot is `false`
 * (mobile-first), so SSR renders the Drawer and the client upgrades after
 * mount — fine for an overlay, which is inherently a client interaction.
 */

const DESKTOP_QUERY = "(min-width: 768px)";

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}

export type ResponsiveDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Extra classes for the content surface (e.g. width on desktop). */
  className?: string;
};

export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: ResponsiveDialogProps) {
  const isDesktop = useIsDesktop();

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        {/* Header and footer stay put; only the body would scroll, and a dialog's form must be
            short enough that it never has to (the dialog-fits check). */}
        <DialogContent
          className={cn(
            "max-h-[calc(100dvh-2rem)]",
            footer ? "grid-rows-[auto_minmax(0,1fr)_auto]" : "grid-rows-[auto_minmax(0,1fr)]",
            className,
          )}
        >
          <DialogHeader className="pe-8">
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <div
            data-slot="responsive-dialog-body"
            className="-mx-1 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain px-1"
          >
            {children}
          </div>
          {footer ? <DialogFooter>{footer}</DialogFooter> : null}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className={className} style={{ paddingBottom: "var(--safe-area-bottom)" }}>
        {/* As on desktop: the header and the footer (the primary action) stay put. */}
        <DrawerHeader className="shrink-0">
          <DrawerTitle>{title}</DrawerTitle>
          {description ? <DrawerDescription>{description}</DrawerDescription> : null}
        </DrawerHeader>
        <div
          data-slot="responsive-dialog-body"
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4"
        >
          {children}
        </div>
        {footer ? <DrawerFooter className="shrink-0 border-t">{footer}</DrawerFooter> : null}
      </DrawerContent>
    </Drawer>
  );
}
