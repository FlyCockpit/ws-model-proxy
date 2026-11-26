import { useParams } from "@tanstack/react-router";
import { cn } from "@ws-model-proxy/ui/lib/utils";

import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";

import { AppNameLink } from "./app-name-link";
import { LanguageSwitcher } from "./language-switcher";
import { MainNav } from "./main-nav";
import { ModeToggle } from "./mode-toggle";
import UserMenu from "./user-menu";

export default function Header() {
  // `strict: false` lets this component render under any route (including the
  // top-level `/` redirect) without throwing when the `lang` param is absent.
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const { state } = useAuthSession();
  const isAuthenticated = Boolean(state.session);

  return (
    <div data-app-header="" className="min-w-0">
      <div className="flex min-w-0 flex-row items-center gap-4 px-4 py-2">
        {/* The first thing in the row to give way (see AppNameLink). */}
        <AppNameLink lang={lang} />
        <MainNav />
        {/* Signed out (and while the session loads) nothing in the controls
            group can shrink, so it never does. Signed in, the account trigger
            (its name, from `md:` up) gives way once the app name is down to
            its 44px. */}
        <div
          className={cn("ml-auto flex min-w-0 items-center gap-2", !isAuthenticated && "shrink-0")}
        >
          <LanguageSwitcher />
          <ModeToggle />
          <UserMenu />
        </div>
      </div>
      <hr />
    </div>
  );
}
