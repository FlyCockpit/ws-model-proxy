import { Link, useParams } from "@tanstack/react-router";
import { buttonVariants } from "@ws-model-proxy/ui/components/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@ws-model-proxy/ui/components/sheet";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { NeedsYouBadge } from "@/components/needs-you-badge";
import { useAuthSession } from "@/hooks/use-auth-session";
import { useNeedsYouCount } from "@/hooks/use-needs-you-count";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { getNavItems, moreNavIcon as MoreIcon, toLangRoute } from "@/lib/nav-items";

const TAB_CLASS =
  "flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 transition-colors min-w-[64px] min-h-[44px]";

/**
 * The one mobile nav bar: Overview · Models · Pools · Runtimes · More (sheet with the rest).
 * More, and Terminals inside it, carry the Needs-you badge (spec §7.4).
 */
export default function BottomNav({ hidden }: { hidden?: boolean }) {
  // `strict: false` keeps this safe to render under any matched route (the top-level `/`
  // redirect leaves no `lang` param). Fall back to the default locale rather than crashing.
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const { state } = useAuthSession();
  const session = state.session;
  const { t } = useTranslation("nav");
  const [moreOpen, setMoreOpen] = useState(false);
  const needsYou = useNeedsYouCount(Boolean(session));
  const visible = { isAuthenticated: Boolean(session), role: session?.user.role };
  const tabs = getNavItems({ placement: "mobile", ...visible });
  const tabIds = new Set(tabs.map((item) => item.id));
  const rest = getNavItems({ placement: "sidebar", ...visible }).filter(
    (item) => !tabIds.has(item.id),
  );
  const badgeOf = (id: string) => (id === "terminals" ? needsYou : 0);
  const moreBadge = rest.reduce((sum, item) => sum + badgeOf(item.id), 0);
  const withBadge = (label: string, count: number) =>
    count > 0 ? `${label}, ${t("needsYou.badge", { count })}` : label;

  if (hidden || tabs.length === 0) return null;

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background/80 backdrop-blur-lg md:hidden"
      style={{ paddingBottom: "var(--safe-area-bottom)" }}
    >
      <div className="flex h-14 items-center justify-around">
        {tabs.map((item) => (
          <Link
            key={item.id}
            to={toLangRoute(item.path)}
            params={{ lang }}
            activeOptions={{ exact: item.exact }}
            className={cn(TAB_CLASS, "text-muted-foreground")}
            activeProps={{ className: cn(TAB_CLASS, "text-primary") }}
          >
            <item.icon className="size-5" />
            <span className="text-[10px] font-medium leading-tight">{t(item.labelKey)}</span>
          </Link>
        ))}
        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-label={withBadge(t("items.more"), moreBadge)}
            className={cn(TAB_CLASS, "text-muted-foreground")}
            onClick={() => setMoreOpen(true)}
          >
            <span className="relative">
              <MoreIcon aria-hidden="true" className="size-5" />
              <NeedsYouBadge count={moreBadge} className="absolute -end-3 -top-2" />
            </span>
            <span className="text-[10px] font-medium leading-tight">{t("items.more")}</span>
          </button>
          <SheetContent
            side="bottom"
            className="max-h-[85dvh] overflow-x-hidden overflow-y-auto"
            style={{ paddingBottom: "var(--safe-area-bottom)" }}
          >
            <SheetHeader>
              <SheetTitle>{t("items.more")}</SheetTitle>
            </SheetHeader>
            <div className="flex flex-col gap-1 px-4 pb-4">
              {rest.map((item) => (
                <Link
                  key={item.id}
                  to={toLangRoute(item.path)}
                  params={{ lang }}
                  activeOptions={{ exact: item.exact }}
                  onClick={() => setMoreOpen(false)}
                  aria-label={
                    badgeOf(item.id) > 0 ? withBadge(t(item.labelKey), badgeOf(item.id)) : undefined
                  }
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "touch" }),
                    "h-auto justify-start gap-3 py-2 text-muted-foreground",
                  )}
                  activeProps={{ className: "bg-muted text-foreground" }}
                >
                  <item.icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="flex min-w-0 flex-col items-start">
                    <span>{t(item.labelKey)}</span>
                    {item.hintKey ? (
                      <span className="text-xs font-normal text-muted-foreground">
                        {t(item.hintKey)}
                      </span>
                    ) : null}
                  </span>
                  <NeedsYouBadge count={badgeOf(item.id)} className="ms-auto" />
                </Link>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </nav>
  );
}
