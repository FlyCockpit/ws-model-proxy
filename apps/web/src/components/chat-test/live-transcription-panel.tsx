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
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { useRealtimeTranscription } from "@/hooks/use-realtime-transcription";
import {
  problemMessageKey,
  type RealtimeItem,
  type RealtimeState,
} from "@/lib/realtime-transcription";

export type LiveModelOption = { modelId: string; label: string };

/**
 * The Chat Test header's microphone button and its panel. The panel is
 * mounted only while open: the microphone and socket live and die with it.
 */
export function LiveTranscriptionLauncher({
  models,
  modelsPending,
}: {
  models: LiveModelOption[];
  modelsPending: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon-touch"
        onClick={() => setOpen(true)}
        aria-label={t("dashboard:chatTest.live.open")}
        title={t("dashboard:chatTest.live.open")}
      >
        <Mic className="size-4" />
      </Button>
      {open ? (
        <LiveTranscriptionPanel
          open
          onOpenChange={setOpen}
          models={models}
          modelsPending={modelsPending}
        />
      ) : null}
    </>
  );
}

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
  const { state, start, commit, reset } = useRealtimeTranscription();
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const model =
    chosenModel && models.some((option) => option.modelId === chosenModel)
      ? chosenModel
      : (models[0]?.modelId ?? null);
  const running = state.phase === "starting" || state.phase === "live";

  const handleOpenChange = (next: boolean) => {
    // Closing ends the session.
    if (!next) reset();
    onOpenChange(next);
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t("dashboard:chatTest.live.title")}
      description={t("dashboard:chatTest.live.description")}
      className="sm:max-w-xl"
    >
      <div className="flex min-w-0 flex-col gap-4 pb-4">
        <ModelField
          models={models}
          modelsPending={modelsPending}
          model={model}
          disabled={running}
          onChange={setChosenModel}
        />
        <SessionControls
          phase={state.phase}
          model={model}
          onStart={(chosen) => void start({ model: chosen })}
          onCommit={commit}
          onStop={reset}
        />
        <p className="text-sm" role="status" aria-live="polite">
          {t(`dashboard:chatTest.live.status.${state.phase}`)}
        </p>
        <ProblemAlert problem={state.problem} />
        <div className="flex min-w-0 flex-col gap-2">
          <TranscriptList items={state.items} />
          <p className="text-xs text-muted-foreground">{t("dashboard:chatTest.live.privacy")}</p>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

function ModelField({
  models,
  modelsPending,
  model,
  disabled,
  onChange,
}: {
  models: LiveModelOption[];
  modelsPending: boolean;
  model: string | null;
  disabled: boolean;
  onChange: (modelId: string) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const ids = useId();
  let field: ReactNode;
  if (modelsPending) {
    field = <Skeleton className="h-11 w-full" />;
  } else if (models.length === 0) {
    field = (
      <p className="text-sm text-muted-foreground">{t("dashboard:chatTest.live.noModels")}</p>
    );
  } else {
    field = (
      <Select
        items={models.map((option) => ({ value: option.modelId, label: option.label }))}
        value={model}
        disabled={disabled}
        onValueChange={(value) => {
          if (typeof value === "string") onChange(value);
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
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${ids}-model`}>{t("dashboard:chatTest.live.model")}</Label>
      {field}
    </div>
  );
}

function SessionControls({
  phase,
  model,
  onStart,
  onCommit,
  onStop,
}: {
  phase: RealtimeState["phase"];
  model: string | null;
  onStart: (model: string) => void;
  onCommit: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  if (phase === "starting" || phase === "live") {
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="destructive" size="touch" onClick={onStop}>
          <Square className="size-4" />
          {t("dashboard:chatTest.live.stop")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="touch"
          disabled={phase !== "live"}
          onClick={onCommit}
        >
          <CornerDownLeft className="size-4" />
          {t("dashboard:chatTest.live.commit")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        size="touch"
        disabled={model === null}
        onClick={() => {
          if (model) onStart(model);
        }}
      >
        <Mic className="size-4" />
        {t("dashboard:chatTest.live.start")}
      </Button>
    </div>
  );
}

function ProblemAlert({ problem }: { problem: RealtimeState["problem"] }) {
  const { t } = useTranslation(["dashboard"]);
  if (!problem) return null;
  const key = problemMessageKey(problem);
  return (
    <p className="break-words text-sm text-destructive" role="alert">
      {t(`dashboard:chatTest.live.problems.${key}`)}
      {problem.kind === "server" && key === "server" ? ` (${problem.code})` : null}
    </p>
  );
}

function TranscriptList({ items }: { items: RealtimeItem[] }) {
  const { t } = useTranslation(["dashboard"]);
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("dashboard:chatTest.live.empty")}</p>;
  }
  return (
    <ol className="flex min-w-0 flex-col gap-2" aria-live="polite">
      {items.map((item) => (
        <li key={item.id} className="min-w-0 rounded-md border p-3 text-sm">
          <p className="whitespace-pre-wrap break-words">
            {item.text || t("dashboard:chatTest.live.transcribing")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{itemNote(item, t)}</p>
        </li>
      ))}
    </ol>
  );
}

function itemNote(
  item: RealtimeItem,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (item.status === "failed") return t("dashboard:chatTest.live.itemFailed");
  if (item.status === "transcribing") return t("dashboard:chatTest.live.transcribing");
  if (item.seconds === undefined) return null;
  return t("dashboard:chatTest.live.seconds", { seconds: item.seconds });
}
