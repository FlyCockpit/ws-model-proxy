// Locale constants live in `@ws-model-proxy/config/locales` so the API package can
// import the same source of truth. Re-exported here so existing call sites keep
// working.
export {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type Locale,
  SUPPORTED_LOCALES,
} from "@ws-model-proxy/config/locales";

export const NAMESPACES = [
  "common",
  "auth",
  "errors",
  "validation",
  "admin",
  "dashboard",
  "settings",
  "nav",
] as const;
