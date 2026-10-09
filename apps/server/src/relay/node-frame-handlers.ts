/**
 * The relay manager takes ONE `NodeFrameHandlers` object; each module (node services, runtime
 * sync, lifecycle) owns a part. `composeNodeFrameHandlers` runs every part's handler for a frame
 * in order. `definitionSync` and `runtimeInventory` answer the node, so at most one part may
 * define each.
 */
import type { NodeFrameHandlers } from "./session-manager.js";

type Handler = (...args: never[]) => unknown;

/** The class only: an error message could carry frame content. */
function errorName(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}

export function composeNodeFrameHandlers(
  ...parts: ReadonlyArray<Partial<NodeFrameHandlers>>
): NodeFrameHandlers {
  const composed: Record<string, Handler> = {};
  const byKey = new Map<string, Handler[]>();
  for (const part of parts) {
    for (const [key, handler] of Object.entries(part)) {
      if (typeof handler !== "function") continue;
      const list = byKey.get(key) ?? [];
      list.push(handler as Handler);
      byKey.set(key, list);
    }
  }
  for (const [key, list] of byKey) {
    if (key === "definitionSync" || key === "runtimeInventory") {
      if (list.length > 1) throw new Error(`Only one part may answer ${key}.`);
      composed[key] = list[0] as Handler;
      continue;
    }
    // One part failing does not starve the next; nothing here rejects (nodeDisconnected is not
    // awaited by the manager).
    composed[key] = (async (...args: never[]) => {
      for (const handler of list) {
        try {
          await handler(...args);
        } catch (error) {
          console.error("[relay] node frame handler failed", key, errorName(error));
        }
      }
    }) as Handler;
  }
  return composed as NodeFrameHandlers;
}
