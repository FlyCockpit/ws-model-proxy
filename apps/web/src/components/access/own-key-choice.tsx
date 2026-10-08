import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";

import { NativeSelect } from "@/components/native-select";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

/**
 * A pool shared with you: use one of your own provider models (your key, your bill) for its
 * cloud fallback instead of the owner's. Offered only while the owner allows it, which the
 * share names with the model your key should stand in for. Reads the share from the shares
 * list already on the page.
 */
export function OwnKeyChoice({ shareId }: { shareId: string }) {
  const { t } = useTranslation(["access"]);
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const queryClient = useQueryClient();
  const shares = useQuery(orpc.access.shares.list.queryOptions());
  const share = shares.data?.withMe.find((candidate) => candidate.id === shareId);
  const equivalent = share?.ownKeyEquivalentModel ?? null;
  const models = useQuery({
    ...orpc.providers.models.list.queryOptions({ input: {} }),
    enabled: equivalent !== null,
  });
  const setOwnKey = useMutation({
    ...orpc.access.shares.setOwnKey.mutationOptions({
      onSuccess: async (_result, input) => {
        toast.success(
          input.providerModelId === null ? t("access:ownKey.cleared") : t("access:ownKey.saved"),
        );
        await queryClient.invalidateQueries({ queryKey: orpc.access.shares.list.key() });
      },
      onError: (error) => toast.error(refusalText(error)),
    }),
    meta: { skipGlobalErrorToast: true },
  });
  if (!share || equivalent === null) return null;
  const fieldId = `own-key-${share.id}`;
  const usable = (models.data?.models ?? []).filter(
    (model) => model.enabled || model.id === share.ownKeyProviderModelId,
  );
  // A chosen model that is gone from the list still shows as chosen (and can be cleared).
  const missing =
    share.ownKeyProviderModelId !== null &&
    !usable.some((model) => model.id === share.ownKeyProviderModelId);
  return (
    <div className="w-full min-w-0 basis-full space-y-1.5">
      <Label htmlFor={fieldId}>{t("access:ownKey.label")}</Label>
      {models.isPending ? (
        <Skeleton className="h-11 w-full" />
      ) : models.isError ? (
        <p className="text-sm text-muted-foreground">{t("access:ownKey.loadFailed")}</p>
      ) : usable.length === 0 && share.ownKeyProviderModelId === null ? (
        <p className="text-sm text-muted-foreground">
          {t("access:ownKey.noModels")}{" "}
          <Link
            to="/$lang/providers"
            params={{ lang }}
            className="inline-flex min-h-11 items-center underline underline-offset-4"
          >
            {t("access:ownKey.addProvider")}
          </Link>
        </p>
      ) : (
        <NativeSelect
          id={fieldId}
          value={share.ownKeyProviderModelId ?? ""}
          disabled={setOwnKey.isPending}
          onChange={(event) =>
            setOwnKey.mutate({ shareId: share.id, providerModelId: event.target.value || null })
          }
        >
          <option value="">{t("access:ownKey.ownerKey")}</option>
          {missing && share.ownKeyProviderModelId ? (
            <option value={share.ownKeyProviderModelId}>{t("access:ownKey.unavailable")}</option>
          ) : null}
          {usable.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName ?? model.upstreamModelId}
            </option>
          ))}
        </NativeSelect>
      )}
      <p className="text-xs text-muted-foreground">
        {t("access:ownKey.hint", { model: equivalent })}
      </p>
    </div>
  );
}
