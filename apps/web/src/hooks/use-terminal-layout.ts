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
 * Until the order loads, lists keep their usual order.
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
  const current = layout.data ?? EMPTY;
  const store = (patch: Partial<TerminalLayout>) => {
    queryClient.setQueryData<TerminalLayout>(queryKey, { ...current, ...patch });
    save.mutate(patch);
  };
  return {
    tabOrder: current.tabs,
    nodeOrder: current.nodes,
    /** Save the tab order after a move: `shownIds` are the tabs' terminal ids as now shown. */
    saveTabOrder: (shownIds: readonly (string | null)[]) =>
      store({ tabs: nextSavedOrder(shownIds, current.tabs) }),
    /** Save the node order after a move: `shownIds` are the node ids as now shown. */
    saveNodeOrder: (shownIds: readonly string[]) =>
      store({ nodes: nextSavedOrder(shownIds, current.nodes) }),
  };
}
