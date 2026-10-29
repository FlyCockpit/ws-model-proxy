/**
 * Committed node changes the browser should see without polling (#255).
 *
 * Every writer publishes here AFTER its write has committed (or, for a disconnect, after the
 * fenced write was attempted: the relay's memory is authoritative):
 *  - the relay session manager: connection, trust shown or features, agent-update progress
 *    (apps/server/src/relay/);
 *  - `nodes.delete` and the enrollment exchange (../nodes/).
 *
 * The server subscribes its browser event hub (apps/server/src/node-events/), which delivers
 * each event to the owner's open streams only. An event names the node and what changed; it
 * never carries node data. The browser refetches its queries, so the queries stay the source of
 * truth and a missed event only delays a refresh.
 *
 * In-process only, like the deployment (one web container): listeners run in the replica that
 * made the change.
 */

export type NodeEvent =
  | {
      type: "node.connection";
      userId: string;
      nodeId: string;
      connection: "ONLINE" | "OFFLINE";
      /** The session's connection generation; null when the node never got one. */
      generation: number | null;
    }
  | {
      type: "node.trust" | "node.agentUpdate" | "node.added" | "node.removed";
      userId: string;
      nodeId: string;
    };

export type NodeEventListener = (event: NodeEvent) => void;

const listeners = new Set<NodeEventListener>();

/** Subscribes a listener; returns its unsubscribe function. Idempotent per function. */
export function onNodeEvent(listener: NodeEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Runs every listener for a committed change. A listener failure is logged (class only) and
 * never thrown: the change already happened and its writer must not fail because a browser
 * could not be told.
 */
export function publishNodeEvent(event: NodeEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.error(
        "[node-events] listener failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    }
  }
}
