# Production hardening

## Password pepper

Password hashes use Better-Auth's scrypt, sealed with AES-256-GCM under a key derived from `BETTER_AUTH_SECRET` with HKDF-SHA256. A database dump, backup, or read-only SQL injection no longer yields crackable hashes without the server secret. A full server compromise with that secret is outside this protection.

Stored format: `pw1:<16-hex key fingerprint>:<base64url(nonce || ciphertext || tag)>`. The fingerprint identifies the key without revealing it. The authenticated additional data (AAD) is `password-v1`. Better-Auth's password hooks receive no user id, so values are not bound to their row. A database writer can still swap two accounts' values.

The server seals legacy unsealed hashes and authenticates every sealed value at startup, in one transaction under an advisory lock, before listening. Sign-in never accepts unsealed hashes. Corrupt values produce a startup warning with a count and the recovery command; startup still succeeds when no unknown keys remain. `pnpm doctor:app` reports fingerprints, counts, and structurally invalid envelopes without changing data. It does not receive the key in its database probe; cryptographic authenticity is checked at server start.

To rotate the secret:

1. Stop every server/replica. Set `BETTER_AUTH_SECRET_PREVIOUS=<old>` and `BETTER_AUTH_SECRET=<new>` for EVERY server/replica at once, then restart them all. Both secrets must be strong, at least 32 characters, and different. Never run replicas with different `BETTER_AUTH_SECRET` configurations side by side: an old-config replica can neither verify re-wrapped hashes nor write current-key ones.
2. Check that the log `password pepper: re-wrapped … none remain under the previous key … BETTER_AUTH_SECRET_PREVIOUS can now be removed` or `pnpm doctor:app` shows 0 remaining under the previous key. Resolve doctor's invalid-envelope warnings before relying on its fingerprint inventory. If hashes remain, keep PREVIOUS set and restart all servers again. If they are corrupt, use the recovery command below.
3. Only after 0 remain, remove `BETTER_AUTH_SECRET_PREVIOUS` everywhere and restart all servers again.

Rotating `BETTER_AUTH_SECRET` still signs everyone out and makes existing TOTP enrolments undecryptable, as before. The previous key applies only to the password pepper; it does not preserve TOTP or purpose-derived credentials such as model API and CLI tokens.

A `PasswordPepperKeyError` refuses startup when stored values name an unconfigured key. Restore the secret used to write them, as `BETTER_AUTH_SECRET` or as `BETTER_AUTH_SECRET_PREVIOUS` during rotation. The message names fingerprints, never secrets.

If the key is lost, or values are corrupt or malformed, the owner stops all servers and runs recovery as a one-shot from a checkout with the validated server environment and database access. It needs no listening server:

```bash
pnpm auth:pepper:reset-unusable                     # dry run: count and affected user ids
pnpm auth:pepper:reset-unusable --confirm <count>   # exact count from the dry run
```

For production or any non-local database, add `--allow-non-local` to both commands, with all servers stopped. The command uses the same local database guard as maintenance scripts by default. It replaces only unusable password values with random passwords nobody knows, sealed under the current key. It keeps credential rows, legacy hashes, and authentic current/previous values. Start the server, then tell the listed users to use the normal forgot-password email flow. SMTP must be configured and working for that flow; configure SMTP before recovery if it was previously disabled.

**Backups:** `BETTER_AUTH_SECRET` also protects passwords. Back it up separately from the database and retain keys needed by older backups. A lost key requires the recovery procedure above for affected passwords. See [backup-and-restore.md](./backup-and-restore.md).
