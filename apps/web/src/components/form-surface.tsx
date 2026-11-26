import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@ws-model-proxy/ui/components/sheet";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Form surfaces (the design-system "Form surfaces" rule): a dialog holds about six controls and
 * fits without inner scrolling; anything longer is a page or a wide side sheet with sections, the
 * quick path first, expert fields under collapsed Advanced sections, and a sticky action bar.
 *
 * Local stand-ins for the template's `FormPage` / sheet layout. The template-forms port replaces
 * this module's internals with the template's components; callers keep these names and props.
 */

/** A titled group of fields: one column on phones, two at >= 1024px when `columns` is 2. */
export function FormSection({
  title,
  description,
  columns = 1,
  id,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  columns?: 1 | 2;
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={id ? `${id}-title` : undefined}
      className={cn("flex min-w-0 flex-col gap-3", className)}
    >
      <div className="min-w-0 space-y-1">
        <h2 id={id ? `${id}-title` : undefined} className="text-base font-semibold">
          {title}
        </h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className={cn("grid min-w-0 gap-4", columns === 2 && "lg:grid-cols-2")}>{children}</div>
    </section>
  );
}

/** A field (or block) that spans both columns of a two-column `FormSection`. */
export function FormWide({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-w-0 lg:col-span-2", className)}>{children}</div>;
}

/**
 * A collapsed disclosure for expert fields. `summary` says what the defaults are, so a person can
 * leave it closed with confidence. `focusFirstInvalid` opens it when it holds an invalid field.
 */
export function FormAdvanced({
  title,
  summary,
  defaultOpen = false,
  open,
  onOpenChange,
  children,
  className,
}: {
  title: ReactNode;
  summary?: ReactNode;
  defaultOpen?: boolean;
  /** Controlled: the caller owns whether it is open (e.g. opened by a "Custom" choice). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details
      data-form-advanced=""
      open={(open ?? defaultOpen) || undefined}
      onToggle={
        onOpenChange
          ? (event) => {
              const next = event.currentTarget.open;
              if (next !== open) onOpenChange(next);
            }
          : undefined
      }
      className={cn("group min-w-0 rounded-xl border", className)}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-start gap-2 rounded-xl p-4 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 transition-transform group-open:rotate-90"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-semibold">{title}</span>
          {summary ? (
            <span className="text-xs break-words text-muted-foreground">{summary}</span>
          ) : null}
        </span>
      </summary>
      <div className="flex min-w-0 flex-col gap-4 px-4 pb-4">{children}</div>
    </details>
  );
}

/**
 * The page's action bar, stuck to the bottom of the page scroller so the primary action is always
 * on screen. `summary` says what the action will do.
 */
export function FormActionBar({ summary, children }: { summary?: ReactNode; children: ReactNode }) {
  return (
    <div
      data-form-action-bar=""
      className="sticky bottom-0 z-10 -mx-4 mt-2 flex min-w-0 flex-col gap-2 border-t bg-background/95 px-4 py-3 supports-backdrop-filter:backdrop-blur sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0 text-sm break-words text-muted-foreground">{summary}</div>
      <div className="flex min-w-0 shrink-0 flex-wrap justify-end gap-2">{children}</div>
    </div>
  );
}

/**
 * A wide side sheet for forms too long for a dialog: the whole screen on phones, up to 48rem on
 * wider screens. The header (title, close) and the footer (actions) stay put; the body scrolls.
 */
export function FormSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-form-sheet=""
        className="w-full max-w-full overflow-x-hidden pt-(--safe-area-top) pb-(--safe-area-bottom) data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
      >
        <SheetHeader className="border-b pe-12">
          <SheetTitle className="text-base font-semibold">{title}</SheetTitle>
          {description ? (
            <SheetDescription className="text-sm">{description}</SheetDescription>
          ) : null}
        </SheetHeader>
        <div
          data-slot="form-sheet-body"
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-4"
        >
          {children}
        </div>
        {footer ? (
          <div data-slot="form-sheet-footer" className="shrink-0 border-t p-4">
            {footer}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * After a failed submit: open every collapsed Advanced section that holds an invalid field, then
 * focus the first invalid field in document order and bring it into view.
 */
export function focusFirstInvalid(root: HTMLElement | null): boolean {
  if (!root) return false;
  let invalid = [...root.querySelectorAll<HTMLElement>('[aria-invalid="true"]')];
  // An error no input owns (a list's own error) is a focus target too, so it is never left
  // unseen inside a collapsed section.
  if (invalid.length === 0)
    invalid = [...root.querySelectorAll<HTMLElement>("[data-inline-error]")];
  if (invalid.length === 0) return false;
  for (const element of invalid) {
    for (
      let details = element.closest("details");
      details;
      details = details.parentElement?.closest("details") ?? null
    )
      details.open = true;
  }
  const [first] = invalid;
  first.focus({ preventScroll: true });
  first.scrollIntoView?.({ block: "center" });
  return true;
}

/**
 * Focus one field by id (a "fill this in" link): opens the collapsed sections around it first.
 * False when no such element is on the page.
 */
export function focusField(id: string): boolean {
  const element = document.getElementById(id);
  if (!element) return false;
  for (
    let details = element.closest("details");
    details;
    details = details.parentElement?.closest("details") ?? null
  )
    details.open = true;
  element.focus({ preventScroll: true });
  element.scrollIntoView?.({ block: "center" });
  return true;
}
