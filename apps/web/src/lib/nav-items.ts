import { isAdminRole } from "@ws-model-proxy/auth/roles";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Boxes,
  Cloud,
  Cpu,
  KeyRound,
  Layers,
  LayoutDashboard,
  ListChecks,
  Network,
  Server,
  Settings,
  Shield,
  SquareTerminal,
} from "lucide-react";

export type NavDirection = "forward" | "back" | "none";
type NavAudience = "public" | "authenticated" | "admin";
/**
 * - `sidebar`: the signed-in app sidebar (desktop) and the More sheet (mobile).
 * - `mobile`: the BottomNav tabs (the rest goes into More).
 * - `desktop`: the header's main nav.
 * - `userMenu`: the account menu.
 */
type NavPlacement = "desktop" | "mobile" | "sidebar" | "userMenu";

export type AppNavPath =
  | "/"
  | "/overview"
  | "/models"
  | "/pools"
  | "/runtimes"
  | "/profiles"
  | "/nodes"
  | "/providers"
  | "/access/api-keys"
  | "/activity"
  | "/terminals"
  | "/settings"
  | "/admin"
  | "/settings/security";
export type LangNavRoute = "/$lang" | `/$lang${Exclude<AppNavPath, "/">}`;

export type RouteNavItem = {
  /** Path WITHOUT the `/$lang/` prefix, starts with "/". Use "/" for root. */
  path: AppNavPath;
  /** Translation key. App nav keys live in `nav`; nested nav may use another namespace. */
  labelKey: string;
  /** Icon rendered by shell navigation surfaces. */
  icon: LucideIcon;
  /** `activeOptions.exact` for the <Link>. */
  exact: boolean;
};

export type AppNavId =
  | "overview"
  | "models"
  | "pools"
  | "runtimes"
  | "profiles"
  | "nodes"
  | "providers"
  | "access"
  | "activity"
  | "terminals"
  | "settings"
  | "admin";

export type AppNavItem = RouteNavItem & {
  id: AppNavId;
  audience: NavAudience;
  placements: readonly NavPlacement[];
  /** Sidebar group: the main sections, or the footer (terminals, settings, admin). */
  group: "main" | "footer";
  /** One-line hint shown under the label in the sidebar (`nav:hints.<id>`). */
  hintKey?: string;
};

type VisibleNavInput = {
  placement: NavPlacement;
  isAuthenticated: boolean;
  role?: unknown;
};

function section(
  id: AppNavId,
  path: AppNavPath,
  icon: LucideIcon,
  placements: readonly NavPlacement[],
  group: "main" | "footer" = "main",
  audience: NavAudience = "authenticated",
): AppNavItem {
  return {
    id,
    path,
    labelKey: `items.${id}`,
    hintKey: `hints.${id}`,
    icon,
    exact: false,
    audience,
    placements,
    group,
  };
}

/** Spec §7.1: one list, in sidebar order. */
const appNavItems: AppNavItem[] = [
  section("overview", "/overview", LayoutDashboard, ["desktop", "mobile", "sidebar"]),
  section("models", "/models", Boxes, ["mobile", "sidebar"]),
  section("pools", "/pools", Network, ["mobile", "sidebar"]),
  section("runtimes", "/runtimes", Cpu, ["mobile", "sidebar"]),
  section("profiles", "/profiles", ListChecks, ["sidebar"]),
  section("nodes", "/nodes", Server, ["sidebar"]),
  section("providers", "/providers", Cloud, ["sidebar"]),
  section("access", "/access/api-keys", KeyRound, ["sidebar"]),
  section("activity", "/activity", Activity, ["sidebar"]),
  section("terminals", "/terminals", SquareTerminal, ["sidebar"], "footer"),
  section("settings", "/settings", Settings, ["desktop", "sidebar", "userMenu"], "footer"),
  section("admin", "/admin", Shield, ["desktop", "sidebar", "userMenu"], "footer", "admin"),
];

function canSeeNavItem(item: AppNavItem, input: Pick<VisibleNavInput, "isAuthenticated" | "role">) {
  if (item.audience === "public") return true;
  if (!input.isAuthenticated) return false;
  if (item.audience === "authenticated") return true;
  return isAdminRole(input.role);
}

export function getNavItems(input: VisibleNavInput): AppNavItem[] {
  return appNavItems.filter(
    (item) => item.placements.includes(input.placement) && canSeeNavItem(item, input),
  );
}

export function toLangRoute(path: AppNavPath): LangNavRoute {
  if (path === "/") return "/$lang";
  return `/$lang${path}`;
}

/**
 * Settings sub-nav tabs, in left→right visual order. The array order is the source of truth
 * for `getNavDirection`'s sibling slide direction, so it MUST match the order rendered in
 * `settings.tsx`.
 */
export const settingsNavItems: RouteNavItem[] = [
  {
    path: "/settings",
    labelKey: "settings:navProfile",
    icon: Settings,
    exact: true,
  },
  {
    path: "/settings/security",
    labelKey: "settings:navSecurity",
    icon: Shield,
    exact: false,
  },
];

/** Icon for the mobile More sheet trigger. */
export const moreNavIcon: LucideIcon = Layers;

const NAV_LISTS: RouteNavItem[][] = [appNavItems, settingsNavItems];

export function stripLangPrefix(pathname: string): string {
  const match = pathname.match(/^\/[a-z]{2}(?:-[A-Z]{2})?(\/.*)?$/i);

  if (!match) {
    return pathname;
  }

  const rest = match[1] ?? "/";

  if (rest === "" || rest === "/") {
    return "/";
  }

  return rest;
}

export function getNavDirection(fromPath: string, toPath: string): NavDirection {
  if (fromPath === toPath) {
    return "none";
  }

  for (const list of NAV_LISTS) {
    const fromIndex = list.findIndex((item) => item.path === fromPath);
    const toIndex = list.findIndex((item) => item.path === toPath);

    if (fromIndex !== -1 && toIndex !== -1) {
      return toIndex < fromIndex ? "back" : "forward";
    }
  }

  if (fromPath !== "/" && toPath.startsWith(`${fromPath}/`)) {
    return "forward";
  }

  if (toPath !== "/" && fromPath.startsWith(`${toPath}/`)) {
    return "back";
  }

  return "forward";
}
