import { Button } from "@ws-model-proxy/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ws-model-proxy/ui/components/dropdown-menu";
import { Settings2 } from "lucide-react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";

import {
  isTerminalCopyMode,
  isTerminalShiftEnterMode,
  TERMINAL_COPY_MODES,
  TERMINAL_SHIFT_ENTER_MODES,
} from "@/lib/terminal-settings";
import { useUiPreferences } from "@/stores/ui-preferences";

/**
 * The terminal settings menu (copy requests, Shift+Enter). With `anchor` it has no button of its
 * own: the phone header opens it from the ⋯ menu's Terminal settings… item, under the ⋯ button.
 */
export function TerminalSettingsMenu({
  anchor,
}: {
  anchor?: {
    element: RefObject<HTMLElement | null>;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  };
}) {
  const { t } = useTranslation(["terminals"]);
  const copyMode = useUiPreferences((prefs) => prefs.terminalCopy);
  const setCopyMode = useUiPreferences((prefs) => prefs.setTerminalCopy);
  const shiftEnter = useUiPreferences((prefs) => prefs.terminalShiftEnter);
  const setShiftEnter = useUiPreferences((prefs) => prefs.setTerminalShiftEnter);
  return (
    <DropdownMenu
      {...(anchor ? { open: anchor.open, onOpenChange: (open) => anchor.onOpenChange(open) } : {})}
    >
      {anchor ? null : (
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-touch"
              aria-label={t("terminals:toolbar.settings")}
              title={t("terminals:toolbar.settings")}
            />
          }
        >
          <Settings2 aria-hidden="true" />
        </DropdownMenuTrigger>
      )}
      <DropdownMenuContent
        align="end"
        anchor={anchor?.element}
        className="w-80 max-w-[calc(100vw-2rem)]"
        aria-label={t("terminals:toolbar.settings")}
        {...(anchor ? { finalFocus: anchor.element } : {})}
      >
        <DropdownMenuRadioGroup
          value={copyMode}
          onValueChange={(value) => {
            if (isTerminalCopyMode(value)) setCopyMode(value);
          }}
        >
          <DropdownMenuLabel>{t("terminals:settings.copy.label")}</DropdownMenuLabel>
          {TERMINAL_COPY_MODES.map((mode) => (
            <SettingsRadioItem
              key={mode}
              value={mode}
              title={t(`terminals:settings.copy.${mode}.title`)}
              help={t(`terminals:settings.copy.${mode}.help`)}
            />
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={shiftEnter}
          onValueChange={(value) => {
            if (isTerminalShiftEnterMode(value)) setShiftEnter(value);
          }}
        >
          <DropdownMenuLabel>{t("terminals:settings.shiftEnter.label")}</DropdownMenuLabel>
          {TERMINAL_SHIFT_ENTER_MODES.map((mode) => (
            <SettingsRadioItem
              key={mode}
              value={mode}
              title={t(`terminals:settings.shiftEnter.${mode}.title`)}
              help={t(`terminals:settings.shiftEnter.${mode}.help`)}
            />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SettingsRadioItem({ value, title, help }: { value: string; title: string; help: string }) {
  return (
    <DropdownMenuRadioItem value={value} closeOnClick={false} className="min-h-11 items-start py-2">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{title}</span>
        <span className="text-muted-foreground text-xs">{help}</span>
      </span>
    </DropdownMenuRadioItem>
  );
}
