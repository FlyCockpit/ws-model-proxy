# AGENTS.md

Rules and context for AI coding agents working in WS Model Proxy.

## Stack

- React 19, TanStack Router, TanStack React Query, TanStack React Form, Zod
- Hono API server
- oRPC routers and procedures
- Prisma with Postgres
- Better Auth
- Tailwind CSS v4 and shadcn/ui in `packages/ui/` (the shadcn CLI is not a
  dependency; run it as `pnpm dlx shadcn@4.21.0`, the version `scripts/theme-apply.ts` pins)
- Zustand for client-side state
- Vite, vite-plugin-pwa, Turborepo, pnpm
- react-i18next with locale-prefixed routes under `/$lang/...`
- Rust CLI in `apps/cli`

## Project Structure

```
apps/web/          -> React web dashboard
apps/server/       -> Hono API/server entrypoint
apps/cli/          -> Rust CLI relay client
packages/ui/       -> Shared UI components and globals.css
packages/api/      -> oRPC routers and procedures
packages/db/       -> Prisma schema and client
packages/auth/     -> Better Auth configuration
packages/config/   -> Shared config, theme, and locale constants
packages/env/      -> Environment variable validation
packages/mailer/   -> Email rendering
packages/i18n-translate/ -> Locale bundle translation tooling
packages/test-utils/ -> Shared test helpers
```

## Core Rules

- Keep `sitemap.md` updated when adding, removing, or renaming routes.
- Public SEO paths are defined in `apps/server/src/seo.ts`.
- Keep all user-facing web strings in the locale bundles under `apps/web/src/locales/`.
- Root `.env.example` / `apps/web/.env.example` are generated from
  `scripts/lib/env-manifest.ts` (`pnpm env:sync` / `pnpm env:check`). Production
  secrets: `pnpm generate:secrets` (WMP vars only). Dockerfile COPY lists:
  `pnpm docker:check-copy`.
- Email is optional: without SMTP, verification is off and accounts are usable;
  with SMTP configured, require verification and the verify-email flow.
- Do not hardcode secrets, credentials, API keys, passwords, or production URLs.
- Do not read or print environment variable values unless the task requires it.
- Do not remove or weaken authentication, authorization, CSRF, CORS, CSP, or rate-limit protections.
- Do not convert authenticated procedures to public procedures unless the data is intentionally public.
- Do not add `any` or `as any` to silence TypeScript errors; fix the types.
- Do not use `git commit --no-verify`.
- Do not run `sudo`.
- Do not create `.bak`, `.old`, `.backup`, or `.orig` files. Git is the backup mechanism.
- Root `CLAUDE.md` and `.cursorrules` are generated from this file with `pnpm sync:agent-docs`.

## Versions and Releases

Only the owner changes version numbers, and only in the commit that cuts a
release. Agents and contributors never change them in a feature or fix PR,
unless the owner explicitly asks for it in the current task. That covers:

- The app/CLI version: `apps/cli/Cargo.toml` (and its `Cargo.lock` entry) and
  `SERVER_VERSION` in `apps/server/src/version.ts`.
- The relay protocol version: `RELAY_PROTOCOL_VERSION`, `RELAY_SUBPROTOCOL`
  and `RELAY_PROTOCOL_VERSIONS` in `apps/server/src/relay/`, and
  `RELAY_PROTOCOL_VERSION` / `RELAY_SUBPROTOCOL` in `apps/cli/src/wire/protocol/`.
- The release switches in `apps/server/src/node-http.ts`
  (`CLI_RELEASE_BINARIES_BY_DEFAULT`, `CLI_PREVIEW_BRANCH`).

Each release line uses one relay protocol. Server and wsmp 1.0 speak only relay
4.0 with WebSocket subprotocol `ws-model-proxy.relay.v4`; upgrade the server and
every node together when the protocol changes.

- Refuse other subprotocols with HTTP 426 and `code: "upgrade_cli"`. Preserve
  the refusal body keys and types: `type`, `failure`, `code`, `message`,
  `supportedVersions`, `supportedSubprotocol`.
- Preserve all five `/.well-known/wsmp` fields and their types: `serverVersion`,
  `protocolVersion`, `origin`, `installScript` (`/install.sh`), and `enrollPath`
  (`/api/node/enroll`). Released CLIs parse this response and the 426 refusal to
  print upgrade instructions; their shapes must never change.
- Advertise new optional capabilities through hello `features`, and use them
  only with nodes that report support.
- Version numbers remain owner-only. See `apps/cli/docs/releasing.md` for the
  release process and `apps/cli/docs/relay-protocol.md` for the handshake.

## Data and Schema

- The Prisma schema lives in `packages/db/prisma/schema/`; committed migrations in
  `packages/db/prisma/migrations/` ([docs/schema-migrations.md](docs/schema-migrations.md)).
- Schema changes: edit the schema, `pnpm db:migrate <name>` (generates SQL only), review and
  edit the SQL, `pnpm db:migrate:apply`, commit schema and migration folder together. A
  migration on the default branch is never edited; fix mistakes with a new one. Only the release
  cut folds the unreleased ones into the release migration (`pnpm db:release-squash`); a released
  one never changes.
- Local databases are per checkout (`pnpm db:worktree`); `pnpm db:reset:local` recreates only
  this checkout's own database, and only one carrying the disposable-local mark (`pnpm db:worktree`
  and the dev compose volume set it; `EXPECTED_DB` never widens a reset). Agents never run
  `pnpm db:worktree --adopt`; hand it to the user. `scripts/assert-local-database.sh` guards every
  local wrapper.
- Production applies migrations only through the image's runner (`MIGRATE_ON_START`, default
  true for the server, or the `migrate` command). `APPLY_SCHEMA` is a deprecated 1.x alias.
- `packages/db/prisma/schema-hardening.sql` (checks, triggers, fences Prisma cannot express) is
  carried by migrations, never applied directly; `pnpm db:validate` checks the newest
  migration's copy matches it.

Never run:

- `prisma migrate reset`
- `prisma migrate dev` (`pnpm db:migrate` generates migrations instead)
- `prisma db push` (any flags, incl. `--force-reset` / `--accept-data-loss`); it bypasses
  the migration history
- `prisma db drop` / `dropdb`
- Raw SQL `DROP DATABASE`, `DROP SCHEMA`, `DROP TABLE`, `TRUNCATE`, or `DELETE` without a
  `WHERE` clause, except inside a reviewed migration file
  (`packages/db/prisma/migrations/*/{migration,contract}.sql`)

Allowed: `prisma migrate deploy` and `prisma migrate diff` through the wrappers and the image
runner; `prisma migrate resolve` only in the documented recovery steps, run by the operator
(never by an agent).

## Web Conventions

- Data fetching goes through oRPC query and mutation options with TanStack Query.
- Conditional fetching uses `enabled` or `skipToken`; do not conditionally call hooks.
- Browser session state goes through `apps/web/src/hooks/use-auth-session.ts`.
  Do not call `.useSession()` anywhere else in production code, and do not
  mirror Better Auth session data into Zustand.
- Route auth checks use `resolveRouteSession()` (`apps/web/src/lib/route-session.ts`: the
  server-backed `getRouteSession()` plus the document identity check) and pure decisions from
  `apps/web/src/lib/route-session-access.ts`. Route files never call `authClient.getSession()`
  or reach `getRouteSession()` / `@/server/auth-session` directly (`pnpm policy:web-conventions` G11).
- Content loading states use layout-matching `Skeleton` components. A route's pending state is
  drawn inside the app frame and shaped by its `staticData.pendingShape` (list, detail, form,
  dashboard; `apps/web/src/lib/pending-layout.ts`): the header, sidebar and bottom nav are on
  screen from the first painted frame. Check with `pnpm check:shell-loading --url <app>`.
- A dialog holds a short form or a confirmation and fits without inner scrolling at 1280×800 and
  390×844; a longer form is a page or a wide side sheet. Every dialog is listed in
  `scripts/browser-checks.config.ts`; check with `pnpm check:dialogs --url <app>`.
- Forms use TanStack Form with native Zod validators.
- Mobile touch targets should be at least 44px.
- Respect safe-area CSS variables for edge-to-edge mobile layouts.
- The root shell owns safe areas, bottom-nav clearance, viewport height, and
  top-level scroll. Do not copy app-shell frame geometry into route files.
- Do not hide Header or BottomNav from `visualViewport` height (or similar
  resize heuristics) alone. Header is stable chrome. BottomNav may hide only
  when a mobile software keyboard is actually open.
  Exception: a maximized browser terminal takes the whole viewport. While it is
  maximized, the Terminals page hides Header, BottomNav, the sidebar and the page
  padding through `useHideAppChrome` (a user's choice, never a heuristic). The root
  shell still applies safe areas and the keyboard inset.
- Never set `overflow-y: auto` / `overflow-y-auto` without an explicit
  `overflow-x`. An omitted `overflow-x: visible` computes to `auto` and
  turns the page into a horizontal scroller.
- Flex/grid children that wrap wide content need `min-w-0` (and usually
  `max-w-full`) so min-content width cannot inflate the page.
- Intentional horizontal scroll belongs in `WideContent` (`apps/web/src/components/wide-content.tsx`),
  not on the page shell. Pair it with `overscroll-x-contain`.
  Exception: the browser terminal's follow-mode box in `terminal-pane.tsx` scrolls on both axes
  itself, because xterm opens directly in it and FitAddon measures it as the pane's size.
- Prefer axis-specific overscroll: horizontal scrollers use
  `overflow-x-auto overscroll-x-contain`; bounded vertical panes/dialogs can
  use `overscroll-contain`.
- Use the existing `BottomNav`; do not add a second mobile nav.
- Do not use `transition: all` or Tailwind `transition-all`.
- Use lucide icons where an existing icon fits.
- The root shell grid has one explicit `grid-cols-[minmax(0,1fr)]` column, so
  header or page min-content can never widen the viewport. Shell `<main>` keeps
  `overscroll-contain`, `id="main-content"`, `tabIndex={-1}`, and a localized
  skip-to-content link before the grid. It reserves no scrollbar gutter, so
  sticky sub-navs and banners inside it reach the viewport edge
  (docs/ui.md § Shell rules; `pnpm policy:web-conventions` G8).
- Every surface follows the app theme (the stored choice, else the OS, as the
  `.dark` class): theme tokens and `dark:` variants, never a literal colour or a
  `prefers-color-scheme` query outside `packages/ui/src/styles/globals.css`.
  A deliberate fixed colour carries a `theme-exempt: <reason>` comment
  (docs/ui.md § Shell rules; G9). Toasts are a popover surface.
- Do not add page view transitions (`defaultViewTransition`, `viewTransitionName`):
  the old and new page must never be on screen together.
- The query cache follows the signed-in identity (docs/ui.md § Query cache follows identity): a
  confirmed change or loss of it replaces the document (`apps/web/src/lib/document-identity.ts`:
  page hidden and QueryClient sealed, then a full load), seen by every route guard and the root
  `useReloadOnIdentityChange`; every sign-out button goes through `signOutAndLeave()`
  (`apps/web/src/lib/explicit-sign-out.ts`). Every other navigation is a router navigation; do
  not add internal `<a href>` links or `location` reloads.
- The root `FileDropGuard` stops a stray file drop from navigating the tab. A
  component that accepts dropped files registers with `useFileDropTarget`.
- Section tab strips reveal their active tab by setting the strip's `scrollLeft`
  (`useActiveTabScroll`), never with `scrollIntoView`, which also scrolls `<main>`.

## React Rules

- Hooks must be called in the same order on every render.
- Keep hooks above early returns, throws, loops, conditionals, and nested functions.
- Direct `useEffect` calls are banned in `apps/web/src/components/**` and `apps/web/src/routes/**` unless they are legacy audited usages. Prefer derived state, event handlers, query state, or custom hooks under `apps/web/src/hooks/`.
- Route-local component helpers should stay non-exported unless they are truly shared.

## Code Structure

- [`deslop-please`](https://github.com/deterministic-machines/deslop-please) checks the Rust code structure (deep modules, narrow interfaces); fix its findings from first principles, never by mechanical moves that hide them.
- Run it in `apps/cli`: `deslop-please --allow .deslop-please.allow`.
- `.deslop-please.allow` lists existing debt that is muted: fixing an entry never fails, a new finding fails. `deslop-please --update-allow .deslop-please.allow` regenerates it and drops comments.

## Testing and Verification

- Server-side unit tests use Vitest.
- Mock Prisma with `vi.mock("@ws-model-proxy/db")`; tests must not hit a real database.
- Useful checks:

```sh
pnpm db:validate
pnpm db:test-unit
CHECK_DATABASE_URL=<disposable superuser url> pnpm db:check-migrations --base origin/main
pnpm check-types
pnpm --filter web check-types
pnpm test
pnpm --filter web build
pnpm check:ci
```

## Package Management

- This monorepo uses the pnpm catalog in `pnpm-workspace.yaml`.
- When adding or bumping shared dependencies, update the catalog rather than individual workspace versions.
- Ask before installing new dependencies.

## Deployment Notes

- Recommended runtime shape: one Docker web service plus Postgres.
- Releases publish the app container to GHCR and CLI artifacts through GitHub Actions.
- Required production secrets must come from the deployment platform, not committed files.
