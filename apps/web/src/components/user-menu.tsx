import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { buttonVariants } from "@ws-model-proxy/ui/lib/button-variants";
import { toast } from "@ws-model-proxy/ui/lib/toast";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { LogIn, LogOut, RefreshCw, User, UserPlus } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { signOutAndLeave, signOutFailureKey } from "@/lib/explicit-sign-out";
import { runSessionCheck } from "@/lib/session-retry";
import { orpc } from "@/utils/orpc";

// Lazy so the shared Base UI overlay chunk (Menu/Dialog/focus-guards) leaves the
// eager first-paint bundle. Only the signed-in branch touches Base UI; the
// pending Skeleton and signed-out Buttons/Links stay fully eager. The shell
// below reproduces the trigger Button exactly, so the swap is zero-CLS.
const UserMenuContent = lazy(() => import("./user-menu-content"));

// Warm the chunk on hover/focus. The module cache dedupes repeat calls, so the
// click handler that follows resolves instantly from cache.
function prefetchMenu() {
  void import("./user-menu-content");
}

export default function UserMenu() {
  // `strict: false` so the menu renders under both prefixed and (briefly) the
  // top-level `/` redirect route without throwing.
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const authSession = useAuthSession();
  const { state } = authSession;
  const config = useQuery(orpc.app.config.queryOptions());
  const { t } = useTranslation("nav");
  const [mountedForUser, setMountedForUser] = useState<string | null>(null);
  const [retryQueued, setRetryQueued] = useState(false);

  if (state.status === "error" || authSession.meta.isDegraded) {
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="touch"
          aria-label={t(retryQueued ? "userMenu.retryQueued" : "userMenu.accountUnavailable")}
          aria-busy={retryQueued || authSession.meta.isRefetching}
          className="w-11 px-0 sm:w-auto sm:px-3.5"
          disabled={retryQueued || authSession.meta.isRefetching}
          onClick={() => {
            setRetryQueued(true);
            void runSessionCheck(authSession.actions.retry)
              .catch(() => {})
              .finally(() => setRetryQueued(false));
          }}
        >
          <RefreshCw
            className={cn(
              "size-4",
              (retryQueued || authSession.meta.isRefetching) &&
                "animate-spin motion-reduce:animate-none",
            )}
            aria-hidden="true"
          />
          <span className="hidden sm:inline">
            {t(retryQueued ? "userMenu.retryQueued" : "userMenu.accountUnavailable")}
          </span>
        </Button>
        <Button
          variant="outline"
          size="icon-touch"
          aria-label={t("userMenu.signOut")}
          onClick={async () => {
            const result = await signOutAndLeave(`/${lang}/login`);
            if (!result.ok) toast.error(t(signOutFailureKey(result.error)));
          }}
        >
          <LogOut className="size-4" aria-hidden="true" />
        </Button>
      </div>
    );
  }

  if (state.status === "pending") {
    return <Skeleton className="h-11 w-24" />;
  }

  if (state.status !== "authenticated") {
    // Default to NOT showing Sign Up until the flag is known, so it never
    // flashes when signup is disabled.
    const showSignUp =
      !config.isPending &&
      (config.data?.signupEnabled === true || config.data?.adminBootstrapSignupEnabled === true);
    return (
      <div className="flex items-center gap-2">
        {showSignUp && (
          <Link
            to="/$lang/signup"
            params={{ lang }}
            search={{ redirectTo: undefined }}
            aria-label={t("userMenu.signUp")}
            className={cn(buttonVariants({ size: "touch" }), "w-11 px-0 sm:w-auto sm:px-3.5")}
          >
            <UserPlus className="size-4 sm:hidden" aria-hidden="true" />
            <span className="hidden sm:inline">{t("userMenu.signUp")}</span>
          </Link>
        )}
        <Link
          to="/$lang/login"
          params={{ lang }}
          search={{ redirectTo: undefined }}
          aria-label={t("userMenu.signIn")}
          className={cn(
            buttonVariants({ size: "touch", variant: "outline" }),
            "w-11 px-0 sm:w-auto sm:px-3.5",
          )}
        >
          <LogIn className="size-4 sm:hidden" aria-hidden="true" />
          <span className="hidden sm:inline">{t("userMenu.signIn")}</span>
        </Link>
      </div>
    );
  }

  // The eager placeholder: visually identical to UserMenuContent's trigger so
  // there is no layout shift when the real control loads. `inert` while the
  // lazy chunk is in flight (Suspense fallback) so it can't take a second,
  // ignored click.
  const shell = (inert: boolean) => (
    <Button
      variant="outline"
      size="touch"
      aria-label={t("userMenu.open")}
      aria-haspopup="menu"
      // Same as UserMenuContent's trigger: from md: it is at most 192px, shrinks (to 44px) before
      // the header controls run past the trailing line, and truncates the name.
      className="w-11 px-0! md:w-auto md:min-w-11 md:max-w-48 md:shrink md:px-3.5!"
      title={state.session.user.name}
      inert={inert}
      onPointerEnter={prefetchMenu}
      onFocus={prefetchMenu}
      onClick={() => {
        prefetchMenu();
        setMountedForUser(state.session.user.id);
      }}
    >
      <User className="size-4 md:hidden" aria-hidden="true" />
      <span className="hidden truncate md:block">{state.session.user.name}</span>
    </Button>
  );

  if (mountedForUser !== state.session.user.id) return shell(false);

  return (
    <Suspense fallback={shell(true)}>
      <UserMenuContent key={state.session.user.id} />
    </Suspense>
  );
}
