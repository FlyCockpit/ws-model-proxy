## Summary

<!-- Describe the problem and resulting behavior. Link related issues, for example "Closes #123". -->

## Checks run

<!-- List the checks relevant to this change and their results. Explain anything skipped. -->

- [ ] `pnpm check:ci`
- [ ] `pnpm check-types`
- [ ] Relevant tests (list):
- [ ] `pnpm --filter web build` (web changes)
- [ ] Rust formatting, Clippy, tests and docs sync (CLI changes)

## Checklist

- [ ] Relevant docs, locale bundles, environment examples and `sitemap.md` are updated.
- [ ] Generated agent docs are in sync if `AGENTS.md` changed.
- [ ] No secrets or personal data in code, tests, fixtures or logs.
- [ ] Authentication, authorization and request protections are preserved.
