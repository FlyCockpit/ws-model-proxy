import { useCallback, useRef, useState } from "react";

/** Appends what fits under `max`; `overflow` says some of `added` did not fit. */
export function fitAttachments<T>(
  current: readonly T[],
  added: readonly T[],
  max: number,
): { items: T[]; overflow: boolean } {
  const room = Math.max(0, max - current.length);
  return { items: [...current, ...added.slice(0, room)], overflow: added.length > room };
}

/** What one `add` came to. */
export type AttachmentJobOutcome<R> =
  /** The list was already full: the job did not run. */
  | { kind: "full" }
  /** The job ran; `overflow` when the list filled up before all it accepted fit. */
  | { kind: "added"; result: R; overflow: boolean };

/**
 * A message's attachments, added by jobs that run one at a time (reading and resizing files is
 * slow). Each job starts with the room left after the jobs before it, and what it accepted is
 * appended within `max` against the list as it is then, so overlapping adds cannot exceed it.
 * `processing` stays on until the last queued job is done.
 */
export function useAttachmentQueue<T>(max: number) {
  const [items, setItemsState] = useState<T[]>([]);
  const [pendingJobs, setPendingJobs] = useState(0);
  // The list as the next job sees it; written together with the state by `setItems` only.
  const itemsRef = useRef<T[]>([]);
  const tailRef = useRef<Promise<unknown>>(Promise.resolve());

  const setItems = useCallback((next: T[]) => {
    itemsRef.current = next;
    setItemsState(next);
  }, []);

  const add = useCallback(
    <R>(
      job: (room: number) => Promise<{ accepted: T[]; result: R }>,
    ): Promise<AttachmentJobOutcome<R>> => {
      setPendingJobs((count) => count + 1);
      const run = async (): Promise<AttachmentJobOutcome<R>> => {
        try {
          const room = max - itemsRef.current.length;
          if (room <= 0) return { kind: "full" };
          const { accepted, result } = await job(room);
          const fit = fitAttachments(itemsRef.current, accepted, max);
          setItems(fit.items);
          return { kind: "added", result, overflow: fit.overflow };
        } finally {
          setPendingJobs((count) => count - 1);
        }
      };
      const outcome = tailRef.current.then(run, run);
      tailRef.current = outcome.catch(() => undefined);
      return outcome;
    },
    [max, setItems],
  );

  const remove = useCallback(
    (drop: (item: T) => boolean) => setItems(itemsRef.current.filter((item) => !drop(item))),
    [setItems],
  );
  const clear = useCallback(() => setItems([]), [setItems]);

  return { items, processing: pendingJobs > 0, add, remove, clear };
}
