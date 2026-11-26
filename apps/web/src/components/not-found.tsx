import { Link, useRouterState } from "@tanstack/react-router";
import { buttonVariants } from "@ws-model-proxy/ui/lib/button-variants";
import { useTranslation } from "react-i18next";

import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";

export default function NotFound() {
  const { t } = useTranslation("errors");
  const segment = useRouterState({ select: (state) => state.location.pathname.split("/")[1] });
  const lang = isSupportedLocale(segment) ? segment : DEFAULT_LOCALE;
  const { state } = useAuthSession();
  const signedIn = state.session !== null;
  // One short centred column, so the heading, the explanation and the action stay together on a
  // wide screen instead of starting at the left edge of a wide box.
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-prose flex-col items-center gap-4 p-4 text-center md:p-6">
      <h1 className="text-2xl font-semibold">{t("notFound")}</h1>
      <p className="text-sm text-muted-foreground">{t("notFoundDescription")}</p>
      {signedIn ? (
        <Link to="/$lang/overview" params={{ lang }} className={buttonVariants({ size: "touch" })}>
          {t("notFoundOverview")}
        </Link>
      ) : (
        <Link
          to="/$lang/login"
          params={{ lang }}
          search={{ redirectTo: undefined }}
          className={buttonVariants({ size: "touch" })}
        >
          {t("notFoundSignIn")}
        </Link>
      )}
    </div>
  );
}
