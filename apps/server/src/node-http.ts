/**
 * The plain HTTP endpoints a node uses before it has a relay session (contracts/http.ts):
 *
 * - `GET /.well-known/wsmp`: what `wsmp login <url>` checks and pins (canonical origin,
 *   protocol, where to enroll).
 * - `GET /install.sh`: installs the `wsmp` CLI: a checksummed release binary (by default once
 *   `CLI_RELEASE_BINARIES_BY_DEFAULT` is flipped at release, or with `WMP_CLI_RELEASE_BASE_URL`),
 *   else a cargo source build (`installScript`).
 * - `POST /api/node/enroll`: exchanges an enrollment code for the node credential
 *   (`@ws-model-proxy/api/nodes/enroll-exchange`). Unauthenticated by design (the code is the
 *   credential): no cookies, no CSRF, rate-limited per client IP before any lookup and per code
 *   owner after it.
 */

import {
  nodeEnrollRequestSchema,
  RELAY_PROTOCOL,
  wellKnownWsmpSchema,
} from "@ws-model-proxy/api/contracts";
import {
  exchangeEnrollmentCode,
  findEnrollmentCodeOwner,
  type NodeEnrollRequest,
} from "@ws-model-proxy/api/nodes/enroll-exchange";
import { env } from "@ws-model-proxy/env/server";
import type { Context, Env, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { RateLimiterMemory } from "rate-limiter-flexible";
import { resolveClientIp } from "./client-ip.js";
import {
  consumeEnrollmentExchange,
  enrollmentExchangeIpLimiter,
  enrollmentExchangeUserLimiter,
  type RateLimiter,
  refundEnrollmentExchange,
} from "./rate-limit.js";

/** The server and CLI version this build ships; `/install.sh` installs the matching wsmp. */
export const SERVER_VERSION = "0.4.0";

/** Where the CLI's source and GitHub Releases live. */
export const CLI_REPOSITORY = "https://github.com/FlyCockpit/ws-model-proxy";

/**
 * Release targets `/install.sh` downloads (`wsmp-<target>.tar.xz`, checksummed in `sha256.sum`;
 * apps/cli/dist-workspace.toml builds them). The Linux builds link glibc, built on Ubuntu 22.04
 * runners, so they need at least {@link CLI_RELEASE_MIN_GLIBC}.
 */
export const CLI_RELEASE_TARGETS = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
] as const;
export const CLI_RELEASE_MIN_GLIBC = { major: 2, minor: 34 } as const;

/** The GitHub Release of this server's version. */
export function defaultCliReleaseBaseUrl(): string {
  return `${CLI_REPOSITORY}/releases/download/v${SERVER_VERSION}`;
}

/**
 * RELEASE FLIP: set to `true` in the release commit (apps/cli/docs/releasing.md, "Flip the CLI
 * install default"). Until then the v0.4.0 release does not exist, so an unconfigured server
 * keeps building the preview branch from source and release binaries are opt-in through
 * `WMP_CLI_RELEASE_BASE_URL`. Once `true`, an unconfigured server installs the release binaries
 * of {@link SERVER_VERSION} from {@link defaultCliReleaseBaseUrl}.
 */
export const CLI_RELEASE_BINARIES_BY_DEFAULT = false;

/** The branch an unconfigured server builds before {@link CLI_RELEASE_BINARIES_BY_DEFAULT}. */
export const CLI_PREVIEW_BRANCH = "redesign-0.4.0";

/**
 * What `/install.sh` installs. `release`: the checksummed binary for the node's platform from
 * `baseUrl`, or a cargo build of this version's tag where no binary fits. `source`: always a
 * cargo build, of the pinned commit (`WMP_CLI_SOURCE_REV`) or else of {@link CLI_PREVIEW_BRANCH}.
 */
export type CliInstallSource =
  | { kind: "release"; baseUrl: string; fallbackBranch?: string }
  | { kind: "source"; rev?: string };

/** `WMP_CLI_SOURCE_REV` wins, then `WMP_CLI_RELEASE_BASE_URL`, then the built-in default. */
export function cliInstallSource(
  rev: string | undefined,
  releaseBaseUrl: string | undefined,
  binariesByDefault: boolean = CLI_RELEASE_BINARIES_BY_DEFAULT,
): CliInstallSource {
  if (rev) return { kind: "source", rev };
  // Before the flip this version's tag does not exist yet: machines without a binary build the
  // preview branch instead.
  if (releaseBaseUrl) {
    return binariesByDefault
      ? { kind: "release", baseUrl: releaseBaseUrl }
      : { kind: "release", baseUrl: releaseBaseUrl, fallbackBranch: CLI_PREVIEW_BRANCH };
  }
  return binariesByDefault
    ? { kind: "release", baseUrl: defaultCliReleaseBaseUrl() }
    : { kind: "source" };
}

// Values are embedded in single quotes; refuse anything that could leave them.
function shellQuoted(value: string): string {
  if (!/^[A-Za-z0-9._~%+@:/=-]*$/.test(value)) {
    throw new Error(`install.sh: refusing to embed ${JSON.stringify(value)}`);
  }
  return `'${value}'`;
}

export const NODE_ENROLL_PATH = "/api/node/enroll";
export const NODE_ENROLL_MAX_BODY_BYTES = 16 * 1024;

function canonicalOrigin(): string {
  return new URL(env.BETTER_AUTH_URL).origin;
}

/**
 * The POSIX installer (`curl -fsSL <origin>/install.sh | sh`). Everything runs from `main` on the
 * last line, so a download cut short runs nothing. Both paths install into `$CARGO_HOME/bin`
 * (`~/.cargo/bin`), where cargo puts a source build, so the two never leave two copies.
 * A release binary is installed only after its SHA-256 matches `sha256.sum` (fail closed: no
 * checksum file, no entry, no hashing tool or a mismatch stops the install).
 */
export function installScript(origin: string, source: CliInstallSource): string {
  const releaseUrl = source.kind === "release" ? source.baseUrl.replace(/\/+$/, "") : "";
  const sourceArgs =
    source.kind === "release"
      ? source.fallbackBranch
        ? `--branch ${shellQuoted(source.fallbackBranch)}`
        : `--tag ${shellQuoted(`v${SERVER_VERSION}`)}`
      : source.rev
        ? `--rev ${shellQuoted(source.rev)}`
        : `--branch ${shellQuoted(CLI_PREVIEW_BRANCH)}`;
  const summary =
    source.kind === "source"
      ? source.rev
        ? `# Builds wsmp from source with cargo at commit ${source.rev} (WMP_CLI_SOURCE_REV).`
        : `# Builds wsmp from source with cargo from the ${CLI_PREVIEW_BRANCH} branch (no release binaries yet).`
      : `# Installs the checksummed wsmp ${SERVER_VERSION} release binary for this machine, or builds\n# v${SERVER_VERSION} from source with cargo where no binary fits.`;
  return `#!/bin/sh
# WS Model Proxy node CLI (wsmp) installer for ${origin}
${summary}
set -eu

WSMP_VERSION=${shellQuoted(SERVER_VERSION)}
WSMP_RELEASE_URL=${shellQuoted(releaseUrl)}
WSMP_REPOSITORY=${shellQuoted(CLI_REPOSITORY)}

say() { printf 'wsmp: %s\\n' "$*"; }
die() { printf 'wsmp: %s\\n' "$*" >&2; exit 1; }

# cargo's bin directory. Under \`set -u\` an unset HOME would abort with a shell error: say why.
cargo_home() {
  [ -n "\${CARGO_HOME:-}" ] || [ -n "\${HOME:-}" ] || die "set HOME (or CARGO_HOME), then run this again."
  printf '%s' "\${CARGO_HOME:-$HOME/.cargo}"
}
bin_dir() { printf '%s/bin' "$(cargo_home)"; }

# The release target for this machine, or nothing when no release binary runs here.
detect_target() {
  arch=$(uname -m)
  case "$arch" in
    x86_64 | amd64) arch=x86_64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    *) return 0 ;;
  esac
  case "$(uname -s)" in
    Linux)
      # The Linux builds link glibc ${CLI_RELEASE_MIN_GLIBC.major}.${CLI_RELEASE_MIN_GLIBC.minor} or newer; musl and older glibc build from source.
      glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
      case "$glibc" in
        "glibc "*) ;;
        *) return 0 ;;
      esac
      version=\${glibc#glibc }
      major=\${version%%.*}
      minor=\${version#*.}
      minor=\${minor%%.*}
      case "$major.$minor" in
        *[!0-9.]* | .* | *.) return 0 ;;
      esac
      if [ "$major" -lt ${CLI_RELEASE_MIN_GLIBC.major} ] || { [ "$major" -eq ${CLI_RELEASE_MIN_GLIBC.major} ] && [ "$minor" -lt ${CLI_RELEASE_MIN_GLIBC.minor} ]; }; then
        return 0
      fi
      printf '%s-unknown-linux-gnu' "$arch"
      ;;
    Darwin)
      # A Rosetta shell reports x86_64 on Apple silicon: install the native build.
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
        arch=aarch64
      fi
      printf '%s-apple-darwin' "$arch"
      ;;
  esac
}

# curl only: wget cannot refuse a redirect away from https for a single download.
fetch() {
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1"
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1"
  else
    return 1
  fi
}

install_release() {
  target=$1
  archive="wsmp-$target.tar.xz"
  command -v curl >/dev/null 2>&1 || die "curl is needed to download wsmp."
  dir=$(bin_dir)
  mkdir -p "$dir"
  # Staged beside the install directory, not in /tmp: the binary is test-run before it is
  # installed (a noexec /tmp would refuse that), and the final rename stays on one filesystem.
  tmp=$(mktemp -d "$dir/.wsmp-install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  say "downloading wsmp $WSMP_VERSION for $target from $WSMP_RELEASE_URL..."
  fetch "$WSMP_RELEASE_URL/sha256.sum" "$tmp/sha256.sum" ||
    die "could not download $WSMP_RELEASE_URL/sha256.sum (is wsmp $WSMP_VERSION published there?)."
  fetch "$WSMP_RELEASE_URL/$archive" "$tmp/$archive" ||
    die "could not download $WSMP_RELEASE_URL/$archive."
  expected=$(awk -v f="$archive" '{ sub(/\\r$/, "") } $2 == f || $2 == "*" f { print tolower($1); exit }' "$tmp/sha256.sum")
  case "$expected" in
    "" | *[!0-9a-f]*) die "sha256.sum has no checksum for $archive; not installing it." ;;
  esac
  [ \${#expected} -eq 64 ] || die "sha256.sum has no checksum for $archive; not installing it."
  actual=$(sha256_of "$tmp/$archive" | awk '{ print tolower($1) }')
  [ -n "$actual" ] ||
    die "no SHA-256 tool (sha256sum, shasum or openssl) found; not installing an unverified binary."
  [ "$actual" = "$expected" ] ||
    die "checksum mismatch for $archive (expected $expected, got $actual); not installing it."
  say "checksum verified ($expected)."
  (cd "$tmp" && tar -xJf "$archive") ||
    die "could not unpack $archive (tar needs xz: install xz-utils)."
  binary="$tmp/wsmp-$target/wsmp"
  [ -f "$binary" ] && [ ! -L "$binary" ] || die "$archive does not contain wsmp-$target/wsmp."
  "$binary" --version >/dev/null 2>&1 ||
    die "the downloaded wsmp does not run on this machine; install Rust 1.88+ and run: cargo install --git $WSMP_REPOSITORY ${sourceArgs} --locked wsmp"
  [ ! -d "$dir/wsmp" ] || die "$dir/wsmp is a directory; remove it, then run this again."
  # Rename over the old binary: a running wsmp keeps its old file.
  chmod 755 "$binary" && mv -f "$binary" "$dir/wsmp" || die "could not install into $dir."
  installed="$dir/wsmp"
}

# A non-interactive SSH shell skips the profile that puts rustup's cargo on PATH: source
# rustup's env file, and keep looking past one that does not provide cargo.
find_cargo() {
  command -v cargo >/dev/null 2>&1 && return 0
  for cargo_env in "\${CARGO_HOME:-}/env" "\${HOME:-}/.cargo/env"; do
    if [ "$cargo_env" != "/env" ] && [ "$cargo_env" != "/.cargo/env" ] && [ -f "$cargo_env" ]; then
      set +eu
      . "$cargo_env"
      set -eu
      command -v cargo >/dev/null 2>&1 && return 0
    fi
  done
  return 0
}

install_source() {
  find_cargo
  command -v cargo >/dev/null 2>&1 ||
    die "cargo is not installed. Install Rust 1.88 or newer from https://rustup.rs and a C compiler (cc), then run this again."
  say "building wsmp from $WSMP_REPOSITORY ($*) with cargo; this takes a few minutes..."
  cargo install --git "$WSMP_REPOSITORY" "$@" --locked --force wsmp
  installed="\${CARGO_INSTALL_ROOT:-$(cargo_home)}/bin/wsmp"
}

finish() {
  dir=\${installed%/wsmp}
  say "installed $installed."
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) say "$dir is not on your PATH: run \\"$dir/wsmp\\", or add it to PATH." ;;
  esac
  found=$(command -v wsmp 2>/dev/null || true)
  if [ -n "$found" ] && [ "$found" != "$installed" ]; then
    say "warning: $found comes first on your PATH (an older wsmp, for example from Homebrew); remove it."
  fi
}

main() {
  installed=""
  if [ -z "$WSMP_RELEASE_URL" ]; then
    install_source ${sourceArgs}
  else
    target=$(detect_target)
    if [ -n "$target" ]; then
      install_release "$target"
    else
      say "no wsmp release binary fits this machine ($(uname -s) $(uname -m); Linux needs glibc ${CLI_RELEASE_MIN_GLIBC.major}.${CLI_RELEASE_MIN_GLIBC.minor} or newer); building from source instead."
      install_source ${sourceArgs}
    fi
  fi
  finish
}

main "$@"
`;
}

type Refusal = { ok: false; error: "rate_limited"; retryAfterSec: number };

function rateLimited(retryAfterMs: number): Refusal {
  return {
    ok: false,
    error: "rate_limited",
    retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}

export type NodeEnrollDeps = {
  ipLimiter?: RateLimiter & Pick<RateLimiterMemory, "reward">;
  userLimiter?: RateLimiter;
  exchange?: typeof exchangeEnrollmentCode;
  findOwner?: typeof findEnrollmentCodeOwner;
  /** Close the relay sessions of credentials the exchange revoked (a re-login or Replace). */
  closeRevokedSessions?: (credentialIds: readonly string[]) => Promise<unknown>;
};

/** `POST /api/node/enroll`. Status 200 when enrolled, 429 when rate-limited, 400 otherwise. */
export function nodeEnrollHandler(deps: NodeEnrollDeps = {}) {
  const ipLimiter = deps.ipLimiter ?? enrollmentExchangeIpLimiter;
  const userLimiter = deps.userLimiter ?? enrollmentExchangeUserLimiter;
  const exchange = deps.exchange ?? exchangeEnrollmentCode;
  const findOwner = deps.findOwner ?? findEnrollmentCodeOwner;
  return async (c: Context) => {
    // Every attempt counts, before parsing or any lookup (code guessing spends the IP budget);
    // a successful enrollment gives its point back, so a fleet behind one address can use a
    // multi-use code.
    const ipKey = `ip:${resolveClientIp(c)}`;
    const byIp = await consumeEnrollmentExchange(ipLimiter, ipKey);
    if (!byIp.allowed) return c.json(rateLimited(byIp.retryAfterMs), 429);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid_code" }, 400);
    }
    const parsed = nodeEnrollRequestSchema.safeParse(body);
    // A malformed request is answered without naming the field (the code may be in it).
    if (!parsed.success) return c.json({ ok: false, error: "invalid_code" }, 400);
    const request: NodeEnrollRequest = parsed.data;
    const owner = await findOwner(request.code);
    if ("refusal" in owner) return c.json(owner.refusal, 400);
    const byUser = await consumeEnrollmentExchange(userLimiter, `user:${owner.ownerUserId}`);
    if (!byUser.allowed) return c.json(rateLimited(byUser.retryAfterMs), 429);
    const outcome = await exchange(request);
    if (outcome.revokedCredentialIds.length > 0 && deps.closeRevokedSessions) {
      try {
        await deps.closeRevokedSessions(outcome.revokedCredentialIds);
      } catch {
        // Revoked rows refuse the next authentication; the old socket ends at its recheck.
      }
    }
    if (outcome.response.ok) {
      await refundEnrollmentExchange(ipLimiter, ipKey);
      // The credential is in this body: never cached.
      return c.json(outcome.response, 200, { "cache-control": "no-store" });
    }
    return c.json(outcome.response, outcome.response.error === "rate_limited" ? 429 : 400);
  };
}

export function registerNodeHttpRoutes<E extends Env>(
  app: Hono<E>,
  deps: NodeEnrollDeps = {},
): void {
  app.get("/.well-known/wsmp", (c) =>
    c.json(
      wellKnownWsmpSchema.parse({
        serverVersion: SERVER_VERSION,
        protocolVersion: RELAY_PROTOCOL,
        origin: canonicalOrigin(),
        installScript: "/install.sh",
        enrollPath: NODE_ENROLL_PATH,
      }),
    ),
  );
  app.get("/install.sh", (c) =>
    c.body(
      installScript(
        canonicalOrigin(),
        cliInstallSource(env.WMP_CLI_SOURCE_REV, env.WMP_CLI_RELEASE_BASE_URL),
      ),
      200,
      {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": "no-store",
      },
    ),
  );
  app.use(
    NODE_ENROLL_PATH,
    bodyLimit({
      maxSize: NODE_ENROLL_MAX_BODY_BYTES,
      onError: (c) => c.json({ ok: false, error: "invalid_code" }, 413),
    }),
  );
  app.post(NODE_ENROLL_PATH, nodeEnrollHandler(deps));
}
