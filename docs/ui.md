# Web UI

## Edge lines

Set 11-22 by the orchestrator's gridlines pass (owner-requested). This app follows the edge lines of
the FlyCockpit template's design system (`patterns/design-system.md` § Edge lines in the template
repository): its four terms (text line, box line, trailing line, centre line), its 1px tolerance on
ink, and its two rules. **Boxes share the text line** inside pages, cards and forms. **Fix a miss
in the container** (its padding, a shared inset such as `inset`, or the close button's placement),
never with a one-off margin on one item. This section lists only where this app differs from the
template or adds containers the template does not have. Change a value only with the owner's
approval, and record it here.

The same numbers hold at 390px and 1440px unless a row says otherwise.

| Container | Text line | Box line | Trailing line | Centre / icon column |
|---|---|---|---|---|
| Signed-in sidebar, expanded (`AppFrame`, `w-60`) | Labels at 47px: the icon, then `gap-2` | 8px (`px-2`): the nav link boxes (`touch`, `px-3.5`) | 8px inside the 1px end border: the link boxes and the right-aligned collapse toggle (`icon-touch` in `p-2`) end here | Nav icons are `size-4`, left-aligned on one column 23px in (the box, its 1px border, `px-3.5`). The footer group (Terminals, Settings, Admin) uses the same lines. |
| Signed-in sidebar, collapsed (`w-16`) | — | — | — | The 44px links (`icon-touch`; the groups are `items-center`) and the toggle centre on one vertical line, the rail's centre inside its 1px end border. |
| Page content (`AppFrame`: `container mx-auto max-w-6xl px-4`; admin overview, users and observability `max-w-7xl px-4`, like the admin strip) | 16px inside the page container. Exception: admin settings is a narrower centred `max-w-4xl px-4` container, so at wide widths its heading starts inside the strip's first tab (a page-width decision, left for the owner) | Same as the text line | 16px inside the container | — |
| Section tabs (`SectionTabs`: pools, runtimes, access, activity) and the admin strip | Label 15px inside the tab box (`touch`: a 1px transparent border plus `px-3.5`); admin strip icon 12px inside (`px-3`) | The first tab's box starts on the page text line | The strip scrolls sideways on phones (`WideContent`) | — |
| More sheet (BottomNav, phones) | Title 16px (`SheetHeader p-4`). Row icons at 31px (the row box, its 1px border, `px-3.5`); labels and hints at 59px, after the icon and `gap-3` | 16px (`px-4`): the row boxes share the title's text line | 16px | Row icons are `size-4`, left-aligned on one column. |
| Dialog close (`DialogContent`) | — | — | The 28px button (`icon-sm`, 28px at every width here; the template's is 44px on phones) ends 8px in (`right-2`). The X glyph's ink ends 17.3px in: 1.3px past the template's 16px line and 1px tolerance, left so the target stays whole (see below). | Centred on the title line at every width (`top-3`). |
| Sheet close (`SheetContent`) | — | — | The 44px `icon-touch` button sits flush with the edge (`right-0`); the X glyph's ink ends 17.3px in. Its focus ring is inset (`ring-inset`) so the sheet's `overflow-x-hidden` does not clip it | Centred on the header title (`top-1`) |
| Account menu (`UserMenuContent`) | The template's menu lines: nav rows' labels on 32px (icon, then `gap-1.5`); Sign Out takes `inset` to share that line; "My Account", the name and the email start on the 10px icon edge | — | — | Owner decision 11-22: the menu is at least 224px wide (`min-w-56`). A long email truncates with an ellipsis (`truncate`) and shows the full address in its `title`. |

Close-button hit areas (owner 11-22, AGENTS.md: touch targets ≥ 44px on mobile). The dialog's
28px button carries a centred 44px `::after` (`after:size-11`, centred with `after:top-1/2
after:left-1/2` and the two `-translate-*-1/2`). It is sized from the button's border box. An
`after:-inset-2` expansion starts inside the 1px border and measured 42px. At `right-2` the square's
edge meets the popup's edge. Most callers clip the popup (`overflow-x-hidden`), and the clip falls
exactly on that edge; the others do not clip at all. Either way it measured 44 × 44 in the browser
at 390, 768 and 1440. The sheet's button is 44px itself. Moving the dialog button further
out to bring the glyph's ink to 16px would clip the target.

Dropdown menus (the 32px label line, the 10px icon column, `inset` for rows without an icon), the
settings sub-nav (`md:-ml-3` on the track: at `md:` and up its icons sit on the "Settings"
heading's line, and the highlight box outdents by the item padding), BottomNav, cards, and Select
listboxes use the template's lines unchanged.

Known gaps, left for the owner (11-22): `SegmentedControl` toggles have `min-h-[44px]` but no
44px minimum width (the template's have `min-w-[44px]`), so a short label such as "All" gets a
narrower target than the 44px mobile rule in [AGENTS.md](../AGENTS.md) asks for. Fixing it changes
a control size, which an alignment pass does not do.
