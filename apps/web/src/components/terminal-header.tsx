import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@ws-model-proxy/ui/components/alert-dialog";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ws-model-proxy/ui/components/dropdown-menu";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import {
  ChevronDown,
  Eye,
  Keyboard,
  Maximize2,
  Minimize2,
  Plus,
  Power,
  Settings2,
  TextSelect,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { TerminalSettingsMenu } from "@/components/terminal-settings-menu";
import { TerminalUtilities } from "@/components/terminal-utilities";
import type { TerminalControls } from "@/hooks/use-xterm";
import {
  pickerLabels,
  type TerminalTone,
  terminalInputIcon,
  terminalModeKeys,
  terminalTone,
} from "@/lib/terminal-header";
import type { TerminalWriterLabel } from "@/lib/terminal-protocol";
import { type TabStatus, tabEnded } from "@/lib/terminal-tab-status";

type PickerTab = {
  localId: string;
  status: TabStatus;
  writer: TerminalWriterLabel;
};

const TONE_CLASS: Record<TerminalTone, string> = {
  live: "text-(--state-success)",
  opening: "text-(--state-warning)",
  rejected: "text-destructive",
  exited: "text-muted-foreground",
};

/** Keyboard (you can type) or eye (view only), colored by the connection state. */
export function TerminalStatusIcon({ tab, className }: { tab: PickerTab; className?: string }) {
  const Icon = terminalInputIcon(tab) === "eye" ? Eye : Keyboard;
  const tone = terminalTone(tab.status);
  return (
    <Icon
      aria-hidden="true"
      data-icon={terminalInputIcon(tab)}
      data-tone={tone}
      className={cn("size-4 shrink-0", TONE_CLASS[tone], className)}
    />
  );
}

/** "Connected · typing", "Connected · viewing", "Ended"... */
function useModeText() {
  const { t } = useTranslation(["terminals"]);
  return (tab: PickerTab) => {
    const keys = terminalModeKeys(tab);
    return keys.mode ? `${t(keys.phase)} · ${t(keys.mode)}` : t(keys.phase);
  };
}

/**
 * The phone header's terminal picker: the visible terminal's status icon and name, opening the
 * list of open terminals and New terminal….
 */
export function TerminalPicker<T extends PickerTab>({
  tabs,
  activeLocalId,
  nameOf,
  onSelect,
  onNewTerminal,
}: {
  tabs: readonly T[];
  activeLocalId: string | null;
  nameOf: (tab: T) => string;
  onSelect: (localId: string) => void;
  onNewTerminal: () => void;
}) {
  const { t } = useTranslation(["terminals"]);
  const modeText = useModeText();
  const labels = pickerLabels(tabs, nameOf);
  const active = tabs.find((tab) => tab.localId === activeLocalId) ?? null;
  const activeLabel = active ? (labels.get(active) ?? nameOf(active)) : "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="secondary"
            size="touch"
            aria-label={
              active
                ? t("terminals:header.picker", { name: activeLabel, mode: modeText(active) })
                : t("terminals:header.pickerEmpty")
            }
            title={active ? `${activeLabel} · ${modeText(active)}` : undefined}
            className="min-w-0 flex-1 justify-start gap-2 pr-2 pl-2.5"
            data-terminal-picker=""
          />
        }
      >
        {active ? <TerminalStatusIcon tab={active} /> : null}
        <span className="min-w-0 truncate font-mono">{activeLabel}</span>
        <ChevronDown aria-hidden="true" className="ml-auto text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-1rem)]">
        <DropdownMenuRadioGroup
          value={activeLocalId ?? ""}
          onValueChange={(value) => {
            if (typeof value === "string" && value) onSelect(value);
          }}
        >
          <DropdownMenuLabel>{t("terminals:header.openTerminals")}</DropdownMenuLabel>
          {tabs.map((tab) => (
            <DropdownMenuRadioItem
              key={tab.localId}
              value={tab.localId}
              closeOnClick
              className="min-h-11 gap-2.5 py-1.5"
              data-picker-tab={tab.localId}
            >
              <TerminalStatusIcon tab={tab} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono">{labels.get(tab) ?? nameOf(tab)}</span>
                <span className="text-muted-foreground text-xs">{modeText(tab)}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="min-h-11 gap-2.5" onClick={onNewTerminal}>
          <Plus aria-hidden="true" />
          {t("terminals:header.newTerminal")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** End session asks first: it stops the shell for everyone viewing it. */
export function EndSessionDialog({
  open,
  onOpenChange,
  nodeName,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeName: string;
  onConfirm: () => void;
}) {
  const { t } = useTranslation(["terminals"]);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-[calc(100%-2rem)]! data-[size=default]:max-w-[calc(100%-2rem)]! data-[size=default]:sm:max-w-md! sm:max-w-md!">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("terminals:endConfirm.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("terminals:endConfirm.description", { node: nodeName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11">
            {t("terminals:utilities.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="min-h-11"
            data-end-confirm=""
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {t("terminals:endSession")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type HeaderTab = PickerTab & {
  /** An operator terminal ends with its step, never by End session. */
  stepId: string | null;
  ending: "pending" | "failed" | null;
};

/**
 * The phone header (640px wide or less): one fixed row, the same at every phone width. The
 * terminal picker, then ⋯ (Type & view: keys, paste, photo, text size, Select text; Session:
 * Terminal settings…, Stop viewing / Close tab, End session…), then Maximize/Restore in the
 * corner. Nothing moves into an overflow as the screen narrows, and there is no second row.
 */
export function PhoneTerminalHeader<T extends HeaderTab>({
  tabs,
  active,
  nameOf,
  onSelect,
  onNewTerminal,
  controls,
  cells,
  onCells,
  selecting,
  onToggleSelecting,
  maximized,
  onToggleMaximized,
  onDetach,
  onEndSession,
}: {
  tabs: readonly T[];
  active: T | null;
  nameOf: (tab: T) => string;
  onSelect: (localId: string) => void;
  onNewTerminal: () => void;
  controls: () => TerminalControls | null;
  cells: { cols: number; rows: number } | null;
  onCells: (cells: { cols: number; rows: number } | null) => void;
  selecting: boolean;
  onToggleSelecting: () => void;
  maximized: boolean;
  onToggleMaximized: () => void;
  /** Stop viewing (the shell keeps running), or Close tab on an ended terminal. */
  onDetach: (localId: string) => void;
  /** Runs only after the confirmation. */
  onEndSession: (localId: string) => void;
}) {
  const { t } = useTranslation(["terminals"]);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState<string | null>(null);
  const ended = active ? tabEnded(active.status) : false;
  const canEnd = active !== null && !ended && active.stepId === null;
  const confirming = tabs.find((tab) => tab.localId === confirmEnd) ?? null;
  const maximizeLabel = maximized
    ? t("terminals:toolbar.restore")
    : t("terminals:toolbar.maximize");
  return (
    <div className="flex min-w-0 items-center gap-1" data-terminal-header="phone">
      <TerminalPicker
        tabs={tabs}
        activeLocalId={active?.localId ?? null}
        nameOf={nameOf}
        onSelect={onSelect}
        onNewTerminal={onNewTerminal}
      />
      <TerminalUtilities
        variant="more"
        triggerRef={moreRef}
        controls={controls}
        disabled={active === null}
        cells={cells}
        onCells={onCells}
        extra={
          <>
            <DropdownMenuItem
              className="min-h-11"
              disabled={active === null}
              onClick={onToggleSelecting}
              data-utility="select"
            >
              <TextSelect aria-hidden="true" />
              <span className="flex-1">{t("terminals:toolbar.selectText")}</span>
              {selecting ? (
                <span className="text-muted-foreground text-xs">{t("terminals:header.on")}</span>
              ) : null}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("terminals:header.session")}</DropdownMenuLabel>
              <DropdownMenuItem
                className="min-h-11"
                onClick={() => setSettingsOpen(true)}
                data-utility="settings"
              >
                <Settings2 aria-hidden="true" />
                {t("terminals:header.settings")}
              </DropdownMenuItem>
              {active ? (
                <DropdownMenuItem
                  className="min-h-11"
                  onClick={() => onDetach(active.localId)}
                  data-utility="detach"
                >
                  <X aria-hidden="true" />
                  <span className="flex-1">
                    {ended ? t("terminals:closeTab") : t("terminals:detach")}
                  </span>
                  {ended ? null : (
                    <span className="text-muted-foreground text-xs">
                      {t("terminals:header.keepsRunning")}
                    </span>
                  )}
                </DropdownMenuItem>
              ) : null}
              {active && canEnd ? (
                <DropdownMenuItem
                  className="min-h-11 text-destructive focus:text-destructive [&_svg]:text-destructive!"
                  disabled={active.ending === "pending"}
                  onClick={() => setConfirmEnd(active.localId)}
                  data-utility="end"
                >
                  <Power aria-hidden="true" />
                  {active.ending === "pending"
                    ? t("terminals:ending")
                    : t("terminals:header.endSession")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
          </>
        }
      />
      <TerminalSettingsMenu
        anchor={{ element: moreRef, open: settingsOpen, onOpenChange: setSettingsOpen }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-touch"
        aria-pressed={maximized}
        aria-label={maximizeLabel}
        title={maximizeLabel}
        onClick={onToggleMaximized}
      >
        {maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
      </Button>
      <EndSessionDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmEnd(null);
        }}
        nodeName={confirming ? nameOf(confirming) : ""}
        onConfirm={() => {
          if (confirming) onEndSession(confirming.localId);
        }}
      />
    </div>
  );
}
