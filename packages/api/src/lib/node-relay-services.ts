/**
 * Relay hooks the node and profile procedures call after they commit (lane B). Injected through
 * `Context.services.nodes` so the API package never imports the server.
 *
 * TODO(server): `apps/server` wires these to the relay (the server is being rekeyed; until then
 * every hook is optional and the procedures degrade as each one documents).
 */
export type NodeSecretWriteResult = {
  name: string;
  status: "set" | "deleted" | "not_found" | "refused";
  reason?: "trust_relay" | "invalid" | "store_failed" | "limit";
};

export type NodeRelayServices = {
  /**
   * The node part of a definition changed (labels, port range, metric commands, fabrics,
   * command lifetime): push `runtime.define` (node part) to each node that is online. Nodes that
   * are offline get it at their next hello (`definitionSync`).
   */
  definitionChanged?: (nodeIds: readonly string[]) => Promise<void>;
  /**
   * Send `secret.set` / delete frames and wait for `secret.result`. The values exist only in
   * this call and the frame: never logged, stored or audited. Absent: secrets cannot be written
   * yet and `nodes.update` refuses the secrets part.
   */
  writeSecrets?: (input: {
    nodeId: string;
    set: ReadonlyArray<{ name: string; value: string }>;
    delete: readonly string[];
  }) => Promise<NodeSecretWriteResult[]>;
  /** Ask the node to scan for local servers now (`runtime.detect`). */
  rescan?: (nodeId: string) => Promise<void>;
  /** A person lowered trust: send `trust.lower` now if the node is online. */
  lowerTrust?: (nodeId: string) => Promise<void>;
  /** Close the node's relay session (deleted node, revoked credential). */
  disconnect?: (nodeId: string, reason: "node_deleted" | "credential_revoked") => Promise<void>;
  /**
   * A profile apply committed its operation (holds already written): stop the listed instances
   * and start the planned ones through the runtime lifecycle (lane C owns starts and stops).
   */
  profileApplied?: (operationId: string) => Promise<void>;
};
