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

// Tailwind's `md` (48rem): rem media queries follow the browser's default font size, so the
// switch and the `md:` styles inside the surface flip at the same width for every user.
const DESKTOP_QUERY = "(min-width: 48rem)";

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
  /**
   * Where focus goes when it closes. Needed when nothing triggers it (the phone drawer then has
   * no trigger to return to) or when one dialog hands over to the next (an invite, then its
   * result), so focus lands back on the control that started the flow.
   */
  returnFocus?: React.RefObject<HTMLElement | null>;
};

export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  returnFocus,
}: ResponsiveDialogProps) {
  const isDesktop = useIsDesktop();

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        {/* DialogContent's body is the one scroller; DialogHeader and DialogFooter stick to its
            top and bottom, so the title and the primary action stay put. A dialog's form must be
            short enough that it never has to scroll (the dialog-fits check). */}
        <DialogContent className={className} finalFocus={returnFocus ?? true}>
          {/* Titles and descriptions may carry user data (an email): long unbroken words wrap. */}
          <DialogHeader className="min-w-0 [overflow-wrap:anywhere]">
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <div data-slot="responsive-dialog-body" className="min-w-0">
            {children}
          </div>
          {footer ? <DialogFooter>{footer}</DialogFooter> : null}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        // The dialog slots on the phone drawer too, so the dialog-fits check (and anything else
        // that finds an open dialog) measures it the same way at every width.
        data-slot="dialog-content"
        className={className}
        style={{ paddingBottom: "var(--safe-area-bottom)" }}
        onCloseAutoFocus={(event) => {
          const target = returnFocus?.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {/* As on desktop: the header and the footer (the primary action) stay put. */}
        <DrawerHeader
          data-slot="responsive-dialog-header"
          className="min-w-0 shrink-0 [overflow-wrap:anywhere]"
        >
          <DrawerTitle>{title}</DrawerTitle>
          {description ? <DrawerDescription>{description}</DrawerDescription> : null}
        </DrawerHeader>
        <div
          data-slot="responsive-dialog-body"
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4"
        >
          {children}
        </div>
        {footer ? (
          <DrawerFooter data-slot="responsive-dialog-footer" className="shrink-0 border-t">
            {footer}
          </DrawerFooter>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}
