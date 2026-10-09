import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";

import { orpc } from "@/utils/orpc";

type CreatePoolInput = Parameters<AppRouterClient["pools"]["create"]>[0];
export type CreatedPool = Awaited<ReturnType<AppRouterClient["pools"]["create"]>>;

/**
 * `pools.create` plus the lists a new pool changes (pools, models, runtimes' served models and the
 * Overview's getting-started state). Callers report refusals themselves.
 */
export function useCreatePool() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    ...orpc.pools.create.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const create = async (input: CreatePoolInput): Promise<CreatedPool> => {
    const pool = await mutation.mutateAsync(input);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.pools.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.models.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.activity.overview.key() }),
    ]);
    return pool;
  };
  return { create, isPending: mutation.isPending };
}
