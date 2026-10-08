import { Button } from "@ws-model-proxy/ui/components/button";
import { CornerDownLeft, Mic, Square } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { useRealtimeTranscription } from "@/hooks/use-realtime-transcription";
import {
  problemMessageKey,
  type RealtimeItem,
  type RealtimeState,
} from "@/lib/realtime-transcription";

/**
 * Test → Live transcription: speak into the microphone and watch the target transcribe it
 * through the same live session API clients use (`/v1/realtime` events), signed in with the
 * dashboard session. The microphone and socket end when the panel unmounts (another target).
 */
export function LiveTranscriptionPanel({ model }: { model: string }) {
  const { t } = useTranslation(["dashboard"]);
  const { state, start, commit, stop } = useRealtimeTranscription();
  const titleId = useId();
  const running = state.phase === "starting" || state.phase === "live";
  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-lg border p-3"
      aria-labelledby={titleId}
    >
      <div className="min-w-0 space-y-1">
        <h2 id={titleId} className="text-base font-semibold">
          {t("dashboard:test.live.title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("dashboard:test.live.description")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {running ? (
          <>
            <Button type="button" variant="destructive" size="touch" onClick={stop}>
              <Square aria-hidden="true" className="size-4" />
              {t("dashboard:test.live.stop")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="touch"
              disabled={state.phase !== "live"}
              onClick={commit}
            >
              <CornerDownLeft aria-hidden="true" className="size-4" />
              {t("dashboard:test.live.commit")}
            </Button>
          </>
        ) : (
          <Button type="button" size="touch" onClick={() => void start({ model })}>
            <Mic aria-hidden="true" className="size-4" />
            {t("dashboard:test.live.start")}
          </Button>
        )}
      </div>
      <p className="text-sm" role="status" aria-live="polite">
        {t(`dashboard:test.live.status.${state.phase}`)}
      </p>
      <ProblemAlert problem={state.problem} />
      <TranscriptList items={state.items} />
      <p className="text-xs text-muted-foreground">{t("dashboard:test.live.privacy")}</p>
    </section>
  );
}

function ProblemAlert({ problem }: { problem: RealtimeState["problem"] }) {
  const { t } = useTranslation(["dashboard"]);
  if (!problem) return null;
  const key = problemMessageKey(problem);
  return (
    <p className="break-words text-sm text-destructive" role="alert">
      {t(`dashboard:test.live.problems.${key}`)}
      {problem.kind === "server" && key === "server" ? ` (${problem.code})` : null}
    </p>
  );
}

function TranscriptList({ items }: { items: RealtimeItem[] }) {
  const { t } = useTranslation(["dashboard"]);
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("dashboard:test.live.empty")}</p>;
  }
  return (
    <ol className="flex min-w-0 flex-col gap-2">
      {items.map((item) => (
        <li key={item.id} className="min-w-0 rounded-md border p-3 text-sm">
          <p className="whitespace-pre-wrap break-words">
            {item.text || t("dashboard:test.live.transcribing")}
          </p>
          <ItemNote item={item} />
        </li>
      ))}
    </ol>
  );
}

function ItemNote({ item }: { item: RealtimeItem }) {
  const { t } = useTranslation(["dashboard"]);
  const note =
    item.status === "failed"
      ? t("dashboard:test.live.itemFailed")
      : item.status === "transcribing"
        ? t("dashboard:test.live.transcribing")
        : item.seconds !== undefined
          ? t("dashboard:test.live.seconds", { seconds: item.seconds })
          : null;
  return note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null;
}
