import { BatchHandlerPlugin } from "@orpc/server/plugins";
import { RPC_BATCH_MAX_SIZE } from "@ws-model-proxy/config/rpc-policy";

export function createRpcBatchHandlerPlugin() {
  return new BatchHandlerPlugin({ maxSize: RPC_BATCH_MAX_SIZE });
}
