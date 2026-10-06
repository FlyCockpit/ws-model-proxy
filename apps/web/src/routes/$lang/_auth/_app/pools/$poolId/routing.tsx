import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { useTranslation } from "react-i18next";
import z from "zod";

import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import type { PoolView } from "@/lib/pool-ui";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId/routing")({
  component: PoolRoutingPage,
});

const PRIORITY = ["BACKGROUND", "NORMAL", "HIGH"] as const;

function PoolRoutingPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { poolId } = Route.useParams();
  const pool = useQuery(orpc.pools.get.queryOptions({ input: { poolId } }));
  if (pool.isPending) return <Skeleton className="h-80 w-full rounded-xl" aria-hidden="true" />;
  if (pool.isError)
    return <InlineRetry message={t("dashboard:pool.loadFailed")} onRetry={() => pool.refetch()} />;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <RoutingForm key={JSON.stringify(pool.data.routing)} pool={pool.data} />
      <OwnHardwareCard pool={pool.data} />
    </div>
  );
}

function RoutingForm({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const update = useMutation({
    ...orpc.pools.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const wholeNumber = (min: number, max: number) =>
    z
      .string()
      .refine(
        (value) =>
          value.trim() === "" ||
          (Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max),
        t("dashboard:pool.routing.numberRange", { min, max }),
      );
  const form = useForm({
    defaultValues: {
      priorityClass: pool.routing.priorityClass,
      concurrencyLimit:
        pool.routing.concurrencyLimit === null ? "" : String(pool.routing.concurrencyLimit),
      keptSlots: String(pool.routing.keptSlots),
      borrowKept: pool.routing.borrowKept,
    },
    validators: {
      onSubmit: z.object({
        priorityClass: z.enum(PRIORITY),
        concurrencyLimit: wholeNumber(1, 100_000),
        keptSlots: wholeNumber(0, 10_000),
        borrowKept: z.boolean(),
      }),
    },
    onSubmit: async ({ value }) => {
      try {
        await update.mutateAsync({
          poolId: pool.id,
          routing: {
            priorityClass: value.priorityClass,
            concurrencyLimit:
              value.concurrencyLimit.trim() === "" ? null : Number(value.concurrencyLimit),
            keptSlots: value.keptSlots.trim() === "" ? 0 : Number(value.keptSlots),
            borrowKept: value.borrowKept,
          },
        });
        await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
        toast.success(t("dashboard:pool.saved"));
      } catch (error) {
        toast.error(refusalText(error));
      }
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:pool.routing.title")}</CardTitle>
        <CardDescription>{t("dashboard:pool.routing.hint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit();
          }}
        >
          <form.Field name="priorityClass">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="routing-priority">{t("dashboard:pool.routing.priority")}</Label>
                <NativeSelect
                  id="routing-priority"
                  value={field.state.value}
                  onChange={(event) =>
                    field.handleChange(event.target.value as (typeof PRIORITY)[number])
                  }
                >
                  {PRIORITY.map((priority) => (
                    <option key={priority} value={priority}>
                      {t(`dashboard:pool.routing.priorities.${priority}`)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
          </form.Field>
          <form.Field name="concurrencyLimit">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="routing-cap">{t("dashboard:pool.routing.cap")}</Label>
                <Input
                  id="routing-cap"
                  inputMode="numeric"
                  className="h-11"
                  placeholder={t("dashboard:pool.routing.noCap")}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldErrors field={field} />
              </div>
            )}
          </form.Field>
          <form.Field name="keptSlots">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="routing-kept">{t("dashboard:pool.routing.kept")}</Label>
                <Input
                  id="routing-kept"
                  inputMode="numeric"
                  className="h-11"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("dashboard:pool.routing.keptHint")}
                </p>
                <FieldErrors field={field} />
              </div>
            )}
          </form.Field>
          <form.Field name="borrowKept">
            {(field) => (
              <div className="flex min-h-11 items-center gap-3">
                <Checkbox
                  id="routing-borrow"
                  checked={field.state.value}
                  onCheckedChange={(checked) => field.handleChange(checked === true)}
                />
                <Label htmlFor="routing-borrow">{t("dashboard:pool.routing.borrow")}</Label>
              </div>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(submitting) => (
              <Button type="submit" size="touch" disabled={submitting}>
                {submitting ? t("common:actions.saving") : t("common:actions.saveChanges")}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </CardContent>
    </Card>
  );
}

function OwnHardwareCard({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const set = useMutation({
    ...orpc.pools.routing.setOwnHardwareOnly.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:pool.routing.ownHardware")}</CardTitle>
        <CardDescription>{t("dashboard:pool.routing.ownHardwareHint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex min-h-11 items-center gap-3">
          <Switch
            id="own-hardware"
            checked={pool.routing.ownHardwareOnly}
            disabled={set.isPending}
            onCheckedChange={async (checked) => {
              try {
                await set.mutateAsync({ poolId: pool.id, enabled: checked === true });
                await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
                toast.success(t("dashboard:pool.saved"));
              } catch (error) {
                toast.error(refusalText(error));
              }
            }}
          />
          <Label htmlFor="own-hardware">{t("dashboard:pool.routing.ownHardwareLabel")}</Label>
        </div>
      </CardContent>
    </Card>
  );
}
