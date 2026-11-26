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
  today), sit 16px inside the frame at every width; they are not re-aligned to a narrower page
  container below them.

## Shell rules

Set 11-25 by the theme audit, from the template's `patterns/design-system.md` § Shell rules, adapted
to this app's single root shell. Four rules every page meets, in both themes and at every width.
`pnpm policy:web-conventions` (in `pnpm check:ci`) enforces what a static check can (G8 and G9 in
`scripts/check-web-conventions.ts`); `apps/web/src/routes/-__root.dom.test.tsx` and
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
   in both themes. The inline `html` background the init script paints on the first frame gives way
   to `--background` once the stylesheet applies, so an in-app toggle repaints it.
4. **Every route renders inside the shell, the 404 included.** The root route renders the shell
   (header, `<main>`, BottomNav) around every match, so the router's `defaultNotFoundComponent`
   (`components/not-found.tsx`) and a `notFound()` thrown by a route (the admin gate, the MCP pages
   when MCP is off) show the header with its language and theme controls; an unknown locale is
   redirected to the default one first (`$lang.tsx`). Do not add a route-level
   `notFoundComponent` that draws its own frame.

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
