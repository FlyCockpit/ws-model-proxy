import { focusFirstInvalidField } from "@ws-model-proxy/ui/lib/focus-first-invalid";

/** An error that belongs to no single input (a list's own error); focusable with tabIndex -1. */
const INLINE_ERROR_SELECTOR = "[data-inline-error]";

/**
 * The template's `focusFirstInvalidField` (one frame after React commits the errors: open the
 * collapsed sections around the first invalid control, focus it, bring it into view), with one
 * app addition: when no control is invalid but an error no input owns is shown (a list's own
 * error, `data-inline-error`), that error is the target, so it is never left unseen inside a
 * collapsed section.
 */
export function focusFirstInvalid(root: ParentNode | null | undefined): unknown {
  if (!root) return undefined;
  const withFallback: Pick<ParentNode, "querySelector"> = {
    querySelector: ((selector: string) =>
      root.querySelector(selector) ??
      root.querySelector(INLINE_ERROR_SELECTOR)) as ParentNode["querySelector"],
  };
  return focusFirstInvalidField(withFallback);
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
