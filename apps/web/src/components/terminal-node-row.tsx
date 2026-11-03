import { Button } from "@ws-model-proxy/ui/components/button";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import type { TFunction } from "i18next";
import { GripVertical } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type Ref, useState } from "react";
import { useTranslation } from "react-i18next";

import { NativeSelect } from "@/components/native-select";
import type { NodeSummary } from "@/components/nodes/node-types";

/** A shell id as the node names it (`pwsh`, `powershell`, `cmd`, `wsl:<distro>`), for people. */
function shellName(t: TFunction, id: string): string {
  if (id.startsWith("wsl:")) return t("terminals:shell.wsl", { distro: id.slice(4) });
  if (id === "pwsh" || id === "powershell" || id === "cmd") return t(`terminals:shell.${id}`);
  return id;
}

/** Reordering a row of the Terminals node list (see `usePointerReorder`). */
export type TerminalNodeReorder = {
  rowRef: Ref<HTMLDivElement>;
  /** The handle's element id (focus returns to it after a keyboard move). */
  handleId: string;
  handleProps: {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
    onLostPointerCapture: () => void;
  };
  /** Move the row one place up (-1) or down (1). */
  onStep: (delta: -1 | 1) => void;
  /** The row being dragged. */
  dragging: boolean;
  /** Where the dragged row would land, beside this row. */
  dropMark: "before" | "after" | null;
};

/** The line where a dragged row would land. */
const DROP_MARK_CLASS = {
  before: "shadow-[inset_0_2px_0_0_var(--primary)]",
  after: "shadow-[inset_0_-2px_0_0_var(--primary)]",
  none: null,
} as const;

/** The grip at the start of a row: drag it, or focus it and press the up and down arrows. */
function ReorderHandle({ reorder, label }: { reorder: TerminalNodeReorder; label: string }) {
  const { t } = useTranslation(["terminals"]);
  const onKeyDown = (event: KeyboardEvent) => {
    const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : null;
    if (delta === null) return;
    event.preventDefault();
    reorder.onStep(delta);
  };
  return (
    <Button
      id={reorder.handleId}
      type="button"
      variant="ghost"
      size="icon-touch"
      className="shrink-0 cursor-grab touch-none select-none text-muted-foreground active:cursor-grabbing"
      aria-label={t("terminals:order.moveNode", { node: label })}
      aria-keyshortcuts="ArrowUp ArrowDown"
      title={t("terminals:order.moveNodeHint")}
      onKeyDown={onKeyDown}
      {...reorder.handleProps}
    >
      <GripVertical aria-hidden="true" />
    </Button>
  );
}

/** How a row looks while one is dragged: the dragged row dims, its landing place is lined. */
function reorderClass(reorder: TerminalNodeReorder | undefined): string | null {
  if (!reorder) return null;
  return cn(reorder.dragging && "opacity-50", DROP_MARK_CLASS[reorder.dropMark ?? "none"]);
}

/** Why a node cannot open a terminal now, if it cannot. */
function NodeStatus({ full, online }: { full: boolean; online: boolean }) {
  const { t } = useTranslation(["terminals"]);
  if (full && online) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {!full ? t("terminals:relayOnly") : t("terminals:offline")}
    </p>
  );
}

/** The shells a node names, its default (the first) marked. */
function ShellPicker({
  label,
  shells,
  value,
  disabled,
  onChange,
}: {
  label: string;
  shells: readonly string[];
  value: string | undefined;
  disabled: boolean;
  onChange: (shell: string) => void;
}) {
  const { t } = useTranslation(["terminals"]);
  const fallback = shells[0];
  return (
    <NativeSelect
      aria-label={t("terminals:shell.label", { node: label })}
      className="w-auto max-w-full"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {shells.map((id) => (
        <option key={id} value={id}>
          {id === fallback
            ? t("terminals:shell.default", { shell: shellName(t, id) })
            : shellName(t, id)}
        </option>
      ))}
    </NativeSelect>
  );
}

/**
 * One node of the Terminals list. A Windows node names its shells, its default first; the
 * picker starts on that default and only a different choice is sent. With `reorder`, a handle
 * at the start moves the row: drag it, or focus it and press the up and down arrows.
 */
export function TerminalNodeRow({
  node,
  ready,
  busy,
  opening,
  onOpen,
  reorder,
}: {
  node: NodeSummary;
  ready: boolean;
  busy: boolean;
  opening: boolean;
  onOpen: (shell: string | undefined) => void;
  reorder?: TerminalNodeReorder;
}) {
  const { t } = useTranslation(["terminals"]);
  const [chosen, setChosen] = useState<string | null>(null);
  const full = node.trust.effective === "FULL" && !node.trust.lowerPending;
  const online = node.connection === "ONLINE";
  const shells = node.terminalShells;
  const fallback = shells[0];
  // A choice the node no longer offers falls back to its default.
  const shell = chosen !== null && shells.includes(chosen) ? chosen : fallback;
  const label = node.name ?? node.slug;
  return (
    <div
      ref={reorder?.rowRef}
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0",
        reorderClass(reorder),
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        {reorder ? <ReorderHandle reorder={reorder} label={label} /> : null}
        <div className="min-w-0">
          <p className="truncate font-mono text-sm">{label}</p>
          <NodeStatus full={full} online={online} />
        </div>
      </div>
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
        {shells.length > 1 ? (
          <ShellPicker
            label={label}
            shells={shells}
            value={shell}
            disabled={!full || !online}
            onChange={setChosen}
          />
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="touch"
          disabled={!ready || !full || !online || busy}
          onClick={() => onOpen(shell !== fallback ? shell : undefined)}
        >
          {opening ? t("terminals:opening") : t("terminals:open")}
        </Button>
      </div>
    </div>
  );
}
