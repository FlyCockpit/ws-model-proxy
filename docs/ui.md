# Web UI

## Edge lines

Set 11-22 by the orchestrator's gridlines pass (owner-requested), and synced the same day with the
template's back-port of the apps' findings. This app follows the edge lines of the FlyCockpit
template's design system (`patterns/design-system.md` § Edge lines in the template repository):
its four terms (text line, box line, trailing line, centre line), its 1px tolerance on ink, its two
rules and the five rules listed below the table. **Boxes share the text line** inside pages, cards and forms. **Fix a miss
in the container** (its padding, a shared inset such as `inset`, or the close button's placement),
never with a one-off margin on one item. This section lists only where this app differs from the
template or adds containers the template does not have. Change a value only with the owner's
approval, and record it here.

The same numbers hold at 390px and 1440px unless a row says otherwise.

| Container | Text line | Box line | Trailing line | Centre / icon column |
|---|---|---|---|---|
| Header (`Header`) | 16px inside the safe-area-adjusted frame (`px-4`): the logo, then the app name (`AppNameLink`: a 32px `<img>` with `width`/`height` declared, a width-descriptor `srcSet` (32w/64w/128w) with `sizes="48px"` (the largest drawn width; `sizes` cannot follow the scaled root), so a 4K root scale still gets a sharp file, `alt` = the app name and the visible name `aria-hidden`, so the link is named once; the files are `pwa-32x32.png`, `pwa-64x64.png` and `pwa-128x128.png`, generated from `apps/web/assets/logo.png` with the favicon and install icons by `apps/web/pwa-assets.config.ts`) | — | 16px: the last header control's box (the account trigger) ends here at every width, with any display name. Below `md:` the trigger is a 44px icon button. From `md:` it shows the name and shrinks before anything runs past this line: at most 192px and at least 44px wide (`md:max-w-48 md:min-w-11 md:shrink`), the name cut off with an ellipsis (`truncate`) and the full name in the trigger's `title`; the controls group is `min-w-0`. Measured 11-22 with a 100-character name: 16px at 1440, 768, 390 and 320 (before: 250px past the edge at 768). The shell grid's one column is `minmax(0,1fr)`, so header min-content never widens the frame. | Every header item centres on the header row (`items-center`). |
| Signed-in sidebar, expanded (`AppFrame`, `w-60`) | Labels at 47px: the icon, then `gap-2` | 8px (`px-2`): the nav link boxes (`touch`, `px-3.5`) | 8px inside the 1px end border: the link boxes and the right-aligned collapse toggle (`icon-touch` in `p-2`) end here | Nav icons are `size-4`, left-aligned on one column 23px in (the box, its 1px border, `px-3.5`). The footer group (Terminals, Settings, Admin) uses the same lines. |
| Signed-in sidebar, collapsed (`w-16`) | — | — | — | The 44px links (`icon-touch`; the groups are `items-center`) and the toggle centre on one vertical line, the rail's centre inside its 1px end border. |
| Page content (`AppFrame`: `container mx-auto max-w-6xl px-4`; admin overview, users and observability `max-w-7xl px-4`, like the admin strip) | 16px inside the page container. Exception: admin settings is a narrower centred `max-w-4xl px-4` container, so at wide widths its heading starts inside the strip's first tab (a page-width decision, left for the owner) | Same as the text line | 16px inside the container | — |
| Section tabs (`SectionTabs`: pools, runtimes, access, activity) and the admin strip | Label 15px inside the tab box (`touch`: a 1px transparent border plus `px-3.5`); admin strip icon 12px inside (`px-3`) | The first tab's box starts on the page text line | The strip scrolls sideways on phones (`WideContent`) | — |
| More sheet (BottomNav, phones) | Title 16px (`SheetHeader p-4`). Row icons at 31px (the row box, its 1px border, `px-3.5`); labels and hints at 59px, after the icon and `gap-3` | 16px (`px-4`): the row boxes share the title's text line | 16px | Row icons are `size-4`, left-aligned on one column. |
| Dialog close (`DialogContent`) | — | — | The 28px button (`icon-sm`, 28px at every width here; the template's is 44px on phones) ends 8px in (`right-2`). Its 16px icon box ends 14px in; lucide's X is drawn inside its box, so the ink ends about 17px in (17.3 measured). Accepted, as in the template: moving the button further out would clip its hit area (see below). The button is not flush with an edge, so its focus ring stays outside the box. | Centred on the title line at every width (`top-3`). |
| Sheet close (`SheetContent`) | — | — | The 44px `icon-touch` button sits flush with the edge (`right-0`); its icon box ends 14px in and the X's ink about 17px in, as in Dialog. Its focus ring is drawn inside the box (`focus-visible:ring-inset focus-visible:ring-offset-0`), so neither the viewport nor the sheet's `overflow-x-hidden` clips it | Centred on the header title (`top-1`) |
| Account menu (`UserMenuContent`) | The template's menu lines: nav rows' labels on 32px (icon, then `gap-1.5`); Sign Out takes `inset` to share that line; "My Account", the name and the email start on the 10px icon edge | — | `align="end"`: the menu's box ends on the trigger's box, the header's trailing line | Owner decision 11-22: the menu is at least 224px wide (`min-w-56`; the trigger is at most 192px, so the menu never takes its width). A long email truncates with an ellipsis (`truncate`) and shows the full address in its `title`. |
| `SegmentedControl` | At least 15px inside the group's box (1px border, `p-1`, toggle `px-2.5`); a short label is centred in its toggle's 44px minimum width | The group's box starts on the page text line; toggles sit 5px inside it | The group's box ends 5px past its last toggle | Every toggle is at least 44 × 44 (`min-h-[44px] min-w-[44px]`; "curl" measured 42px wide before 11-22). |

Close-button hit areas (owner 11-22, AGENTS.md: touch targets ≥ 44px on mobile). The dialog's
28px button carries a centred 44px `::after` (`after:size-11`, centred with `after:top-1/2
after:left-1/2` and the two `-translate-*-1/2`). It is sized from the button's border box. An
`after:-inset-2` expansion starts inside the 1px border and measured 42px. At `right-2` the square's
edge meets the popup's edge. Most callers clip the popup (`overflow-x-hidden`), and the clip falls
exactly on that edge; the others do not clip at all. Either way it measured 44 × 44 in the browser
at 390, 768 and 1440. The sheet's button is 44px itself. `AlertDialogCancel` carries a 44px minimum box by default
(`min-h-11 min-w-11`, callers' classes merged after it), like the template's. Moving the dialog button further
out to bring the glyph's ink to 16px would clip the target.

Dropdown menus (the 32px label line, the 10px icon column, `inset` for rows without an icon), the
settings sub-nav (`md:-ml-3` on the track: at `md:` and up its icons sit on the "Settings"
heading's line, and the highlight box outdents by the item padding), BottomNav, cards, and Select
listboxes use the template's lines unchanged.

Five more rules, from the apps' passes (the template's § Edge lines has the full text):

- **An edge text item puts its label on the box's edge.** A text link or button first or last on a
  line, in a box wider than its label (a 44px minimum box around a short label), start-aligns the
  label when leading and end-aligns it when trailing. Centring is for items in centred bars
  (BottomNav) and for icon buttons.
- **Table text sits on its container's text line.** First and last cells drop their outer padding
  (or take the container's inset, e.g. `first:pl-0 last:pr-0`); inner cell padding separates
  columns.
- **Overriding a Button's padding: override every breakpoint.** tailwind-merge treats `px-*` and
  `md:px-*` as separate groups, so a responsive size keeps its `md:px-*` unless the override names
  it too (`px-2 md:px-2`). This app's Button sizes are not responsive today; the rule holds if one
  becomes so.
- **A control flush with a clipping edge draws its focus ring inside its box**
  (`focus-visible:ring-inset focus-visible:ring-offset-0`), as the Sheet close does.
- **Frame bands keep the frame line.** The header, and any banner added above the page (none ships
  today), sit 16px inside the frame; they are not re-aligned to a narrower page container below
  them. A band's background spans the window, but its content stops at the widest page column
  (§ Viewport scale), as the admin sub-nav's does; the header keeps the frame line at every width.

## Shell rules

Set 11-25 by the theme audit, from the template's `patterns/design-system.md` § Shell rules, adapted
to this app's single root shell. Four rules every page meets, in both themes and at every width.
`pnpm policy:web-conventions` (in `pnpm check:ci`) enforces what a static check can (G8 and G9 in
`scripts/check-web-conventions.ts`; its G10 is § Viewport scale); `apps/web/src/routes/-__root.dom.test.tsx` and
`apps/web/src/lib/theme-contrast.test.ts` pin the markup and the tokens; `pnpm check:layout`
measures the geometry in a browser (§ Layout check).

1. **Footers sit at the bottom of a short page.** This app has no site footer: the root shell
   (`apps/web/src/routes/__root.tsx`) is a `h-svh` grid whose `<main>` always reaches the viewport
   bottom, and phones get the BottomNav. No route renders a site `<footer>` (G8); a `<footer>` that
   belongs to an `<article>`, `<section>` or similar sectioning element stays inside it. If the app
   ever gets a footer, it is one shared component that the shell renders inside `<main>`, as the
   last box of a `flex min-h-full flex-col` column whose content grows (`flex-1`): no
   `position: fixed`, no second scroller.
2. **Full-bleed dividers span the viewport.** The header's `<hr>`, sticky sub-navs (the admin
   section nav) and full-width banners reach from 0 to the viewport's right edge at every width. On
   a page that scrolls, rules inside `<main>` meet its visible scrollbar, which sits at that edge, as
   on any scrolling page. That is why `<main>` (and the pending `ShellSkeleton`'s copy of it)
   reserves no scrollbar gutter (G8 flags one in its className, its inline style, or any CSS rule
   that styles it, through `:is()`/`:where()` and nesting): with classic scrollbars (Windows, Linux) a stable gutter is an
   empty 15px strip that every rule inside the scroller stops short of, even when nothing scrolls.
   The cost is that centred content moves by half a scrollbar when a page grows past the viewport
   on those platforms; overlays don't cause it, because they lock the document (vaul, Base UI), not
   `<main>`. Nested panes may still reserve a gutter.
3. **No surface ignores the theme.** The theme is the stored choice, else the OS, applied as the
   `.dark` class before first paint (`packages/config/src/theme-init.ts`). Every surface (toasts,
   banners, popovers, menus) uses the tokens in `packages/ui/src/styles/globals.css` and `dark:`
   variants, never a `prefers-color-scheme` query or a literal colour (G9: hex, `rgb()`, `oklch()`
   and the like anywhere in CSS, inline styles and Tailwind arbitrary values or properties such as
   `shadow-[0_0_4px_#fff]` or `[scrollbar-color:#3a414b_transparent]`, and the CSS named colours
   like `white` in a colour property or colour utility); a
   new colour becomes a token there. Tailwind palette utilities paired with a `dark:` variant
   (`text-amber-700 dark:text-amber-300`) follow the theme and are not flagged. A state's
   `-foreground` ink is the text on its solid `bg-state-*` fill only; text on a page or card uses
   the state ink itself (`text-state-warning`). A colour that must stay fixed (a QR code that has to scan dark on white, a mask
   gradient's opacity) carries a `theme-exempt: <reason>` comment on the line above it, on its
   line, or inside the flagged class or style value; the reason is required and the comment
   silences that G9 finding only. `url(#id)` references are not colours. Toasts are a popover
   surface: `globals.css` fills sileo's pill with `--popover`, writes the title and description in
   `--popover-foreground` and maps sileo's state colours to `--state-*`, `--destructive` and
   `--primary`, and the Toaster (`packages/ui/src/components/sileo.tsx`) gets no `theme` prop
   (sileo's themes invert the page). Text and state colours reach 4.5:1 on the surface they sit on
   in both themes. A toast's title is one line capped to the pill and shown as written (no Title
   Case); a message that does not fit ends in an ellipsis there and `toast.*`
   (`packages/ui/src/lib/toast.ts`) repeats it in the description, which wraps. Toasts sit
   bottom-centre above the phone BottomNav (`--bottom-nav-height`, 0 while no nav is on screen),
   or above the home indicator where there is none, and their action button ("Undo", "Retry") is
   at least 44px tall on a touch screen. Menus, selects and popovers are opaque `bg-popover`
   surfaces (no translucency or backdrop blur), so the page never shows through a list. Field
   outlines (`--input`: inputs, selects, outline buttons, the Off switch track) reach 3:1 on every
   surface; the focus ring and focused border (`--ring`, a darker or lighter relative of
   `--primary`'s hue) reach 3:1 on every surface and 2:1 against the resting outline, and the
   controls draw it opaque and 2px wide; invalid borders are opaque `--destructive` in both themes.
   `apps/web/src/lib/theme-contrast.test.ts` measures all of these. The inline `html` background the init script paints on the first frame gives way
   to `--background` once the stylesheet applies, so an in-app toggle repaints it.
4. **Every route renders inside the shell, the 404 included.** The root route renders the shell
   (header, `<main>`, BottomNav) around every match, so the router's `defaultNotFoundComponent`
   (`components/not-found.tsx`) and a `notFound()` thrown by a route (the admin gate, the MCP pages
   when MCP is off) show the header with its language and theme controls; an unknown locale is
   redirected to the default one first (`$lang.tsx`). Do not add a route-level
   `notFoundComponent` that draws its own frame.

## Viewport scale

Set 11-26 by the viewport pass, from the template's `patterns/design-system.md` § Viewport scale.
The app grows with the screen above 1920 CSS px, so a 4K monitor at 100 % OS scaling shows the same
layout as a 1080p one instead of a small island in the middle. Phones, laptops and 1080p screens
are unchanged.

1. **One root rule scales everything.** `html` in `packages/ui/src/styles/globals.css` sets
   `font-size: clamp(100%, calc(100% + (max(100vw, 100vh) - 1920px) / 240), 150%)`. The root is
   the browser default (100 %, so a user's own default font size is respected) up to a 1920 CSS px
   long side, then grows 1px per 240px, capped at 150 % of that default: 24px at 3840 with the
   usual 16px default (20px: 28px at 3840, capped at 30px). The long side makes a portrait
   2160×3840 screen scale like a landscape 3840×2160 one; 4K at 200 % OS scaling is 1920 CSS px,
   so it is unchanged. Media queries use the browser default, so breakpoints don't move, and
   browser zoom still enlarges. `apps/web/src/lib/viewport-scale.test.ts` pins the rule.
2. **Sizes are rem, not px.** Type, control heights, padding, page widths, dialogs, sheets, cards
   and charts use Tailwind's rem scale, so they follow rule 1. A px size does not scale: next to
   rem siblings it ends up too small at 4K (a px switch track around a rem thumb). px stays for
   hairlines and borders, shadows, radius offsets and touch-target floors (`min-h-[44px]` is a
   minimum, not a size). The terminal's font size is the user's own setting, in px.
3. **Text is at least 12px** (`text-xs`, 0.75rem) at every width, labels and badges included; 18px
   at 3840. A BottomNav label that doesn't fit ends in an ellipsis (the tab's accessible name stays
   whole); its tabs keep a px `min-w-[44px]` touch floor, since a rem floor grows with a large
   browser default font and five tabs would overflow a 320px phone. G10 in
   `scripts/check-web-conventions.ts` checks every string in web source (`className`, `cva()`
   variants, constants, other class props). It rejects a px font size (`text-[13px]`), a rem size
   below 0.75, an em size below 1 (em is relative: `0.9em` in 12px text is 10.8px) and any other
   size expression without a rem floor of at least 0.75; `text-[length:max(0.9em,0.75rem)]` (the
   test chat's inline code) passes.
4. **Inputs are 16px on phones.** Input, Textarea and NativeSelect use `text-base` below `md` and
   their compact desktop size from `md` up: under 16px, iOS Safari zooms the page when a field gets
   focus.
5. **Page widths are rem tiers.** The app frame's column (`max-w-6xl`), the admin pages
   (`max-w-4xl`/`max-w-7xl`) and dialogs scale with rule 1. Card grids fill the column with as
   many fixed-rem cards as fit (the pools list, `repeat(auto-fill, minmax(min(100%, 20rem), 1fr))`),
   so a row holds the same cards at 1920 and at 3840. Dense tables scroll inside `WideContent`,
   never the page.
6. **Long copy gets `max-w-prose`** (45-75 characters per line): page descriptions (`PageHeading`
   carries it), help text, setting and policy explanations, the welcome steps.
7. **Narrow pages centre in the frame.** Settings (`max-w-4xl`) and the 404 sit in the middle of
   the frame's column like the other pages, never at its left edge with empty space on the right.
   The signed-out auth card centres in the page, except on a portrait screen from `md` up, where
   it starts in the upper part (`AUTH_SCREEN_CLASS`, `components/auth/auth-card.tsx`).
8. **Create flows are a bottom drawer on phones.** A short create dialog uses `ResponsiveDialog`
   (a dialog from `md` up, a bottom drawer below it with the action bar at the bottom), as New
   pool, New API key and Invite user do; a long form uses the form-surface sheet.
9. **The header stays full width**; its row scales with rule 1.

## Query cache follows identity

The TanStack Query cache, Zustand stores, module state and every in-flight request callback belong
to one identity: the one the document was used by. `apps/web/src/lib/document-identity.ts` keeps
that identity at module scope for the whole life of the document (never in a component, which an
error reset would unmount and make forget). When a confirmed identity differs from it, the document
is replaced with a full load. A page load is asynchronous, so every replacement first quarantines
the document synchronously: the page is hidden (`display: none !important` on the root, which no
descendant can undo) and the QueryClient sealed (emptied, and anything a late callback adds is
removed again), so nothing of the previous identity stays on screen while the new page loads. A
replaced document reloads once, however many changes follow.

| Transition | What happens |
|---|---|
| Explicit sign-out (the account menu; the MCP login page's "sign in again to reauthorize") | `signOutAndLeave()` (`apps/web/src/lib/explicit-sign-out.ts`): marks the sign-out, then on success `leaveDocument()`: the account menu loads the sign-in page, the MCP page reloads its own URL (the signed OAuth query kept byte for byte). A failure, returned or thrown, undoes the mark and is shown. Add any new sign-out button through it. |
| Signed out elsewhere (another tab, expiry, revocation) | The document reloads in place; the guards send the visitor to the sign-in page. |
| Another account, impersonation starting or stopping (same tab or another tab) | The document reloads in place; the guards admit the new account and its queries load fresh. |
| Anonymous → signed in | Public pages update normally. A confirmed peer sign-in replaces an anonymous-only form; a local sign-in keeps its router navigation. |
| `pending` / `error` | Never acted on: a flaky session check must not reload a signed-in page. |

Three observers feed it, and none can be skipped:

- **Every session guard** (`_auth`, `admin`, `login`, `signup`, `forgot-password`, `mcp-consent`,
  the `/$lang/` redirect) calls `resolveRouteSession()` (`apps/web/src/lib/route-session.ts`):
  `getRouteSession()`, then the identity check. A different identity replaces the document and the
  guard never settles, so no page renders the previous identity's cached data.
  `pnpm policy:web-conventions` (G11) rejects any route-file reference to `getRouteSession` or
  `@/server/auth-session`.
- **The root shell's watcher**, `useReloadOnIdentityChange()` (`routes/__root.tsx`), for a change
  while any page is open, the guard-less ones included (MCP login, verify-email, reset-password).
  It runs in a layout effect, before a frame pairs the new chrome with the old data. It also
  connects the open tabs: Better Auth tells other tabs about a sign-out but not a sign-in, so the
  auth client announces every session change made in the tab (`$sessionSignal`), and the watcher
  and the guards announce each newly confirmed identity on the document's `BroadcastChannel`; every
  matching peers do no work, while conflicting identities and session-change hints share one session check.
  While the watcher is not mounted (the root's pending or error state, a route loader's query
  before the shell mounts), a peer's announcement or a 401 cannot be checked: it marks the
  document's identity unverified instead (generation-counted). Until a fresh check confirms the
  document's identity or replaces the document, `useAuthSession()` reports `pending` everywhere,
  so no chrome shows an account Better Auth's atom may hold stale; the shell's nav ignores the
  guards' route context (`useShellIdentity`), and the root holds the matched page as a skeleton
  (an error reset re-renders retained matches without their guards; the watcher stays mounted
  outside that gate). A fresh check is a guard's
  server answer, or a refetch the watcher itself starts once it mounts (retried on focus,
  visibility and reconnect through the document retry scheduler; one superseded by another session fetch is followed up at most 3
  times, 250 ms apart; all dropped on unmount). An answer asked for before a newer invalidation
  never counts, and only a settled successful answer (or a 401) is read as one. The watcher alone
  reads the session unmasked (`useAuthSession({ unmasked: true })`). The template's
  `SessionUnconfirmed` for its `_app` pending shell is not needed here: the chrome lives in the
  root component next to the watcher, so whenever it paints, the watcher is connected.
- **The global error toasts** (`utils/query-error-toast.ts`, `utils/mutation-error-toast.ts`):
  before any toast opt-out, a query rejected with 401 asks Better Auth to check the session (one
  check in flight at a time) instead of toasting; a mutation still toasts. Nothing toasts once the
  document is being replaced.

Document-owned requests send `X-Expected-User` from the document baseline: oRPC, Better Auth
except get-session/sign-out, and `fetchWithExpectedIdentity` for media and Chat Test. The server
compares the raw cookie owner before policy filtering. `409 {code: "IDENTITY_CHANGED"}` replaces
the document before response callbacks, toasts or form errors. Session lookup failures remain
unavailable, never confirmed anonymity. No session cookie cache is enabled.

`session-retry.ts` coordinates session checks across all mounted consumers: 2–60 second backoff,
Retry-After, and pause while hidden/offline. Better Auth's duplicate focus refresh is disabled;
native reconnect/storage refreshes share its cooldown and in-flight check. Non-401 session errors
show Account unavailable with Retry and Sign out, retaining that control while a retry runs.
Cached app configuration that fails to refetch keeps auth forms mounted (`isLoadingError` gates
only initial failures). Route probes discard superseded answers and retry at most three times.

Admin promotions and demotions name the target in a confirmation dialog. Role changes, archive,
and durable deletion's mark transaction share the last-active-verified-admin check under
Serializable isolation. Pending deletions and current bans do not count; an expiry equal to now
still counts as banned. Role changes write `users.role_changed` to `AuditEvent` in the same
transaction, including actor, target and before/after roles; same-role requests write nothing.
Better Auth's parallel role, ban, restore, remove and access-update endpoints are refused at the
HTTP gate. The app uses oRPC for these actions and keeps its durable deletion cleanup phases.

The router also covers the back/forward cache: a document that ever held a signed-in user's state
is hidden as it enters the cache and reloaded when restored, so Back never shows a frozen page
nobody re-checked. Anonymous pages are cached as usual.

Why a full load, not `queryClient.clear()` or a fresh `QueryClient`: clearing the cache while
observers are mounted cancels their fetches silently and can leave a page stuck on a skeleton,
`resetQueries()` refetches active queries as the wrong identity (a 401 toast each), and neither
stops an in-flight mutation whose late `onSuccess` writes the old identity's data back. A swapped
client still leaves Zustand stores, the node live-updates stream, open terminal sockets and module
state behind. A full load drops all of it, and a late callback can only write into the document
being discarded.

What is kept across identities on purpose, because it is the device's, not the account's: the
`ui-preferences` store (sidebar and terminal settings) and the locale in `localStorage`, the
browser's terminal identity key and the CLI identity pins in IndexedDB, and the per-tab welcome
offer flag in `sessionStorage`. None holds account data; anything that does belongs in the query
cache, or needs its own identity scoping.

## Auth pages and route guards

- **One real `h1` per page.** Every auth page (sign-in and its two-factor step, sign-up and its
  invite states, forgot/reset password, verify email, MCP sign-in and consent, the forced 2FA
  setup, the unable-to-connect card) wraps its card title in an `h1`
  (`<CardTitle className="text-2xl"><h1>…</h1></CardTitle>`; preflight makes it inherit the
  title's size and weight). The settings layout and the 404 already have theirs. Never use
  `role="heading"`. Tests: `components/auth/auth-pages.dom.test.tsx`,
  `components/auth/reset-password-card.dom.test.tsx`.
- **A signed-out form survives a refocus.** Better Auth refetches the session when the tab regains
  focus and marks every refetch of an empty session `isPending`, the same snapshot as the first
  load. `useAuthSession` keeps a document-level "confirmed anonymous" memory
  (`rememberConfirmedAnonymous` in `lib/auth-session-state.ts`), so once the document settled
  signed out, a refetch or a failed refetch stays anonymous: the sign-in and sign-up forms keep
  their typed values instead of flashing their skeleton or the unable-to-connect card. Only the
  first load waits (and an unverified identity, § Query cache follows identity). A sign-in clears
  it; a sign-out replaces the document.
- **Guards wait for the shell to hydrate.** The root route is `ssr: false`: the server sends
  `ShellSkeleton`, shaped by the URL (sidebar, bottom nav). React hydrates it in a later
  Suspense pass, so a guard redirect that landed first (a signed-out cold load of
  `/en-US/nodes`, a signed-in one of `/en-US/signup`) made React hydrate the skeleton for the new
  URL against the old HTML: React error #418. `resolveRouteSession()` therefore waits, alongside
  its probe, for `appShellHydrated()` (`lib/app-shell-hydration.ts`): the skeleton carries
  `data-app-shell` and reports from its first effect (the loaded root reports too), with a 5 s
  cap; a failed probe is rethrown only after the wait. Server and client navigations do not wait.

## Layout check

`pnpm check:layout --url <dev server>` measures § Shell rules in a real browser through
`agent-browser` (session `check-layout`; pass `--no-sandbox` on headless Ubuntu). With
`CHECK_LAYOUT_PASSWORD` set and `--admin <email>` (an admin without 2FA) it also signs in. At
390×844, 1280×800, 1440×1600 and a 390×300 viewport where every page scrolls it opens the sign-in
page, a 404 and, signed in, a 404 and the admin users page, and fails when:

- the document scrolls (only `<main id="main-content">` may), or a page has no shell header;
- `<main>` gives up width to a scrollbar on a page that does not scroll (a reserved gutter), or a
  full-width rule (the header `<hr>`, the admin sub-nav's `border-b`) stops short of either
  viewport edge (inside a scrolling `<main>`, of its visible scrollbar);
- a toast (a failed sign-in; signed in, also a failed query's toast with its Retry action, at rest
  and hovered, produced by aborting every oRPC call), with the stored theme light and then dark and
  the OS set to the other one, renders in the OS theme, is not filled with the theme's popover
  colour, or its title, badge or action label (on its own tint) is below 4.5:1 on it.

Run it after changing the root shell, the header, page-level chrome or the toast styling. Headless
Chromium on Linux draws classic scrollbars, which is what exposes a reserved gutter (overlay
scrollbars on macOS hide it). It is not part of CI: it needs a browser and a running app. The
structure it measures is pinned in CI by the root shell test and G8/G9; the judging logic has unit
tests (`pnpm check:layout:test`, in `pnpm check:ci`).

Against a running app, `pnpm check:layout --url <app> --accounts <file>` signs in from a
credentials file instead of `--admin`/`CHECK_LAYOUT_PASSWORD` (`CHECK_LAYOUT_TOTP` may supply the
admin's Better Auth TOTP secret). Before measuring a page it waits up to 8 s for five unchanged
content-height reads with no `[data-slot="skeleton"]`, `[aria-busy="true"]` or
`[data-route-skeleton]` inside `<main>`, and reports "still showing a loading skeleton" apart from
"kept changing": loading UI must carry one of those markers.

All three checks (`check:layout`, `check:dialogs`, `check:shell-loading`) share
`scripts/browser-check-lib.ts`. WMP has no mock mode or seed command: they need `--url` at the app's
auth origin, and the dialog and shell checks create their own runtime, pool and provider fixtures
and require `WMP_CHECK_DISPOSABLE=1`. Accounts come from signup on a fresh local stack without
SMTP (start it with `ADMIN_EMAIL=check-admin@example.invalid`), from `WMP_CHECK_ADMIN_EMAIL/PASSWORD`
and `WMP_CHECK_USER_EMAIL/PASSWORD` (optional `WMP_CHECK_ADMIN_TOTP` / `WMP_CHECK_USER_TOTP`), or
from `--accounts <file>`: `version: 1`, `accounts.user` and `accounts.admin`, each with `email`,
`password` and an optional `totp: { secret }` (Better Auth's raw UTF-8 secret, not the base32 one
in the authenticator URI). Never commit that file. Form sign-in waits for hydration and polls short
page evaluations from Node (a navigation means look again); the TOTP step is polled the same way;
passwords and codes travel through stdin and are redacted from failures. A missing precondition
(credentials file, fixture, a ready marker that never appears) is a one-line failure with the next
step, never a stack trace or a file excerpt. Every browser session is named
`<BROWSER_CHECK_SESSION_PREFIX><check>-<pid>`, so concurrent checkouts never share one. WMP has
no public footer, so the template's long-page footer rule in the shell-loading check does not
apply.
