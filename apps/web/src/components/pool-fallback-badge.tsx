import type { ExternalRouteKind } from "@ws-model-proxy/api/lib/model-api-token-access";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@ws-model-proxy/ui/components/popover";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Cloud } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const chipClassName =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[10px] font-medium";
const availableClassName = "border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100";

/**
 * Whether `owner/pool:external` can leave the deployment for this viewer.
 * Plain pool names never do. `routes` comes from the server (viewer-scoped);
 * `providers` must already be viewer-scoped too: account labels for the
 * owner, provider types for eligible grantees, never an owner's labels for
 * anyone else.
 *
 * The details open in a popover on tap, click, keyboard focus, keyboard
 * activation and hover, so they are reachable on touch devices and by
 * keyboard alone. Inside another interactive control
 * (a combobox trigger, a list option, a checkbox label) pass
 * `interactive={false}`; a nested button would be invalid there.
 */
export function PoolFallbackBadge({
  routes,
  providers = [],
  interactive = true,
}: {
  routes: readonly ExternalRouteKind[];
  providers?: readonly string[];
  interactive?: boolean;
}) {
  const { t } = useTranslation("dashboard");
  const [open, setOpen] = useState(false);
  // Keyboard focus opens the hint. Pointer focus does not (the click that
  // follows toggles it), and neither does the focus Base UI returns to the
  // trigger when the popover closes (that would reopen it after Escape).
  const pointerFocus = useRef(false);
  const returningFocus = useRef(false);
  const openedByFocus = useRef(false);
  if (routes.length === 0)
    return (
      <span
        data-fallback="local"
        className={cn(chipClassName, "border-border bg-muted text-muted-foreground")}
      >
        {t("dashboard:pools.fallbackBadge.local")}
      </span>
    );
  const label = (
    <>
      <Cloud className="size-3" aria-hidden="true" />
      {t("dashboard:pools.fallbackBadge.label")}
    </>
  );
  if (!interactive)
    return (
      <span data-fallback="available" className={cn(chipClassName, availableClassName)}>
        {label}
      </span>
    );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) openedByFocus.current = false;
        setOpen(next);
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        onPointerDown={() => {
          pointerFocus.current = true;
        }}
        onClick={() => {
          pointerFocus.current = false;
        }}
        onBlur={() => {
          pointerFocus.current = false;
        }}
        onFocus={() => {
          const skip = pointerFocus.current || returningFocus.current;
          pointerFocus.current = false;
          returningFocus.current = false;
          if (skip || open) return;
          openedByFocus.current = true;
          setOpen(true);
        }}
        render={
          <button
            type="button"
            data-fallback="available"
            className={cn(
              chipClassName,
              availableClassName,
              // 44px hit area around the 20px chip without changing the layout.
              "relative cursor-pointer outline-none after:absolute after:-inset-x-1 after:-inset-y-3 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring",
            )}
          />
        }
      >
        {label}
      </PopoverTrigger>
      <PopoverContent
        className="max-w-[calc(100vw-2rem)]"
        align="start"
        // Opened by focus: keep focus on the trigger so Tab moves on.
        initialFocus={() => !openedByFocus.current}
        finalFocus={() => {
          // Base UI focuses the trigger in a microtask after this call; skip
          // that one focus event, whether or not it happens.
          returningFocus.current = true;
          setTimeout(() => {
            returningFocus.current = false;
          }, 0);
          return true;
        }}
      >
        <PopoverTitle>{t("dashboard:pools.fallbackBadge.title")}</PopoverTitle>
        <PopoverDescription>{t("dashboard:pools.fallbackBadge.intro")}</PopoverDescription>
        <ul className="list-disc space-y-1 pl-4 text-xs">
          {routes.includes("pool-fallback") ? (
            <li>
              {providers.length
                ? t("dashboard:pools.fallbackBadge.routePoolFallback", {
                    providers: providers.join(", "),
                  })
                : t("dashboard:pools.fallbackBadge.routePoolFallbackUnnamed")}
            </li>
          ) : null}
          {routes.includes("own-key") ? (
            <li>{t("dashboard:pools.fallbackBadge.routeOwnKey")}</li>
          ) : null}
        </ul>
        <p className="text-xs text-muted-foreground">
          {t("dashboard:pools.fallbackBadge.consent")}
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** Routes on owner-only surfaces: an owner's pool can only use its own fallback. */
export function ownerFallbackRoutes(available: boolean): ExternalRouteKind[] {
  return available ? ["pool-fallback"] : [];
}
