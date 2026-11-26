/**
 * `pnpm check:layout`: real-browser geometry check of the shell rules, run
 * against a running dev server. Rules and usage:
 * docs/ui.md § Shell rules
 * docs/ui.md § Layout check
 * It is not part of CI: it needs agent-browser and its Chromium plus a
 * running app. Run it after touching the root shell, the header, page-level
 * chrome or the toast theme.
 *
 *   pnpm check:layout --url http://localhost:3001
 *   CHECK_LAYOUT_PASSWORD=… pnpm check:layout --url … --admin you@example.com
 *                                         also checks the signed-in 404 and
 *                                         an admin page (CHECK_LAYOUT_TOTP for 2FA;
 *                                         the password comes from
 *                                         the environment only)
 *   pnpm check:layout --url … --accounts <credentials.json>
 *   pnpm check:layout --url … --no-sandbox   Ubuntu 23.10+ (AppArmor) Chromium
 *
 * At 390×844, 1280×800, 1440×1600 and 390×300 (where every page scrolls), on
 * the sign-in page, the 404 and (with --admin) the signed-in 404 and the
 * admin users page, it checks that:
 * - the document never scrolls and `<main id="main-content">` is the scroller;
 * - every page, the 404 included, renders inside the shell (its header);
 * - `<main>` reserves no scrollbar gutter, and every full-width rule (header
 *   `<hr>`, the admin sub-nav's `border-b`) spans the viewport (inside a
 *   scrolling `<main>`, up to its visible scrollbar);
 * - a toast (a failed sign-in; with --admin also a failed query's toast with
 *   its Retry action, at rest and hovered), stored theme light then dark with
 *   the OS set to the other one, renders in the stored theme and is filled
 *   with its popover colour (not inverted), and its title, badge and action
 *   label reach 4.5:1 on it (the label on its own tint).
 *
 * Classic (non-overlay) scrollbars are what expose a reserved gutter; headless
 * Chromium on Linux draws them, overlay scrollbars on macOS hide the defect.
 */
import {
  type CheckRun,
  formSignIn,
  sessionName,
  stopped,
  totpCode,
  withBrowser,
} from "./browser-check-lib.ts";
import { seededAccounts } from "./browser-checks.config.ts";

const SESSION = sessionName("check-layout");

/** What the in-page probe reports. Pure data, so `judgeLayout` is testable. */
export interface Probe {
  vw: number;
  docScroll: number;
  header: boolean;
  /** `scrollbar`: the width `<main>` gives up to a scrollbar right now (offsetWidth − clientWidth). */
  main: { scrollable: boolean; scrollbar: number } | null;
  /** `inMain`: the rule is inside the scroller, so a visible scrollbar is its right edge. */
  rules: { name: string; left: number; right: number; inMain: boolean }[];
  toast: {
    dark: boolean;
    fill: string;
    popover: string;
    title: number;
    badge: number;
    button: number | null;
  } | null;
}

export interface Expect {
  /** The theme the stored choice asks for; the OS is set to the opposite one. */
  toast?: "light" | "dark";
  /** The toast must carry an action button (its label is measured on its own tint). */
  action?: boolean;
}

/** Returns one message per broken rule; empty means the page passes. */
export function judgeLayout(page: string, probe: Probe, expect: Expect): string[] {
  const bad: string[] = [];
  if (probe.docScroll > 0)
    bad.push(`${page}: the document scrolls by ${probe.docScroll}px; only <main> may scroll`);
  if (!probe.main) bad.push(`${page}: no <main id="main-content"> scroller`);
  if (!probe.header) bad.push(`${page}: no shell header`);
  // A scrollable scroller shows a scrollbar at the viewport's right edge, and a
  // rule inside it meets that scrollbar, as on any scrolling page. A scroller
  // that does not scroll but still gives up width reserves an empty gutter.
  const scrollbar = probe.main?.scrollable ? probe.main.scrollbar : 0;
  if (probe.main && !probe.main.scrollable && probe.main.scrollbar > 0)
    bad.push(
      `${page}: <main> reserves a ${probe.main.scrollbar}px scrollbar gutter on a page that does not scroll`,
    );
  for (const rule of probe.rules) {
    const edge = probe.vw - (rule.inMain ? scrollbar : 0);
    if (rule.left > 0 || edge - rule.right > 0)
      bad.push(
        `${page}: ${rule.name} spans ${rule.left}…${rule.right}px, not 0…${edge}px; full-bleed rules reach both edges`,
      );
  }
  if (expect.toast) {
    const toast = probe.toast;
    if (!toast) bad.push(`${page}: no toast appeared`);
    else {
      if (toast.dark !== (expect.toast === "dark"))
        bad.push(
          `${page}: the stored ${expect.toast} theme lost to the OS (the page rendered ${toast.dark ? "dark" : "light"})`,
        );
      if (toast.fill !== toast.popover)
        bad.push(
          `${page}: the toast is filled ${toast.fill}, not the ${toast.dark ? "dark" : "light"} theme's popover ${toast.popover}`,
        );
      if (expect.action && toast.button === null) bad.push(`${page}: the toast has no action`);
      for (const [part, ratio] of [
        ["title", toast.title],
        ["badge", toast.badge],
        ["action", toast.button],
      ] as const) {
        if (ratio !== null && ratio < 4.5)
          bad.push(`${page}: toast ${part} contrast ${ratio}:1 is below 4.5:1`);
      }
    }
  }
  return bad;
}

/** Loading UI must clear before stable height reads count. */
export const LOADING_MARKER = '[data-slot="skeleton"], [aria-busy="true"], [data-route-skeleton]';

export const SETTLED = `(async () => {
  const main = [...document.querySelectorAll("#main-content")].find((el) => el.checkVisibility());
  if (!main) return JSON.stringify("settled");
  let last = -1;
  let still = 0;
  let loading = false;
  for (let i = 0; i < 80 && still < 5; i++) {
    const height = main.scrollHeight;
    loading = !!main.querySelector(${JSON.stringify(LOADING_MARKER)});
    still = !loading && height === last ? still + 1 : 0;
    last = loading ? -1 : height;
    await new Promise((r) => setTimeout(r, 100));
  }
  return JSON.stringify(still >= 5 ? "settled" : loading ? "loading" : "changing");
})()`;

// Runs in the page (agent-browser eval). Self-contained: no closures.
const PROBE = `(async () => {
  const html = document.documentElement;
  const vw = html.clientWidth;
  const main = document.getElementById("main-content");
  const out = { vw, docScroll: document.scrollingElement.scrollHeight - window.innerHeight, header: false, main: null, rules: [], toast: null };
  if (main) out.main = { scrollable: main.scrollHeight > main.clientHeight, scrollbar: main.offsetWidth - main.clientWidth };
  // The shell header (components/header.tsx) is the row above <main>, closed by its <hr>.
  for (const hr of document.querySelectorAll("hr")) {
    if (main && main.contains(hr)) continue;
    out.header = true;
    out.rules.push({ name: "header <hr>", left: Math.round(hr.getBoundingClientRect().left), right: Math.round(hr.getBoundingClientRect().right), inMain: false });
  }
  for (const nav of document.querySelectorAll("main nav.border-b")) out.rules.push({ name: "sub-nav border-b", left: Math.round(nav.getBoundingClientRect().left), right: Math.round(nav.getBoundingClientRect().right), inMain: true });
  const pill = document.querySelector("[data-sileo-viewport] [data-sileo-pill]");
  if (pill) {
    const ctx = document.createElement("canvas").getContext("2d");
    const rgb = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = (p) => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };
    const probe = document.createElement("div");
    probe.style.color = "var(--popover)";
    document.body.append(probe);
    const popover = rgb(getComputedStyle(probe).color);
    probe.remove();
    const fill = rgb(getComputedStyle(pill).fill);
    const color = (sel) => { const el = document.querySelector("[data-sileo-viewport] " + sel); return el ? rgb(getComputedStyle(el).color) : null; };
    const title = color("[data-sileo-title]"), badge = color("[data-sileo-badge]"), button = color("[data-sileo-button]");
    // The action's label sits on its own tint (sileo's --sileo-btn-bg), composited over the pill.
    const buttonEl = document.querySelector("[data-sileo-viewport] [data-sileo-button]");
    let behind = fill;
    if (buttonEl) { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "rgb(" + fill.join(",") + ")"; ctx.fillRect(0, 0, 1, 1); ctx.fillStyle = getComputedStyle(buttonEl).backgroundColor; ctx.fillRect(0, 0, 1, 1); behind = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); }
    out.toast = { dark: html.classList.contains("dark"), fill: fill.join(","), popover: popover.join(","), title: title ? ratio(title, fill) : 0, badge: badge ? ratio(badge, fill) : 0, button: button ? ratio(button, behind) : null };
  }
  return JSON.stringify(out);
})()`;

const THEME_KEY = "vite-ui-theme";

interface Page {
  name: string;
  path: string;
  admin: boolean;
  expect: Expect;
  /** Wait for this selector before probing. */
  ready: string;
}

const PAGES: Page[] = [
  {
    name: "sign-in",
    path: "/en-US/login",
    admin: false,
    expect: {},
    ready: "form button[type=submit]",
  },
  { name: "404", path: "/en-US/check-layout-missing", admin: false, expect: {}, ready: "main h1" },
  {
    name: "404 signed in",
    path: "/en-US/check-layout-missing",
    admin: true,
    expect: {},
    ready: "main h1",
  },
  {
    name: "admin users",
    path: "/en-US/admin/users",
    admin: true,
    expect: {},
    ready: "main nav.border-b",
  },
];
const VIEWPORTS = [
  [390, 844],
  [1280, 800],
  [1440, 1600],
  [390, 300],
] as const;

export async function measure(run: CheckRun): Promise<string[]> {
  const { base, args, browser: client } = run;
  const browser = (args: string[], input?: string) => client.run(args, input);
  const evalJson = <T>(script: string) => client.evalJson<T>(script);
  const option = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const accounts = args.includes("--accounts") ? seededAccounts(args) : undefined;
  const admin = accounts?.admin.email ?? option("--admin");
  const password = accounts?.admin.password ?? process.env.CHECK_LAYOUT_PASSWORD;
  const secret = accounts ? accounts.admin.totp?.secret : process.env.CHECK_LAYOUT_TOTP;
  const signIn = async () => {
    if (!admin || !password) throw new Error("--admin requires CHECK_LAYOUT_PASSWORD");
    await browser(["cookies", "clear"]);
    await browser(["set", "viewport", "1280", "800"]);
    await formSignIn(run, {
      email: admin,
      password,
      totp: secret ? () => totpCode(secret) : undefined,
    });
  };
  if (admin && !password) throw new Error("--admin requires CHECK_LAYOUT_PASSWORD");
  const failures: string[] = [];
  try {
    await browser(["cookies", "clear"]);
    if (!admin) console.log("check:layout: no --admin, so the signed-in pages are skipped");
    // Signed out first (the sign-in page sends a signed-in visitor on), then
    // the signed-in pages with one sign-in.
    for (const signedIn of [false, true]) {
      if (signedIn && !(admin && password)) continue;
      if (signedIn && admin && password) await signIn();
      for (const [w, h] of VIEWPORTS) {
        await browser(["set", "viewport", String(w), String(h)]);
        for (const page of PAGES.filter((page) => page.admin === signedIn)) {
          await browser(["open", `${base}${page.path}`]);
          await browser(["wait", page.ready]);
          const label = `${page.name} ${w}×${h}`;
          const settled = await evalJson<string>(SETTLED);
          if (settled !== "settled") {
            failures.push(
              `${label}: ${settled === "loading" ? "still showing a loading skeleton after 8s; check that its data loads" : "content kept changing for 8s"}`,
            );
            continue;
          }
          const probe = await evalJson<Probe>(PROBE);
          failures.push(...judgeLayout(label, probe, page.expect));
          console.log(
            `check:layout: ${label} measured (${probe.main?.scrollable ? "long" : "short"} page)`,
          );
        }
      }
    }
    // Toasts: a failed sign-in shows the error toast. Light and dark, at one width.
    await browser(["cookies", "clear"]);
    await browser(["set", "viewport", "1280", "800"]);
    for (const theme of ["light", "dark"] as const) {
      await browser(["set", "media", theme === "dark" ? "light" : "dark"]);
      await browser(["open", `${base}/en-US/login`]);
      await browser(["eval", `localStorage.setItem('${THEME_KEY}', '${theme}'); true`]);
      await browser(["open", `${base}/en-US/login`]);
      await browser(["wait", "form button[type=submit]"]);
      await browser(["fill", "input[type=email]", "check-layout@invalid.test"]);
      await browser(["fill", "input[type=password]", "check-layout-wrong-password"]);
      await browser(["click", "form button[type=submit]"]);
      await browser(["wait", "[data-sileo-viewport] [data-sileo-pill]"]);
      await browser(["wait", "800"]);
      failures.push(
        ...judgeLayout(`toast ${theme}`, await evalJson<Probe>(PROBE), { toast: theme }),
      );
      console.log(`check:layout: toast ${theme} measured`);
    }
    // An action toast: with every oRPC call aborted, the admin users query fails and the app's
    // query cache shows its error toast with Retry. Its label is measured at rest and hovered.
    if (admin && password) {
      await signIn();
      for (const theme of ["light", "dark"] as const) {
        await browser(["set", "media", theme === "dark" ? "light" : "dark"]);
        await browser(["eval", `localStorage.setItem('${THEME_KEY}', '${theme}'); true`]);
        await browser(["network", "route", "**/rpc/**", "--abort"]);
        try {
          await browser(["open", `${base}/en-US/admin/users`]);
          await browser(["wait", "[data-sileo-viewport] [data-sileo-button]"]);
          await browser(["wait", "800"]);
          const expect = { toast: theme, action: true } as const;
          failures.push(
            ...judgeLayout(`action toast ${theme}`, await evalJson<Probe>(PROBE), expect),
          );
          await browser(["hover", "[data-sileo-viewport] [data-sileo-button]"]);
          await browser(["wait", "400"]);
          failures.push(
            ...judgeLayout(`action toast ${theme} hovered`, await evalJson<Probe>(PROBE), expect),
          );
        } finally {
          await browser(["network", "unroute"]);
        }
        console.log(`check:layout: action toast ${theme} measured`);
      }
    } else console.log("check:layout: no --admin, so the action toast is skipped");
  } catch (error) {
    failures.push(stopped(error));
  }
  return failures;
}

if (import.meta.filename === process.argv[1])
  process.exitCode = await withBrowser("check:layout", SESSION, measure, { mockServer: false });
