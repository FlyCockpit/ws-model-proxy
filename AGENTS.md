# AGENTS.md

Rules and context for AI coding agents working in WS Model Proxy.

## Stack

- React 19, TanStack Router, TanStack React Query, TanStack React Form, Zod
- Hono API server
- oRPC routers and procedures
- Prisma with Postgres
- Better Auth
- Tailwind CSS v4 and shadcn/ui in `packages/ui/`
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

## Data and Schema

- The Prisma schema lives in `packages/db/prisma/schema/`.
- Use `pnpm db:push` for local safe schema sync.
- Use `APPLY_SCHEMA=off|safe|dangerous` for deployment-time schema sync through `scripts/docker-entrypoint.sh`.
- Treat `APPLY_SCHEMA=dangerous` and `pnpm db:push:dangerous` as destructive operations requiring explicit review.

Never run:

- `prisma migrate reset`
- `prisma migrate dev`
- `prisma migrate deploy`
- `prisma db push --force-reset`
- `prisma db drop`
- Raw SQL `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, or `DELETE` without a `WHERE` clause

## Web Conventions

- Data fetching goes through oRPC query and mutation options with TanStack Query.
- Conditional fetching uses `enabled` or `skipToken`; do not conditionally call hooks.
- Browser session state goes through `apps/web/src/hooks/use-auth-session.ts`.
  Do not call `.useSession()` anywhere else in production code, and do not
  mirror Better Auth session data into Zustand.
- Route auth checks use `apps/web/src/server/auth-session.ts` plus pure
  decisions from `apps/web/src/lib/route-session-access.ts`. Do not call
  `authClient.getSession()` from route files.
- Content loading states use layout-matching `Skeleton` components.
- Forms use TanStack Form with native Zod validators.
- Mobile touch targets should be at least 44px.
- Respect safe-area CSS variables for edge-to-edge mobile layouts.
- The root shell owns safe areas, bottom-nav clearance, viewport height, and
  top-level scroll. Do not copy app-shell frame geometry into route files.
- Prefer axis-specific overscroll: horizontal scrollers use
  `overflow-x-auto overscroll-x-contain`; bounded vertical panes/dialogs can
  use `overscroll-contain`.
- Use the existing `BottomNav`; do not add a second mobile nav.
- Do not use `transition: all` or Tailwind `transition-all`.
- Use lucide icons where an existing icon fits.

## React Rules

- Hooks must be called in the same order on every render.
- Keep hooks above early returns, throws, loops, conditionals, and nested functions.
- Direct `useEffect` calls are banned in `apps/web/src/components/**` and `apps/web/src/routes/**` unless they are legacy audited usages. Prefer derived state, event handlers, query state, or custom hooks under `apps/web/src/hooks/`.
- Route-local component helpers should stay non-exported unless they are truly shared.

## Testing and Verification

- Server-side unit tests use Vitest.
- Mock Prisma with `vi.mock("@ws-model-proxy/db")`; tests must not hit a real database.
- Useful checks:

```sh
pnpm db:validate
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
