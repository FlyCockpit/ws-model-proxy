/**
 * The relay manager takes ONE `NodeFrameHandlers` object; each module (node services, runtime
 * sync, lifecycle) owns a part. `composeNodeFrameHandlers` runs every part's handler for a frame
 * in order. `definitionSync` and `runtimeInventory` answer the node, so at most one part may
 * define each.
 *
 * One part failing never starves the next. A node frame (`runtime.job.result`, `exec.status`,
 * ...) then rejects once every part ran, so the manager sees the frame as not delivered (a
 * failed `operator_running` is redelivered). The session hooks (`nodeReady`, `trustRaised`,
 * `nodeDisconnected`) only log: nothing redelivers them, and `nodeDisconnected` is not awaited.
 */
import type { NodeFrameHandlers } from "./session-manager.js";

type Handler = (...args: never[]) => unknown;

/** Session hooks: a failed part is logged, the composed hook still resolves. */
const HOOKS: ReadonlySet<string> = new Set<keyof NodeFrameHandlers>([
  "nodeReady",
  "trustRaised",
  "nodeDisconnected",
]);

/** A node frame one or more parts failed to handle (every part still ran). */
export class NodeFrameHandlersFailed extends Error {
  constructor(readonly key: string) {
    super(`A node frame handler failed: ${key}`);
    this.name = "NodeFrameHandlersFailed";
  }
}

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
    const hook = HOOKS.has(key);
    composed[key] = (async (...args: never[]) => {
      let failed = false;
      for (const handler of list) {
        try {
          await handler(...args);
        } catch (error) {
          failed = true;
          console.error("[relay] node frame handler failed", key, errorName(error));
        }
      }
      if (failed && !hook) throw new NodeFrameHandlersFailed(key);
    }) as Handler;
  }
  return composed as NodeFrameHandlers;
}
