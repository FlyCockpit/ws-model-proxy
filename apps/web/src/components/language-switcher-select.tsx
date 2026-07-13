import { useMutation } from "@tanstack/react-query";
import { useParams, useRouter } from "@tanstack/react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ws-model-proxy/ui/components/select";
import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAuthSession } from "@/hooks/use-auth-session";
import { useHaptics } from "@/hooks/use-haptics";
import { isSupportedLocale, type Locale, SUPPORTED_LOCALES } from "@/i18n/config";
import { LOCALE_LABELS } from "@/i18n/labels";
import { orpc } from "@/utils/orpc";

/**
 * The real Base UI locale Select. Lazy-loaded by `language-switcher.tsx` on
 * first interaction so the shared Base UI overlay chunk stays off the eager
 * bundle. It mounts `defaultOpen` so the click that triggered the load opens
 * the list immediately — no effect, no second click.
 */
export default function LanguageSwitcherSelect() {
  const { i18n, t } = useTranslation();
  const { trigger } = useHaptics();
  const router = useRouter();
  // `strict: false` so the switcher renders under any matched route — the
  // top-level `/` redirect briefly mounts without `lang` in scope.
  const params = useParams({ strict: false });
  const { state, meta } = useAuthSession();

  // Silent server-side sync of the signed-in user's preference. The router's
  // global error toast handles failures — the URL switch already succeeded by
  // the time the mutation resolves, so a network error doesn't block the UI.
  const updateLocale = useMutation(orpc.auth.updateLocale.mutationOptions());

  const current: Locale = isSupportedLocale(i18n.language) ? i18n.language : "en-US";

  const handleChange = (value: Locale | null) => {
    if (!value || !isSupportedLocale(value)) return;
    trigger("selection");
    if (typeof window !== "undefined") {
      window.localStorage.setItem("locale", value);
    }
    // Swap the `lang` param in-place; preserve the current pathname suffix,
    // search, and hash. `to: "."` resolves to the active route, so the
    // updated `params` rebuild the URL with the new locale prefix.
    const currentLang = isSupportedLocale(params.lang) ? params.lang : null;
    if (currentLang) {
      void router.navigate({
        to: ".",
        params: (p: Record<string, unknown>) => ({ ...p, lang: value }),
        search: (s: Record<string, unknown>) => s,
        replace: true,
      });
    } else {
      // First load (the visitor is sitting on `/` mid-redirect) — point at
      // the new locale's home and let `$lang/` handle it.
      void router.navigate({ to: "/$lang", params: { lang: value }, replace: true });
    }
    // i18n.changeLanguage runs in `useChangeLanguage` once the URL updates,
    // but call it eagerly so the UI doesn't flash the old language.
    void i18n.changeLanguage(value);

    // Persist server-side so the choice follows the user across devices.
    // Skipped for unauthenticated visitors — there is nothing to persist to.
    if (
      state.status === "authenticated" &&
      !meta.isDegraded &&
      state.session.user.locale !== value
    ) {
      updateLocale.mutate({ locale: value });
    }
  };

  return (
    <Select value={current} onValueChange={handleChange} defaultOpen>
      <SelectTrigger
        aria-label={t("languageLabel", { ns: "nav" })}
        size="touch"
        className="w-11! justify-center gap-0 px-0 md:w-fit! md:justify-between md:gap-2 md:px-3 [&_svg:last-child]:hidden md:[&_svg:last-child]:block"
      >
        <Languages className="size-4" aria-hidden="true" />
        <SelectValue className="hidden! md:flex!">{LOCALE_LABELS[current]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {SUPPORTED_LOCALES.map((locale) => (
          <SelectItem key={locale} value={locale} className="min-h-[44px]">
            {LOCALE_LABELS[locale]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
