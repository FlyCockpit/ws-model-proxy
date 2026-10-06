import { Button } from "@ws-model-proxy/ui/components/button";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ws-model-proxy/ui/components/select";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { CornerDownLeft, Mic, Square } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { useRealtimeTranscription } from "@/hooks/use-realtime-transcription";
import { problemMessageKey } from "@/lib/realtime-transcription";

export type LiveModelOption = { modelId: string; label: string };

/**
 * Chat Test → Live transcription: speak into the microphone and watch a
 * live-capable model transcribe it through the same live session API clients
 * use (`/v1/realtime` events). Signed in with the dashboard session, like the
 * rest of Chat Test: no token is asked for.
 */
export function LiveTranscriptionPanel({
  open,
  onOpenChange,
  models,
  modelsPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: LiveModelOption[];
  modelsPending: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const ids = useId();
  const { state, start, commit, reset } = useRealtimeTranscription();
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const model =
    chosenModel && models.some((option) => option.modelId === chosenModel)
      ? chosenModel
      : (models[0]?.modelId ?? null);
  const running = state.phase === "starting" || state.phase === "live";
  const canStart = !running && model !== null;

  const handleOpenChange = (next: boolean) => {
    // Closing ends the session.
    if (!next) reset();
    onOpenChange(next);
  };

  const problem = state.problem;
  const problemKey = problem ? problemMessageKey(problem) : null;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t("dashboard:chatTest.live.title")}
      description={t("dashboard:chatTest.live.description")}
      className="sm:max-w-xl"
    >
      <div className="flex min-w-0 flex-col gap-4 pb-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-model`}>{t("dashboard:chatTest.live.model")}</Label>
          {modelsPending ? (
            <Skeleton className="h-11 w-full" />
          ) : models.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("dashboard:chatTest.live.noModels")}</p>
          ) : (
            <Select
              items={models.map((option) => ({ value: option.modelId, label: option.label }))}
              value={model}
              disabled={running}
              onValueChange={(value) => {
                if (typeof value === "string") setChosenModel(value);
              }}
            >
              <SelectTrigger id={`${ids}-model`} className="min-h-[44px] w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {models.map((option) => (
                  <SelectItem key={option.modelId} value={option.modelId} className="min-h-[44px]">
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {running ? (
            <>
              <Button type="button" variant="destructive" size="touch" onClick={reset}>
                <Square className="size-4" />
                {t("dashboard:chatTest.live.stop")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="touch"
                disabled={state.phase !== "live"}
                onClick={commit}
              >
                <CornerDownLeft className="size-4" />
                {t("dashboard:chatTest.live.commit")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="touch"
              disabled={!canStart}
              onClick={() => {
                if (model) void start({ model });
              }}
            >
              <Mic className="size-4" />
              {t("dashboard:chatTest.live.start")}
            </Button>
          )}
        </div>

        <p className="text-sm" role="status" aria-live="polite">
          {t(`dashboard:chatTest.live.status.${state.phase}`)}
        </p>
        {problem && problemKey ? (
          <p className="break-words text-sm text-destructive" role="alert">
            {t(`dashboard:chatTest.live.problems.${problemKey}`)}
            {problem.kind === "server" && problemKey === "server" ? ` (${problem.code})` : null}
          </p>
        ) : null}

        <div className="flex min-w-0 flex-col gap-2">
          {state.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("dashboard:chatTest.live.empty")}</p>
          ) : (
            <ol className="flex min-w-0 flex-col gap-2" aria-live="polite">
              {state.items.map((item) => (
                <li key={item.id} className="min-w-0 rounded-md border p-3 text-sm">
                  <p className="whitespace-pre-wrap break-words">
                    {item.text || t("dashboard:chatTest.live.transcribing")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.status === "failed"
                      ? t("dashboard:chatTest.live.itemFailed")
                      : item.status === "transcribing"
                        ? t("dashboard:chatTest.live.transcribing")
                        : item.seconds !== undefined
                          ? t("dashboard:chatTest.live.seconds", { seconds: item.seconds })
                          : null}
                  </p>
                </li>
              ))}
            </ol>
          )}
          <p className="text-xs text-muted-foreground">{t("dashboard:chatTest.live.privacy")}</p>
        </div>
      </div>
    </ResponsiveDialog>
  );
}
