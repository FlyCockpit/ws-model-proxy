import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import type { SileoState } from "sileo";

const toastActions = new Map<string, () => void>();
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** @internal Shared with `../lib/toast`, which pre-registers actions for queued/mounted toasts. */
export function registerToastAction(id: string, onClick: () => void): void {
  toastActions.set(id, onClick);
}

/** @internal Shared with `../lib/toast`, which clears stored actions on `toast.clear()`. */
export function clearToastActions(): void {
  toastActions.clear();
}

/** @internal Shared with `./sileo`, which invokes the action when the toast control is activated. */
export function invokeToastAction(id: string): void {
  toastActions.get(id)?.();
}

/**
 * Renders the toast action inside `description` as a non-interactive pill so
 * `sileo`'s root `<button data-sileo-toast>` stays a single control with no
 * nested `<a href>` inside it, while preserving the full accessible name on
 * that `<button>`.
 */
export function ToastAction({
  id,
  state,
  title,
  label,
  onClick,
}: {
  id: string;
  state: SileoState;
  title: string;
  label: string;
  onClick: () => void;
}): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    toastActions.set(id, onClick);
    return () => {
      if (toastActions.get(id) === onClick) toastActions.delete(id);
    };
  }, [id, onClick]);

  useIsomorphicLayoutEffect(() => {
    const toastEl = ref.current?.closest("[data-sileo-toast]");
    if (!toastEl) return;
    toastEl.setAttribute("aria-label", title ? `${title} — ${label}` : label);
    return () => {
      toastEl.removeAttribute("aria-label");
    };
  }, [title, label]);

  return (
    <span ref={ref} data-sileo-button="" data-state={state} data-toast-action-id={id}>
      {label}
    </span>
  );
}
