import { useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ws-model-proxy/ui/components/dropdown-menu";
import { User } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { getNavItems, toLangRoute } from "@/lib/nav-items";
import { useDeferredSession } from "@/stores/session";

/**
 * The real Base UI account menu. Lazy-loaded by `user-menu.tsx` on first
 * interaction so the shared Base UI overlay chunk stays off the eager bundle
 * (UserMenu mounts in the root on every page). It mounts `defaultOpen` so the
 * click that triggered the load opens the menu immediately — no effect, no
 * second click. Only rendered when a session is present.
 */
export default function UserMenuContent() {
  const navigate = useNavigate();
  // `strict: false` so the menu renders under both prefixed and (briefly) the
  // top-level `/` redirect route without throwing.
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const { data: session } = useDeferredSession();
  const { t } = useTranslation("nav");

  // The shell only renders this once a session exists; guard defensively so a
  // session-expiry race can't dereference a null user.
  if (!session) return null;

  const userMenuItems = getNavItems({
    placement: "userMenu",
    isAuthenticated: true,
    role: session.user.role,
  });

  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger
        aria-label={t("userMenu.open")}
        render={
          <Button variant="outline" size="touch" className="w-11 px-0! md:w-auto md:px-3.5!" />
        }
      >
        <User className="size-4 md:hidden" aria-hidden="true" />
        <span className="hidden md:inline">{session.user.name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56 bg-card">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="space-y-0.5">
            <span className="block text-muted-foreground">{t("userMenu.myAccount")}</span>
            <span className="block truncate text-foreground">{session.user.name}</span>
            <span className="block truncate font-normal">{session.user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {userMenuItems.map((item) => (
            <DropdownMenuItem
              key={item.id}
              onClick={() => navigate({ to: toLangRoute(item.path), params: { lang } })}
            >
              <item.icon className="mr-2 size-4" />
              {t(item.labelKey)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={async () => {
              // Dynamic import so the better-auth client chunk stays off the
              // eager bundle (UserMenu renders in the root on every page). By
              // the time a signed-in user opens this menu, SessionSync has
              // already loaded the chunk, so this resolves from cache.
              const { authClient } = await import("@/lib/auth-client");
              authClient.signOut({
                fetchOptions: {
                  onSuccess: () => {
                    navigate({
                      to: "/$lang/login",
                      params: { lang },
                      search: { redirectTo: undefined },
                    });
                  },
                },
              });
            }}
          >
            {t("userMenu.signOut")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
