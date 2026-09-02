import { BatchLinkPlugin } from "@orpc/client/plugins";
import { RPC_BATCH_MAX_SIZE } from "@ws-model-proxy/config/rpc-policy";

export function createRpcBatchLinkPlugin() {
  return new BatchLinkPlugin({
    groups: [{ condition: () => true, context: {} }],
    maxSize: RPC_BATCH_MAX_SIZE,
  });
}
