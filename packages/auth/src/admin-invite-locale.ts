import { AsyncLocalStorage } from "node:async_hooks";
import type { Locale } from "@ws-model-proxy/config/locales";

const inviteLocale = new AsyncLocalStorage<Locale>();

/** Server-selected language, available to the user-create hook on the first insert. */
export function runWithAdminInviteLocale<T>(locale: Locale, create: () => T): T {
  return inviteLocale.run(locale, create);
}

export function getAdminInviteLocale(): Locale | undefined {
  return inviteLocale.getStore();
}
