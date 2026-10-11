import { useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { useTranslation } from "react-i18next";

import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

export type ProviderAccountDetail = Awaited<
  ReturnType<AppRouterClient["providers"]["accounts"]["get"]>
>;
export type ProviderModel = ProviderAccountDetail["models"][number];

export function useProviderInvalidation() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.providers.key() });
    await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
  };
}

/** Runs a provider write with a success toast and localized refusal copy; true on success. */
export function useProviderAction() {
  const { t } = useTranslation(["dashboard"]);
  const invalidate = useProviderInvalidation();
  return async (work: () => Promise<unknown>, success = t("dashboard:pool.saved")) => {
    try {
      await work();
      await invalidate();
      toast.success(success);
      return true;
    } catch (error) {
      toast.error(refusalText(error));
      return false;
    }
  };
}
