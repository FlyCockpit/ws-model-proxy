# Contributing

Thanks for helping with WS Model Proxy. Pull requests are welcome.

- Read [AGENTS.md](AGENTS.md): it holds the project's rules, for people and
  coding agents alike. The CLI has its own in [apps/cli/AGENTS.md](apps/cli/AGENTS.md).
- **Do not change version numbers.** Leave the app/CLI version
  (`apps/cli/Cargo.toml`, `apps/server/src/version.ts`) and the relay protocol
  version alone. The maintainer bumps them when cutting a release.
- **Keep released nodes working.** Relay protocol 3.0 is permanent: add new
  frames or optional fields, and use a new capability only with nodes that
  report it. Never remove, rename or retype a field. CI checks this
  (`apps/server/src/relay/released-compat.test.ts`); see
  [apps/cli/docs/releasing.md](apps/cli/docs/releasing.md).
- Run the checks listed in AGENTS.md ("Testing and Verification") before you
  open a pull request.
