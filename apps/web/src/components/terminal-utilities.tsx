import { Button } from "@ws-model-proxy/ui/components/button";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ws-model-proxy/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ws-model-proxy/ui/components/dropdown-menu";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Camera, ClipboardPaste, ImagePlus, Keyboard, Wrench } from "lucide-react";
import { type ChangeEvent, type ReactNode, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TerminalControls } from "@/hooks/use-xterm";
import { terminalImageProblem } from "@/lib/terminal-images";
import { stripPasteMarkers } from "@/lib/terminal-key-encoding";
import {
  TERMINAL_FONT_DEFAULT,
  TERMINAL_FONT_MAX,
  TERMINAL_FONT_MIN,
} from "@/lib/terminal-key-gestures";
import { useUiPreferences } from "@/stores/ui-preferences";

type ControlsOf = () => TerminalControls | null;
type Cells = { cols: number; rows: number };

/**
 * The Utilities button beside Select text: show or hide the key row, Paste…, Photo / camera…,
 * and the text size. Everything acts on the visible terminal.
 */
export function TerminalUtilities({
  controls,
  disabled,
  cells,
  onCells,
}: {
  controls: ControlsOf;
  disabled: boolean;
  /** The visible terminal's size, for the text size row. */
  cells: Cells | null;
  onCells: (cells: Cells | null) => void;
}) {
  const { t } = useTranslation("terminals");
  const keysShown = useUiPreferences((prefs) => prefs.terminalKeysShown);
  const setKeysShown = useUiPreferences((prefs) => prefs.setTerminalKeysShown);
  const fontSize = useUiPreferences((prefs) => prefs.terminalFontSize) ?? TERMINAL_FONT_DEFAULT;
  const setFontSize = useUiPreferences((prefs) => prefs.setTerminalFontSize);
  const [dialog, setDialog] = useState<"paste" | "photo" | null>(null);
  /**
   * Whether the terminal had focus (a phone's keyboard up) when the person reached for the menu:
   * it gets it back afterwards, and only then.
   */
  const refocusRef = useRef(false);
  const returnFocus = () =>
    refocusRef.current ? (controls()?.focusTarget() ?? undefined) : undefined;
  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) onCells(controls()?.size() ?? null);
        }}
      >
        <DropdownMenuTrigger
          disabled={disabled}
          onPointerDown={() => {
            refocusRef.current = controls()?.focused() ?? false;
          }}
          onKeyDown={() => {
            refocusRef.current = false;
          }}
          render={
            <Button
              type="button"
              variant="ghost"
              size="touch"
              aria-label={t("utilities.button")}
              title={t("utilities.button")}
              className="min-w-11 px-2.5"
            />
          }
        >
          <Wrench aria-hidden="true" />
          <span className="hidden sm:inline">{t("utilities.button")}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-72 max-w-[calc(100vw-2rem)]"
          finalFocus={(closeType) => {
            // Opening a dialog hands focus to it; otherwise back to the terminal if it had it.
            if (closeType === "keyboard") return true;
            return returnFocus() ?? true;
          }}
        >
          <DropdownMenuItem
            className="min-h-11"
            onClick={() => setKeysShown(!keysShown)}
            data-utility="keys"
          >
            <Keyboard aria-hidden="true" />
            <span className="flex-1">
              {keysShown ? t("utilities.hideKeys") : t("utilities.showKeys")}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11"
            onClick={() => setDialog("paste")}
            data-utility="paste"
          >
            <ClipboardPaste aria-hidden="true" />
            {t("utilities.paste")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11"
            onClick={() => setDialog("photo")}
            data-utility="photo"
          >
            <Camera aria-hidden="true" />
            {t("utilities.photo")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("utilities.textSize")}</DropdownMenuLabel>
            <div className="flex min-w-0 items-center gap-1 px-1 pb-1">
              <DropdownMenuItem
                closeOnClick={false}
                disabled={fontSize <= TERMINAL_FONT_MIN}
                aria-label={t("utilities.smaller")}
                title={t("utilities.smaller")}
                className="min-h-11 min-w-11 justify-center font-medium"
                onClick={() => setFontSize(fontSize - 1)}
                data-utility="smaller"
              >
                A−
              </DropdownMenuItem>
              <div
                className="flex min-w-0 flex-1 flex-col items-center text-sm"
                aria-live="polite"
                data-utility="size"
              >
                <span>{t("utilities.sizePx", { size: fontSize })}</span>
                {cells ? (
                  <span className="text-muted-foreground text-xs">
                    {t("utilities.cells", { cols: cells.cols, rows: cells.rows })}
                  </span>
                ) : null}
              </div>
              <DropdownMenuItem
                closeOnClick={false}
                disabled={fontSize >= TERMINAL_FONT_MAX}
                aria-label={t("utilities.larger")}
                title={t("utilities.larger")}
                className="min-h-11 min-w-11 justify-center font-medium"
                onClick={() => setFontSize(fontSize + 1)}
                data-utility="larger"
              >
                A+
              </DropdownMenuItem>
              <DropdownMenuItem
                closeOnClick={false}
                disabled={fontSize === TERMINAL_FONT_DEFAULT}
                className="min-h-11 justify-center"
                onClick={() => setFontSize(null)}
                data-utility="reset"
              >
                {t("utilities.reset")}
              </DropdownMenuItem>
            </div>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <PasteDialog
        open={dialog === "paste"}
        onClose={() => setDialog(null)}
        controls={controls}
        returnFocus={returnFocus}
      />
      <PhotoDialog
        open={dialog === "photo"}
        onClose={() => setDialog(null)}
        controls={controls}
        returnFocus={returnFocus}
      />
    </>
  );
}

type DialogProps = {
  open: boolean;
  onClose: () => void;
  controls: ControlsOf;
  /** Where focus goes when the dialog closes (the terminal, if it had it), or the default. */
  returnFocus: () => HTMLElement | undefined;
};

type Message = { tone: "ok" | "warn"; text: string } | null;

/** Paste text: from the clipboard where the browser allows it, or pasted into the box. */
function PasteDialog({ open, onClose, controls, returnFocus }: DialogProps) {
  const { t } = useTranslation("terminals");
  const [text, setText] = useState("");
  const [enter, setEnter] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const textId = useId();
  const enterId = useId();
  /** Bumped on close: a clipboard read still pending from before never fills a later opening. */
  const openingRef = useRef(0);
  const close = () => {
    openingRef.current += 1;
    setText("");
    setMessage(null);
    onClose();
  };
  const lines = text === "" ? 0 : text.split(/\r\n|\r|\n/).length;
  const bytes = new TextEncoder().encode(text).length;
  const bracketed = open ? (controls()?.bracketedPaste() ?? false) : false;
  const readClipboard = async () => {
    setMessage(null);
    const opening = openingRef.current;
    if (!navigator.clipboard?.readText) {
      setMessage({ tone: "warn", text: t("utilities.pasteDialog.clipboardUnavailable") });
      return;
    }
    try {
      const read = await navigator.clipboard.readText();
      if (opening !== openingRef.current) return;
      if (!read) {
        setMessage({ tone: "warn", text: t("utilities.pasteDialog.clipboardEmpty") });
        return;
      }
      setText(read);
      setMessage({ tone: "ok", text: t("utilities.pasteDialog.clipboardLoaded") });
    } catch {
      if (opening !== openingRef.current) return;
      setMessage({ tone: "warn", text: t("utilities.pasteDialog.clipboardBlocked") });
    }
  };
  const send = () => {
    const terminal = controls();
    if (!terminal || stripPasteMarkers(text).length === 0) {
      setMessage({ tone: "warn", text: t("utilities.pasteDialog.nothing") });
      return;
    }
    terminal.paste(text);
    if (enter) terminal.sendKeys("\r");
    close();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="max-h-[calc(var(--app-page-height,100dvh)-1rem)] overflow-x-hidden overflow-y-auto sm:max-w-md"
        finalFocus={() => returnFocus() ?? true}
      >
        <DialogHeader>
          <DialogTitle>{t("utilities.pasteDialog.title")}</DialogTitle>
          <DialogDescription>{t("utilities.pasteDialog.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor={textId} className="sr-only">
            {t("utilities.pasteDialog.textLabel")}
          </Label>
          <Textarea
            id={textId}
            rows={6}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("utilities.pasteDialog.placeholder")}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="max-h-60 font-mono text-sm"
            data-utility="paste-text"
          />
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="self-start"
            onClick={() => void readClipboard()}
          >
            <ClipboardPaste aria-hidden="true" />
            {t("utilities.pasteDialog.fromClipboard")}
          </Button>
          {message ? (
            <p
              role="status"
              className={cn(
                "text-xs",
                message.tone === "warn" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {message.text}
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs">
            {lines === 0
              ? t("utilities.pasteDialog.empty")
              : t("utilities.pasteDialog.summary", { count: lines, bytes })}{" "}
            {lines > 1
              ? bracketed
                ? t("utilities.pasteDialog.bracketed")
                : t("utilities.pasteDialog.notBracketed")
              : null}
          </p>
          <div className="flex min-h-11 items-center gap-3">
            <Checkbox
              id={enterId}
              checked={enter}
              onCheckedChange={(checked) => setEnter(checked === true)}
              data-utility="paste-enter"
            />
            <Label htmlFor={enterId} className="text-sm">
              {t("utilities.pasteDialog.enterAfter")}
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" size="touch" onClick={close}>
            {t("utilities.cancel")}
          </Button>
          <Button type="button" size="touch" onClick={send} data-utility="paste-send">
            {t("utilities.pasteDialog.send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A photo from the library or the camera, sent through the terminal's encrypted image paste. */
function PhotoDialog({ open, onClose, controls, returnFocus }: DialogProps) {
  const { t } = useTranslation("terminals");
  const [picked, setPicked] = useState<{ file: File; url: string } | null>(null);
  const chooseId = useId();
  const cameraId = useId();
  const forget = () => {
    if (picked) URL.revokeObjectURL(picked.url);
    setPicked(null);
  };
  const close = () => {
    forget();
    onClose();
  };
  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The same photo can be picked again.
    event.target.value = "";
    if (!file) return;
    forget();
    setPicked({ file, url: URL.createObjectURL(file) });
  };
  const problem = picked ? terminalImageProblem(picked.file) : null;
  const send = () => {
    const terminal = controls();
    if (!picked || !terminal) return;
    terminal.pasteImages([picked.file]);
    close();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="max-h-[calc(var(--app-page-height,100dvh)-1rem)] overflow-x-hidden overflow-y-auto sm:max-w-md"
        finalFocus={() => returnFocus() ?? true}
      >
        <DialogHeader>
          <DialogTitle>{t("utilities.photoDialog.title")}</DialogTitle>
          <DialogDescription>{t("utilities.photoDialog.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 flex-wrap gap-2">
            <FileButton id={chooseId} onChange={onFile} data-utility="photo-choose">
              <ImagePlus aria-hidden="true" />
              {t("utilities.photoDialog.choose")}
            </FileButton>
            <FileButton id={cameraId} onChange={onFile} capture data-utility="photo-camera">
              <Camera aria-hidden="true" />
              {t("utilities.photoDialog.camera")}
            </FileButton>
          </div>
          {picked ? (
            <div className="flex min-w-0 items-center gap-3">
              <img
                src={picked.url}
                alt={t("utilities.photoDialog.thumbnail")}
                className="size-20 shrink-0 rounded-sm object-cover ring-1 ring-foreground/10"
              />
              <div className="min-w-0 text-sm">
                <p className="truncate">{picked.file.name || t("utilities.photoDialog.unnamed")}</p>
                <p className="text-muted-foreground text-xs">
                  {t("utilities.photoDialog.meta", {
                    type: picked.file.type || "?",
                    size: Math.max(1, Math.round(picked.file.size / 1024)),
                  })}
                </p>
              </div>
            </div>
          ) : null}
          {problem ? (
            <p role="status" className="text-destructive text-xs">
              {problem === "unsupported" ? t("imagePaste.unsupported") : t("imagePaste.tooLarge")}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" size="touch" onClick={close}>
            {t("utilities.cancel")}
          </Button>
          <Button
            type="button"
            size="touch"
            disabled={!picked || problem !== null}
            onClick={send}
            data-utility="photo-send"
          >
            {t("utilities.photoDialog.send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A file input styled as a button (the label is the 44px target). */
function FileButton({
  id,
  onChange,
  capture = false,
  children,
  "data-utility": dataUtility,
}: {
  id: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  capture?: boolean;
  children: ReactNode;
  "data-utility": string;
}) {
  return (
    <label
      htmlFor={id}
      className="inline-flex h-11 shrink-0 cursor-pointer items-center gap-1.5 border border-border bg-background px-3.5 font-medium text-xs hover:bg-muted focus-within:ring-1 focus-within:ring-ring/50 dark:border-input dark:bg-input/30 dark:hover:bg-input/50 [&_svg]:size-4"
    >
      {children}
      <input
        id={id}
        type="file"
        accept="image/*"
        capture={capture ? "environment" : undefined}
        className="sr-only"
        onChange={onChange}
        data-utility={dataUtility}
      />
    </label>
  );
}
