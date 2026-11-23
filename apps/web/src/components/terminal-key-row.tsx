import { Button } from "@ws-model-proxy/ui/components/button";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Keyboard } from "lucide-react";
import { type PointerEvent, type ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { TerminalControls } from "@/hooks/use-xterm";
import {
  encodeTerminalKey,
  TERMINAL_HOLD_GRID_HINTS,
  TERMINAL_HOLD_GRID_KEYS,
  type TerminalNamedKey,
} from "@/lib/terminal-key-encoding";
import {
  type HoldGridLayout,
  HoldModifierGesture,
  holdGridLayout,
  type SwipeArrow,
  SwipePad,
} from "@/lib/terminal-key-gestures";
import { TERMINAL_CHROME_VARS } from "@/lib/terminal-theme";
import { type LatchableModifier, useTerminalModifiers } from "@/stores/terminal-modifiers";

type ControlsOf = () => TerminalControls | null;
type GridState = {
  modifier: LatchableModifier;
  hovered: string | null;
  layout: HoldGridLayout;
  /** Where the grid is portaled (the page's body, taken from the row when the grid opens). */
  container: HTMLElement;
};

/**
 * An on-screen key never takes focus: the terminal keeps it, so a phone's keyboard stays up.
 * (Without the compatibility mouse events a pressed pointer makes, nothing moves focus; the click
 * still comes.)
 */
const keepFocus = {
  onPointerDown: (event: PointerEvent) => event.preventDefault(),
  onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
  onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault(),
};

/** A key from the row: the latched Ctrl/Alt apply to it, then one-key latches end. */
function pressKey(controls: ControlsOf, key: TerminalNamedKey) {
  const terminal = controls();
  if (!terminal) return;
  const latch = useTerminalModifiers.getState();
  terminal.sendKeys(
    encodeTerminalKey(key, latch.active() ?? {}, {
      applicationCursor: terminal.applicationCursor(),
    }),
  );
  latch.consume();
}

/**
 * The Utilities key row (design D): keyboard toggle, Esc, Tab, Ctrl and Alt (tap = next key,
 * double-tap = lock, hold = letter grid), and a swipe pad for the arrows. It sits under the
 * terminal, so the root shell's keyboard inset keeps it above a phone's keyboard.
 */
export function TerminalKeyRow({ controls }: { controls: ControlsOf }) {
  const { t } = useTranslation("terminals");
  const [grid, setGrid] = useState<GridState | null>(null);
  return (
    // A size container: on the narrowest phones the keyboard toggle steps aside so every key
    // keeps a 44px target and the swipe pad keeps room.
    <div className="@container relative min-w-0 shrink-0" data-key-row="">
      {grid ? <HoldGrid {...grid} /> : null}
      <div role="toolbar" aria-label={t("keys.label")} className="flex min-w-0 gap-1">
        <RowKey
          label={t("keys.keyboard")}
          className="hidden @min-[19rem]:inline-flex"
          onPress={() => {
            const terminal = controls();
            if (!terminal) return;
            if (terminal.focused()) terminal.blur();
            else terminal.focus();
          }}
        >
          <Keyboard aria-hidden="true" />
        </RowKey>
        <RowKey label={t("keys.esc")} onPress={() => pressKey(controls, "Esc")}>
          Esc
        </RowKey>
        <RowKey label={t("keys.tab")} onPress={() => pressKey(controls, "Tab")}>
          Tab
        </RowKey>
        <ModifierKey modifier="ctrl" controls={controls} onGrid={setGrid} />
        <ModifierKey modifier="alt" controls={controls} onGrid={setGrid} />
        <SwipePadArea onArrow={(arrow) => pressKey(controls, arrow)} />
      </div>
    </div>
  );
}

function RowKey({
  label,
  onPress,
  className,
  children,
}: {
  label: string;
  onPress: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="touch"
      aria-label={label}
      title={label}
      className={cn("min-w-11 shrink-0 px-2 font-mono text-sm", className)}
      {...keepFocus}
      onClick={onPress}
    >
      {children}
    </Button>
  );
}

/** Ctrl or Alt: tap latches it for the next key, hold opens the letter grid. */
function ModifierKey({
  modifier,
  controls,
  onGrid,
}: {
  modifier: LatchableModifier;
  controls: ControlsOf;
  onGrid: (grid: GridState | null) => void;
}) {
  const { t } = useTranslation("terminals");
  const latch = useTerminalModifiers((state) => state[modifier]);
  const tap = useTerminalModifiers((state) => state.tap);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  /** The grid's layout and container, taken when it opens (the row may sit anywhere). */
  const openRef = useRef<Pick<GridState, "layout" | "container"> | null>(null);
  const [gesture] = useState(
    () =>
      new HoldModifierGesture(() => {
        const row = buttonRef.current?.closest("[data-key-row]");
        if (!row) return;
        const rect = row.getBoundingClientRect();
        const view = row.ownerDocument.defaultView;
        const layout = holdGridLayout({
          row: { left: rect.left, top: rect.top, width: rect.width },
          visibleTop: view?.visualViewport?.offsetTop ?? 0,
          viewportHeight: view?.innerHeight ?? rect.bottom,
          keys: TERMINAL_HOLD_GRID_KEYS.length,
        });
        const container = row.ownerDocument.body;
        openRef.current = { layout, container };
        onGrid({ modifier, hovered: null, layout, container });
      }),
  );
  /** The press opened the grid: its click is not a tap. */
  const heldRef = useRef(false);
  /** The finger (or mouse) this hold belongs to; a second finger does nothing here. */
  const pointerRef = useRef<number | null>(null);
  const name = t(`keys.${modifier}`);
  /** The grid key under a point, or null. */
  const keyAt = (event: PointerEvent) =>
    event.currentTarget.ownerDocument
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-grid-key]")?.dataset.gridKey ?? null;
  const finish = (event: PointerEvent, cancelled: boolean) => {
    if (event.pointerId !== pointerRef.current) return;
    pointerRef.current = null;
    const open = gesture.gridOpen;
    // The key is the one under the finger as it lifts, whatever the last move said.
    if (open && !cancelled) gesture.hover(keyAt(event));
    if (cancelled) gesture.cancel();
    const result = cancelled ? { kind: "none" as const } : gesture.release();
    if (open) {
      heldRef.current = true;
      onGrid(null);
    }
    if (result.kind !== "send") return;
    const terminal = controls();
    if (!terminal) return;
    // Latched modifiers join the held one, as they do for any other key, and a one-key latch ends.
    const latched = useTerminalModifiers.getState();
    terminal.sendKeys(
      encodeTerminalKey(
        result.key,
        { ...latched.active(), [modifier]: true },
        { applicationCursor: terminal.applicationCursor() },
      ),
    );
    latched.consume();
  };
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant={latch === "off" ? "outline" : "secondary"}
      size="touch"
      aria-pressed={latch !== "off"}
      aria-label={t(`keys.latch.${latch}`, { key: name })}
      title={t("keys.modifierHint", { key: name })}
      data-modifier={modifier}
      data-latch={latch}
      className={cn(
        "min-w-11 shrink-0 touch-none flex-col gap-0 px-1.5 font-mono text-sm leading-tight",
        latch === "lock" && "ring-1 ring-primary",
      )}
      {...keepFocus}
      onPointerDown={(event) => {
        event.preventDefault();
        if (pointerRef.current !== null) return;
        pointerRef.current = event.pointerId;
        heldRef.current = false;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // A synthetic pointer has nothing to capture.
        }
        gesture.press();
      }}
      onPointerMove={(event) => {
        if (event.pointerId !== pointerRef.current || !gesture.gridOpen) return;
        const key = keyAt(event);
        if (key === gesture.hoveredKey) return;
        gesture.hover(key);
        if (openRef.current) onGrid({ modifier, hovered: key, ...openRef.current });
      }}
      onPointerUp={(event) => finish(event, false)}
      onPointerCancel={(event) => finish(event, true)}
      onClick={() => {
        if (heldRef.current) {
          heldRef.current = false;
          return;
        }
        tap(modifier, performance.now());
      }}
    >
      <span>{name}</span>
      <span className="text-[10px] text-muted-foreground">{t(`keys.state.${latch}`)}</span>
    </Button>
  );
}

/**
 * Held Ctrl/Alt: slide to a key and lift to send it with the modifier. Fixed over the page, right
 * above the row, so no card clips it; its rows shrink to the room the keyboard leaves.
 */
function HoldGrid({ modifier, hovered, layout, container }: GridState) {
  const { t } = useTranslation("terminals");
  const hints = TERMINAL_HOLD_GRID_HINTS[modifier];
  return createPortal(
    <div
      role="presentation"
      // The terminal's colours: the grid sits outside the terminal box that sets them.
      style={{
        ...TERMINAL_CHROME_VARS,
        left: layout.left,
        width: layout.width,
        bottom: layout.bottom,
      }}
      className="fixed z-50 rounded-md border border-primary bg-(--term-chrome) p-2 text-(--term-fg) shadow-md"
    >
      <p className={layout.title ? "pb-1 text-xs text-(--term-muted)" : "sr-only"}>
        {t("keys.gridTitle", { key: t(`keys.${modifier}`) })}
      </p>
      {/* Keys 44px wide (fewer columns on narrower rows) unless the room is too short for that. */}
      <div
        className="grid gap-1"
        style={{
          gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
          gridAutoRows: `${layout.cellHeight}px`,
        }}
      >
        {TERMINAL_HOLD_GRID_KEYS.map((key) => {
          const hint = hints[key];
          return (
            <div
              key={key}
              data-grid-key={key}
              className={cn(
                "flex min-w-0 flex-col items-center justify-center rounded-sm bg-(--term-bg) font-mono text-sm",
                hovered === key && "bg-primary text-primary-foreground",
              )}
            >
              <span>{key}</span>
              {hint && layout.hints ? (
                <span className="max-w-full truncate text-[10px] opacity-70">
                  {t(`keys.hints.${hint}`)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>,
    container,
  );
}

/** Drag for arrow keys: one per 20 px along the axis the drag starts on. */
function SwipePadArea({ onArrow }: { onArrow: (arrow: SwipeArrow) => void }) {
  const { t } = useTranslation("terminals");
  const [pad] = useState(() => new SwipePad());
  const [shown, setShown] = useState<{ arrow: SwipeArrow; count: number } | null>(null);
  /** The finger (or mouse) the swipe belongs to; a second finger does nothing here. */
  const pointerRef = useRef<number | null>(null);
  const end = (event: PointerEvent) => {
    if (event.pointerId !== pointerRef.current) return;
    pointerRef.current = null;
    pad.end();
    setShown(null);
  };
  return (
    <div
      role="group"
      aria-label={t("keys.swipePad")}
      title={t("keys.swipePad")}
      data-swipe-pad=""
      className={cn(
        "flex min-h-11 min-w-11 flex-1 touch-none select-none items-center justify-center rounded-none border border-border border-dashed text-muted-foreground text-xs",
        shown && "border-primary text-foreground",
      )}
      onPointerDown={(event) => {
        event.preventDefault();
        if (pointerRef.current !== null) return;
        pointerRef.current = event.pointerId;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // A synthetic pointer has nothing to capture.
        }
        pad.start(event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        if (event.pointerId !== pointerRef.current || !pad.dragging) return;
        const arrows = pad.move(event.clientX, event.clientY);
        const last = arrows.at(-1);
        if (!last) return;
        for (const arrow of arrows) onArrow(arrow);
        setShown((current) => ({ arrow: last, count: (current?.count ?? 0) + arrows.length }));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onMouseDown={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span className="truncate" aria-hidden="true">
        {shown ? `${ARROW_GLYPHS[shown.arrow]} ×${shown.count}` : t("keys.swipe")}
      </span>
    </div>
  );
}

const ARROW_GLYPHS: Record<SwipeArrow, string> = {
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};
