/**
 * One place that builds the server's node-side services from the relay manager: `app.ts`
 * hands `nodeServices` to procedures (`Context.services.nodes`), `index.ts` installs the frame
 * handlers once the server starts.
 */
import { composeNodeFrameHandlers } from "./node-frame-handlers.js";
import { createNodeRelayServices } from "./node-services.js";
import { createRuntimeSync } from "./runtime-sync.js";
import { relaySessionManager } from "./session-manager.js";

const runtimeSync = createRuntimeSync({
  sendToNode: (nodeId, frame, guard) => relaySessionManager.sendToNode(nodeId, frame, guard),
  nodeSession: (nodeId) => relaySessionManager.nodeSession(nodeId),
  getOnlineNodeIds: () => relaySessionManager.getOnlineNodeIds(),
});

const nodeRelay = createNodeRelayServices(
  {
    sendToNode: (nodeId, frame, guard) => relaySessionManager.sendToNode(nodeId, frame, guard),
    nodeSession: (nodeId) => relaySessionManager.nodeSession(nodeId),
    requestTrustLower: (nodeId, at) => relaySessionManager.requestTrustLower(nodeId, at),
    closeSessionsForNodes: (nodeIds) => relaySessionManager.closeSessionsForNodes(nodeIds),
  },
  { definitionChanged: (nodeIds) => runtimeSync.definitionChanged(nodeIds) },
);

export const nodeServices = nodeRelay.services;
export const pushRuntimeDefinitions = runtimeSync.pushRuntimeDefinitions;

export function installNodeFrameHandlers(): void {
  relaySessionManager.setNodeFrameHandlers(
    composeNodeFrameHandlers(nodeRelay.handlers, runtimeSync.handlers),
  );
}
