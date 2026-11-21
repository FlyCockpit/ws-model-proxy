# Contributing to WS Model Proxy

WS Model Proxy 1.0.0 welcomes contributions. Please open an issue to discuss larger changes
before starting work. Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting security issues

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Licensing

WS Model Proxy is licensed under [MIT](LICENSE). Contributions are accepted under the same
license: by submitting a contribution you agree to license it to the project and its users
under MIT. There is no separate contributor license agreement.

## Development setup

The [README](README.md#installation) covers requirements, Docker setup and host development
with `pnpm dev`. `pnpm doctor` diagnoses common setup problems. See the
[CLI README](apps/cli/README.md#development) for Rust development in `apps/cli`.

## Repository rules

Read [AGENTS.md](AGENTS.md) and, for Rust, [apps/cli/AGENTS.md](apps/cli/AGENTS.md).

- Keep changes focused; discuss new dependencies first.
- Keep [sitemap.md](sitemap.md) updated when routes change.
- Keep user-facing web strings in `apps/web/src/locales/`.
- Define environment variables in `scripts/lib/env-manifest.ts`; run `pnpm env:sync` to
  regenerate the example files.
- Leave version numbers to the owner in the release commit.
- Each release line uses one relay protocol. Server and wsmp 1.0 speak only relay 4.0 /
  `ws-model-proxy.relay.v4`. Optional capabilities use hello `features` and run only on
  nodes reporting support. Preserve the HTTP 426 upgrade refusal keys and types
  (`type`, `failure`, `code`, `message`, `supportedVersions`, `supportedSubprotocol`;
  `code: "upgrade_cli"`) and all five `/.well-known/wsmp` fields and types
  (`serverVersion`, `protocolVersion`, `origin`, `installScript: "/install.sh"`,
  `enrollPath: "/api/node/enroll"`). Released CLIs parse these shapes to print upgrade
  instructions. See the [relay guide](apps/cli/docs/relay-protocol.md) and
  [release process](apps/cli/docs/releasing.md).
- Preserve authentication, authorization and request protections. Never include secrets in
  source, tests, fixtures or logs. Tests mock Prisma with `vi.mock("@ws-model-proxy/db")`.

## Checks

Run the checks relevant to your change. The main TypeScript gates are:

```sh
pnpm check:ci
pnpm check-types
pnpm test
pnpm --filter web build
```

### Docker test harnesses

`pnpm test:pg`, `pnpm backup:test`, `pnpm db:test-migrations` and `pnpm db:test-adopt-released`
start throwaway Docker containers (the backup test also a network and a tools image). Each
names them `<prefix>-…`: `test:pg` `<prefix>-test-pg-<run>` (default prefix `wsmp`),
`backup:test` `<prefix>-backup-pg-…`, `-backup-net-…`, `-backup-tool-…` and the
`<prefix>-backup-test-tools:pg17` image (default `wmp`), `db:test-migrations` `<prefix>-<hex>`
(default `wmp-test-migrations`) and `db:test-adopt-released` `<prefix>-fx-release-<hex>`
(default `wmp`). Set `TEST_CONTAINER_PREFIX=<name>` to keep a shared machine's
or a CI job's fixtures in their own namespace; `--container-prefix <name>` (after `--` with
pnpm) overrides the variable. A prefix is lowercase letters and digits joined by `.`, `_`,
`__` or `-`, at most 24 characters; an empty or invalid one is an error before anything is
created (`scripts/lib/test-container-prefix.mjs` and its shell twin `.sh`). The backup test's
tools image is kept for reuse; remove it with `docker image rm <prefix>-backup-test-tools:pg17`.
`pnpm test:postgres` and `pnpm test:docker-entrypoint` start no containers.

For Rust changes, from `apps/cli`:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --locked
cargo test --workspace --doc --locked
cargo xtask sync-docs --check
```

Edit `AGENTS.md` instead of its generated mirrors; run `pnpm sync:agent-docs` at the root
or `cargo xtask sync-docs` in `apps/cli` after changing the corresponding source file.
Do not bypass hooks; fix failing checks.

## Pull requests

Keep each pull request focused, describe the problem and resulting behavior, and fill in the
pull request template with the checks you ran. Update relevant docs, locale bundles and the
sitemap in the same change.
