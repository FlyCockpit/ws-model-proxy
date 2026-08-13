import { type RefObject, useEffect, useRef } from "react";

/**
 * Cancels one in-flight browser operation when its owner unmounts and exposes
 * whether it remains safe for the operation to update route state.
 */
export function useAbortOnUnmount(abortControllerRef: RefObject<AbortController | null>) {
  const isMountedRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      abortControllerRef.current?.abort();
    };
  }, [abortControllerRef]);

  return isMountedRef;
}
