import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@ws-model-proxy/ui/lib/toast";
import { useTranslation } from "react-i18next";

import { nextSavedOrder } from "@/lib/saved-order";
import { orpc } from "@/utils/orpc";

type TerminalLayout = { tabs: string[]; nodes: string[] };

const EMPTY: TerminalLayout = { tabs: [], nodes: [] };

/**
 * The person's Terminals-page order (tabs and nodes), saved on the server so it follows them
 * across sign-ins and devices. A move shows at once (the cached order changes before the save);
 * saves run one at a time, in the order made, and a failed one reloads the stored order.
 * Until the order loads, lists keep their usual order and cannot be moved (`ready` is false):
 * a save then would replace the stored order with only what is shown now.
 */
export function useTerminalLayout() {
  const { t } = useTranslation(["terminals"]);
  const queryClient = useQueryClient();
  const queryKey = orpc.settings.terminalLayout.get.queryKey();
  const layout = useQuery({
    ...orpc.settings.terminalLayout.get.queryOptions(),
    staleTime: 60_000,
  });
  const save = useMutation({
    ...orpc.settings.terminalLayout.update.mutationOptions(),
    // One at a time: a later order never lands before an earlier one.
    scope: { id: "terminal-layout" },
    meta: { skipGlobalErrorToast: true },
    onError: () => {
      toast.error(t("terminals:order.saveFailed"));
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  // Loaded once is enough: a failed background refetch keeps the cached order (and moves on).
  const ready = layout.data !== undefined;
  const current = layout.data ?? EMPTY;
  const store = (patch: Partial<TerminalLayout>) => {
    save.mutate(patch);
    // A fetch still running would overwrite the moved order when it lands; cancel it first.
    void queryClient.cancelQueries({ queryKey }).then(() => {
      queryClient.setQueryData<TerminalLayout>(queryKey, (old) => ({
        ...(old ?? current),
        ...patch,
      }));
    });
  };
  return {
    /** Whether the saved order has loaded, so moves can be made (and saved). */
    ready,
    tabOrder: current.tabs,
    nodeOrder: current.nodes,
    /**
     * Save the tab order after a move: `shownIds` are the tabs' terminal ids as now shown.
     * Returns the order saved, or null when the saved order has not loaded (nothing is saved).
     */
    saveTabOrder: (shownIds: readonly (string | null)[]) => {
      if (!ready) return null;
      const tabs = nextSavedOrder(shownIds, current.tabs);
      store({ tabs });
      return tabs;
    },
    /** Save the node order after a move: `shownIds` are the node ids as now shown. */
    saveNodeOrder: (shownIds: readonly string[]) => {
      if (!ready) return null;
      const nodes = nextSavedOrder(shownIds, current.nodes);
      store({ nodes });
      return nodes;
    },
  };
}
