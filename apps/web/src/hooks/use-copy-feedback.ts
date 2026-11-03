import { useCallback, useEffect, useRef, useState } from "react";

/** What a copy button shows: nothing yet, a short "copied", or a short "failed". */
export type CopyFeedback = "idle" | "copied" | "failed";

/**
 * Copies text to the clipboard and shows the outcome for `resetAfterMs`. One timer at a time:
 * a new copy restarts it (a rapid second click keeps "copied" for the full time), and it is
 * cleared on unmount, so nothing updates a component that is gone.
 *
 * `copy` resolves to whether the text was copied, for the caller's own toast.
 */
export function useCopyFeedback(resetAfterMs = 1_500) {
  const [feedback, setFeedback] = useState<CopyFeedback>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, []);

  const show = useCallback(
    (next: Exclude<CopyFeedback, "idle">) => {
      if (!mountedRef.current) return;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setFeedback(next);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setFeedback("idle");
      }, resetAfterMs);
    },
    [resetAfterMs],
  );

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
        show("copied");
        return true;
      } catch {
        show("failed");
        return false;
      }
    },
    [show],
  );

  return { feedback, copy };
}
