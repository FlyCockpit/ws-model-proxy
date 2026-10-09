/**
 * One place that builds the server's node-side services from the relay manager: `app.ts`
 * hands them to procedures (`Context.services`), `index.ts` installs the frame handlers and
 * starts the lifecycle engine once the server starts.
 */
import { RuntimeLifecycle } from "../runtimes/lifecycle.js";
import { createRuntimeStepServices } from "../runtimes/operator-steps.js";
import { nodeCommandTracker } from "./node-commands.js";
import { composeNodeFrameHandlers } from "./node-frame-handlers.js";
import { createNodeOperatorServices } from "./node-operator-services.js";
import { createNodeRelayServices } from "./node-services.js";
import { createRuntimeSync } from "./runtime-sync.js";
import { relaySessionManager } from "./session-manager.js";
import { terminalTicketStore } from "./terminal-tickets.js";

const relay = {
  sendToNode: relaySessionManager.sendToNode.bind(relaySessionManager),
  nodeSession: relaySessionManager.nodeSession.bind(relaySessionManager),
};

const runtimeSync = createRuntimeSync({
  ...relay,
  getOnlineNodeIds: () => relaySessionManager.getOnlineNodeIds(),
});

/** Steps, dispatch, results, restarts and health of runtime instances. */
export const runtimeLifecycle = new RuntimeLifecycle(
  {
    ...relay,
    onlineNodeIds: () => relaySessionManager.getOnlineNodeIds(),
    operatorRoom: (nodeId) => relaySessionManager.operatorRoom(nodeId),
    closeOperatorStep: (stepId, options) => relaySessionManager.closeOperatorStep(stepId, options),
    closeOperatorTerminal: (nodeId, terminalId) =>
      relaySessionManager.closeOperatorTerminal(nodeId, terminalId),
  },
  {
    // A start that found its definition missing: push the node's definitions again.
    resyncDefinitions: (nodeId) => void runtimeSync.syncNode(nodeId),
  },
);

/** Interactive steps (attach tickets, reopen, cancel): `Context.services.runtimeSteps`. */
export const runtimeStepServices = createRuntimeStepServices({
  engine: runtimeLifecycle,
  relay: {
    operatorStepTerminal: (stepId, userId) =>
      relaySessionManager.operatorStepTerminal(stepId, userId),
  },
  tickets: terminalTicketStore,
});

/** Terminal tickets and node commands (exec.*): `Context.services.nodeOperator`. */
const nodeOperator = createNodeOperatorServices(relay, {
  // The same store the browser terminal socket redeems from.
  tickets: terminalTicketStore,
  tracker: nodeCommandTracker,
});
export const nodeOperatorServices = nodeOperator.services;

const nodeRelay = createNodeRelayServices(
  {
    ...relay,
    requestTrustLower: (nodeId, at) => relaySessionManager.requestTrustLower(nodeId, at),
    closeSessionsForNodes: (nodeIds) => relaySessionManager.closeSessionsForNodes(nodeIds),
  },
  {
    definitionChanged: (nodeIds) => runtimeSync.definitionChanged(nodeIds),
    // The apply wrote its stops and starts; the engine dispatches them now.
    profileApplied: (operationId) => runtimeLifecycle.dispatchOperation({ operationId }),
  },
);

export const nodeServices = nodeRelay.services;
export const pushRuntimeDefinitions = runtimeSync.pushRuntimeDefinitions;
export const dispatchRuntimeOperation = (input: { userId: string; operationId: string }) =>
  runtimeLifecycle.dispatchOperation(input);

export function installNodeFrameHandlers(): void {
  relaySessionManager.setNodeFrameHandlers(
    // Node operator first: cancels resent on reconnect (bans, revocations) must not wait
    // behind the definition sync and lifecycle database work.
    composeNodeFrameHandlers(
      nodeOperator.handlers,
      nodeRelay.handlers,
      runtimeSync.handlers,
      runtimeLifecycle.handlers(),
    ),
  );
}

/** Starts the lifecycle engine; the returned stop joins its tick (shutdown). */
export function startRuntimeLifecycle(): () => Promise<void> {
  runtimeLifecycle.start();
  return () => runtimeLifecycle.stop();
}
