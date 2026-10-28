/**
 * The plain HTTP endpoints a node uses before it has a relay session (contracts/http.ts):
 *
 * - `GET /.well-known/wsmp`: what `wsmp login <url>` checks and pins (canonical origin,
 *   protocol, where to enroll).
 * - `GET /install.sh`: installs the `wsmp` CLI: a checksummed release binary (by default once
 *   `CLI_RELEASE_BINARIES_BY_DEFAULT` is flipped at release, or with `WMP_CLI_RELEASE_BASE_URL`),
 *   else a cargo source build (`installScript`).
 * - `GET /install.ps1`: the same for Windows (`windowsInstallScript`). Both installers write the
 *   install receipt `<state_dir>/install.json` the node's self-update reads.
 * - `GET /cli/manifest.json`: the release `wsmp` self-update installs (`agent.update`): version,
 *   and each target's archive URL and SHA-256 from the release's `sha256.sum`. Fails closed
 *   (503) when the checksums cannot be read; `sourceBuild: true` with no artifacts when this
 *   server builds the CLI from source.
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
import { SERVER_VERSION } from "./version.js";

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
 * install default"). Before that, this version's release does not exist, so an unconfigured server
 * keeps building the preview branch from source and release binaries are opt-in through
 * `WMP_CLI_RELEASE_BASE_URL`. Once `true`, an unconfigured server installs the release binaries
 * of {@link SERVER_VERSION} from {@link defaultCliReleaseBaseUrl}.
 */
export const CLI_RELEASE_BINARIES_BY_DEFAULT = true;

/** The branch an unconfigured server builds before {@link CLI_RELEASE_BINARIES_BY_DEFAULT}. */
export const CLI_PREVIEW_BRANCH = "master";

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

/**
 * The commit of the wsmp this server installs, when it can vouch for it: a pinned source build's
 * rev, or this image's own commit (`BUILD_VERSION`, the git SHA the release workflow builds the
 * image and the CLI from) while it serves the GitHub Release of its own version. Binaries from
 * `WMP_CLI_RELEASE_BASE_URL`, or a preview-branch build, have no commit it knows.
 */
export function cliInstallCommit(
  source: CliInstallSource,
  buildVersion: string | undefined = env.BUILD_VERSION,
): string | null {
  if (source.kind === "source") return source.rev ?? null;
  if (source.fallbackBranch || source.baseUrl !== defaultCliReleaseBaseUrl()) return null;
  return buildVersion && /^[0-9a-f]{40}$/.test(buildVersion) ? buildVersion : null;
}

/** The cargo arguments `/install.sh` builds from source with (unquoted, for display). */
function cargoSourceArgs(source: CliInstallSource): string {
  if (source.kind === "release")
    return source.fallbackBranch ? `--branch ${source.fallbackBranch}` : `--tag v${SERVER_VERSION}`;
  return source.rev ? `--rev ${source.rev}` : `--branch ${CLI_PREVIEW_BRANCH}`;
}

/** The source build a node runs by hand (self-update D8: never from the browser). */
export function cargoInstallCommand(source: CliInstallSource): string {
  return `cargo install --git ${CLI_REPOSITORY} ${cargoSourceArgs(source)} --locked --force wsmp`;
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
  // The commit a source build is pinned to (the receipt names it); nothing otherwise.
  const sourceRev = source.kind === "source" ? (source.rev ?? "") : "";
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
WSMP_SOURCE_REV=${shellQuoted(sourceRev)}

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

# The node's state directory, exactly as wsmp resolves it (apps/cli/src/paths.rs state_dir):
# WSMP_STATE_DIR, else $XDG_STATE_HOME/ws-model-proxy, else ~/.local/state/ws-model-proxy.
# Nothing (no receipt) when a variable is set but empty or there is no HOME.
state_dir() {
  if [ -n "\${WSMP_STATE_DIR+x}" ]; then
    [ -n "$WSMP_STATE_DIR" ] || return 1
    printf '%s' "$WSMP_STATE_DIR"
  elif [ -n "\${XDG_STATE_HOME+x}" ]; then
    [ -n "$XDG_STATE_HOME" ] || return 1
    printf '%s/ws-model-proxy' "$XDG_STATE_HOME"
  else
    [ -n "\${HOME:-}" ] || return 1
    printf '%s/.local/state/ws-model-proxy' "$HOME"
  fi
}

# A JSON string, or null for nothing (or text with control characters).
json_str() {
  case "$1" in
    "" | *[[:cntrl:]]*) printf 'null' ;;
    *) printf '"%s"' "$(printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')" ;;
  esac
}

# The install receipt <state_dir>/install.json: how this wsmp was installed (self-update reads
# it to choose how to update). Best effort: a failure here never fails the install.
write_receipt() {
  method=$1
  target=$2
  commit=$3
  state=$(state_dir) || return 0
  version=$("$installed" --version 2>/dev/null | awk 'NR == 1 { print $2 }') || version=""
  case "$version" in *[!0-9A-Za-z.+-]*) version="" ;; esac
  (umask 077 && mkdir -p "$state") || return 1
  receipt="$state/.install.json.$$"
  printf '{"method":"%s","version":%s,"commit":%s,"target":%s,"binary":%s,"installedAt":"%s"}\\n' \\
    "$method" "$(json_str "$version")" "$(json_str "$commit")" "$(json_str "$target")" \\
    "$(json_str "$installed")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$receipt" &&
    mv -f "$receipt" "$state/install.json"
}

# The target triple of a source build (rustc's host), or nothing.
rust_host() {
  command -v rustc >/dev/null 2>&1 || return 0
  rustc -vV 2>/dev/null | awk '/^host: / { print $2 }'
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
  receipt_method=script
  receipt_target=$target
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
  receipt_method=source
  receipt_target=$(rust_host)
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
  receipt_method=""
  receipt_target=""
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
  write_receipt "$receipt_method" "$receipt_target" "$WSMP_SOURCE_REV" ||
    say "warning: could not write the install receipt (wsmp still works)."
  finish
}

main "$@"
`;
}

/**
 * The Windows release target `/install.ps1` downloads (`wsmp-<target>.zip`, checksummed in
 * `sha256.sum`). Windows 11 on ARM64 runs it under x64 emulation.
 */
export const CLI_WINDOWS_TARGET = "x86_64-pc-windows-msvc";

/**
 * The PowerShell installer (`irm <origin>/install.ps1 | iex`), for Windows PowerShell 5.1 and
 * PowerShell 7. The counterpart of {@link installScript}: the checksummed release binary, else a
 * cargo build, into `%CARGO_HOME%\bin` (`%USERPROFILE%\.cargo\bin`). Everything runs in one script
 * block, so a download cut short does not parse and runs nothing. A failure throws (never `exit`,
 * which would close the PowerShell window it runs in), which also stops a command after `iex` on
 * the same line, such as the enrollment one-liner's `wsmp login`.
 */
export function windowsInstallScript(origin: string, source: CliInstallSource): string {
  const releaseUrl = source.kind === "release" ? source.baseUrl.replace(/\/+$/, "") : "";
  const sourceArgs =
    source.kind === "release"
      ? source.fallbackBranch
        ? `'--branch', ${shellQuoted(source.fallbackBranch)}`
        : `'--tag', ${shellQuoted(`v${SERVER_VERSION}`)}`
      : source.rev
        ? `'--rev', ${shellQuoted(source.rev)}`
        : `'--branch', ${shellQuoted(CLI_PREVIEW_BRANCH)}`;
  const sourceHint = sourceArgs.replaceAll("'", "").replace(",", "");
  const sourceRev = source.kind === "source" ? (source.rev ?? "") : "";
  const summary =
    source.kind === "source"
      ? source.rev
        ? `# Builds wsmp from source with cargo at commit ${source.rev} (WMP_CLI_SOURCE_REV).`
        : `# Builds wsmp from source with cargo from the ${CLI_PREVIEW_BRANCH} branch (no release binaries yet).`
      : `# Installs the checksummed wsmp ${SERVER_VERSION} release binary for Windows, or builds\n# v${SERVER_VERSION} from source with cargo where it does not run.`;
  return `# WS Model Proxy node CLI (wsmp) installer for ${origin}
${summary}
# Run it in PowerShell: irm ${origin}/install.ps1 | iex
& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WsmpVersion = ${shellQuoted(SERVER_VERSION)}
$WsmpReleaseUrl = ${shellQuoted(releaseUrl)}
$WsmpRepository = ${shellQuoted(CLI_REPOSITORY)}
$WsmpTarget = ${shellQuoted(CLI_WINDOWS_TARGET)}
$WsmpSourceArgs = @(${sourceArgs})
$WsmpSourceRev = ${shellQuoted(sourceRev)}

function Say([string]$Text) { Write-Host "wsmp: $Text" }

# cargo's home: its bin directory is where cargo puts a source build, so the two never leave two copies.
function Get-CargoHome {
  if ($env:CARGO_HOME) { return $env:CARGO_HOME }
  if (-not $env:USERPROFILE) { throw 'wsmp: set USERPROFILE (or CARGO_HOME), then run this again.' }
  Join-Path $env:USERPROFILE '.cargo'
}

function Get-WsmpFile([string]$Url, [string]$OutFile) {
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
}

function Install-Release {
  $dir = Join-Path (Get-CargoHome) 'bin'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  # Copies an earlier install renamed out of the way while it ran, now free to go.
  Get-ChildItem -LiteralPath $dir -Filter '.wsmp-old.*' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  $tmp = Join-Path $dir ('.wsmp-install.' + [IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $archive = "wsmp-$WsmpTarget.zip"
    Say "downloading wsmp $WsmpVersion for $WsmpTarget from $WsmpReleaseUrl..."
    $sums = Join-Path $tmp 'sha256.sum'
    try { Get-WsmpFile "$WsmpReleaseUrl/sha256.sum" $sums } catch {
      throw "wsmp: could not download $WsmpReleaseUrl/sha256.sum (is wsmp $WsmpVersion published there?)."
    }
    $zip = Join-Path $tmp $archive
    try { Get-WsmpFile "$WsmpReleaseUrl/$archive" $zip } catch {
      throw "wsmp: could not download $WsmpReleaseUrl/$archive."
    }
    $expected = $null
    foreach ($line in Get-Content -LiteralPath $sums) {
      $fields = @($line.Trim() -split '\\s+')
      if ($fields.Count -ge 2 -and ($fields[1] -ceq $archive -or $fields[1] -ceq "*$archive")) {
        $expected = $fields[0].ToLowerInvariant()
        break
      }
    }
    if ($expected -notmatch '^[0-9a-f]{64}$') {
      throw "wsmp: sha256.sum has no checksum for $archive; not installing it."
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "wsmp: checksum mismatch for $archive (expected $expected, got $actual); not installing it."
    }
    Say "checksum verified ($expected)."
    $unpacked = Join-Path $tmp 'unpacked'
    Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
    $binary = @((Join-Path $unpacked 'wsmp.exe'), (Join-Path $unpacked "wsmp-$WsmpTarget\\wsmp.exe")) |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $binary) { throw "wsmp: $archive does not contain wsmp.exe." }
    $runs = $false
    try { & $binary --version *> $null; $runs = $LASTEXITCODE -eq 0 } catch { $runs = $false }
    if (-not $runs) {
      throw "wsmp: the downloaded wsmp does not run on this machine; install Rust 1.88+ and run: cargo install --git $WsmpRepository ${sourceHint} --locked wsmp"
    }
    $installed = Join-Path $dir 'wsmp.exe'
    if (Test-Path -LiteralPath $installed -PathType Container) {
      throw "wsmp: $installed is a directory; remove it, then run this again."
    }
    # A running wsmp.exe (the service) cannot be replaced, but it can be renamed out of the way.
    if (Test-Path -LiteralPath $installed) {
      $old = Join-Path $dir ('.wsmp-old.' + [IO.Path]::GetRandomFileName())
      Move-Item -LiteralPath $installed -Destination $old
      Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
    }
    Move-Item -LiteralPath $binary -Destination $installed
    $installed
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-Source {
  $cargo = Get-Command cargo -ErrorAction SilentlyContinue
  if (-not $cargo) {
    $candidate = Join-Path (Get-CargoHome) 'bin\\cargo.exe'
    if (Test-Path -LiteralPath $candidate) { $cargo = $candidate }
  }
  if (-not $cargo) {
    throw 'wsmp: cargo is not installed. Install Rust 1.88 or newer from https://rustup.rs (with the Visual Studio C++ build tools), then run this again.'
  }
  Say "building wsmp from $WsmpRepository ($($WsmpSourceArgs -join ' ')) with cargo; this takes a few minutes..."
  & $cargo install --git $WsmpRepository @WsmpSourceArgs --locked --force wsmp
  if ($LASTEXITCODE -ne 0) { throw 'wsmp: cargo install failed.' }
  $root = if ($env:CARGO_INSTALL_ROOT) { $env:CARGO_INSTALL_ROOT } else { Get-CargoHome }
  Join-Path $root 'bin\\wsmp.exe'
}

# The node's state directory, exactly as wsmp resolves it (apps/cli/src/paths.rs state_dir):
# WSMP_STATE_DIR, else $XDG_STATE_HOME\\ws-model-proxy, else %LOCALAPPDATA%\\ws-model-proxy.
function Get-WsmpStateDir {
  if ($null -ne $env:WSMP_STATE_DIR) {
    if ($env:WSMP_STATE_DIR -eq '') { return $null }
    return $env:WSMP_STATE_DIR
  }
  if ($null -ne $env:XDG_STATE_HOME) {
    if ($env:XDG_STATE_HOME -eq '') { return $null }
    return (Join-Path $env:XDG_STATE_HOME 'ws-model-proxy')
  }
  $local = [Environment]::GetFolderPath('LocalApplicationData')
  if (-not $local) { return $null }
  Join-Path $local 'ws-model-proxy'
}

# The install receipt <state_dir>\\install.json: how this wsmp was installed (self-update reads
# it to choose how to update). Best effort: a failure here never fails the install.
function Write-WsmpReceipt([string]$Method, [string]$Target, [string]$Binary) {
  try {
    $state = Get-WsmpStateDir
    if (-not $state) { return }
    $version = $null
    try {
      $line = @(& $Binary --version 2>$null) | Select-Object -First 1
      if ($line -match '^\\S+\\s+([0-9A-Za-z.+-]+)\\s*$') { $version = $Matches[1] }
    } catch { $version = $null }
    $receipt = [ordered]@{
      method = $Method
      version = $version
      commit = $(if ($WsmpSourceRev) { $WsmpSourceRev } else { $null })
      target = $(if ($Target) { $Target } else { $null })
      binary = $Binary
      installedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture)
    }
    New-Item -ItemType Directory -Force -Path $state | Out-Null
    $path = Join-Path $state 'install.json'
    $tmp = "$path.$PID.tmp"
    [IO.File]::WriteAllText($tmp, ($receipt | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
    Move-Item -LiteralPath $tmp -Destination $path -Force
  } catch {
    Say 'warning: could not write the install receipt (wsmp still works).'
  }
}

function Get-RustHost {
  $rustc = Get-Command rustc -ErrorAction SilentlyContinue
  if (-not $rustc) { return $null }
  try {
    foreach ($line in @(& $rustc -vV 2>$null)) { if ($line -match '^host: (\\S+)$') { return $Matches[1] } }
  } catch { }
  $null
}

$installed = $null
$receiptMethod = 'source'
$receiptTarget = $null
if (-not $WsmpReleaseUrl) {
  $installed = Install-Source
} elseif ($env:PROCESSOR_ARCHITECTURE -in @('AMD64', 'ARM64')) {
  $installed = Install-Release
  $receiptMethod = 'script-ps1'
  $receiptTarget = $WsmpTarget
} else {
  Say "no wsmp release binary fits this machine ($env:PROCESSOR_ARCHITECTURE); building from source instead."
  $installed = Install-Source
}
if ($receiptMethod -eq 'source') { $receiptTarget = Get-RustHost }
Write-WsmpReceipt $receiptMethod $receiptTarget $installed
$dir = Split-Path -Parent $installed
Say "installed $installed."
if (-not (@($env:Path -split ';') -contains $dir)) {
  Say "$dir is not on your PATH: run \`"$installed\`", or add it to PATH."
}
$found = Get-Command wsmp -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($found -and $found.Source -ne $installed) {
  Say "warning: $($found.Source) comes first on your PATH (an older wsmp); remove it."
}
}
`;
}

// ── The release manifest (`GET /cli/manifest.json`, self-update) ──

export const CLI_MANIFEST_PATH = "/cli/manifest.json";
const SHA256_SUM_MAX_BYTES = 64 * 1024;
const MANIFEST_FETCH_TIMEOUT_MS = 10_000;
const MANIFEST_MAX_REDIRECTS = 5;
/** How long a read manifest is used, and how soon a failed read is tried again. */
export const CLI_MANIFEST_TTL_MS = 5 * 60_000;
export const CLI_MANIFEST_FAILURE_TTL_MS = 30_000;

export type CliReleaseManifest = {
  version: string;
  /** The commit the release was built from, when the server knows it (a pinned source build). */
  commit: string | null;
  /** Where the archives and `sha256.sum` live; null for a source build. */
  releaseUrl: string | null;
  /** This server builds the CLI from source: nothing to download (self-update D8). */
  sourceBuild: boolean;
  /** By target triple: the archive and its SHA-256 from `sha256.sum`. */
  artifacts: Record<string, { url: string; sha256: string }>;
};

/** The release could not be read: no update is offered (fail closed). */
export class CliManifestUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliManifestUnavailable";
  }
}

const ARCHIVE_NAME = /^wsmp-([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+){2,3})\.(?:tar\.xz|zip)$/;

/**
 * The archives `sha256.sum` lists (`<hex>  <name>` or `<hex> *<name>`), by target. Fails closed:
 * a malformed line naming an archive, or one archive listed with two checksums, refuses the file.
 */
export function parseSha256Sum(
  text: string,
  releaseUrl: string,
): Record<string, { url: string; sha256: string }> {
  const artifacts: Record<string, { url: string; sha256: string }> = {};
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "") continue;
    const match = /^([0-9A-Fa-f]{64}) [ *](.+)$/.exec(line);
    const name = match?.[2] ?? line.split(/\s+/).pop() ?? "";
    const archive = ARCHIVE_NAME.exec(name.replace(/^\*/, ""));
    if (!archive) continue;
    const target = archive[1] ?? "";
    if (!match) throw new CliManifestUnavailable(`sha256.sum has a malformed line for ${name}.`);
    const sha256 = (match[1] ?? "").toLowerCase();
    const existing = artifacts[target];
    if (existing && (existing.sha256 !== sha256 || !existing.url.endsWith(`/${name}`)))
      throw new CliManifestUnavailable(`sha256.sum lists ${target} twice.`);
    artifacts[target] = { url: `${releaseUrl}/${name}`, sha256 };
  }
  return artifacts;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The body, read only up to `max` bytes: a larger one is refused once it passes the cap. */
async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max)
    throw new CliManifestUnavailable("sha256.sum is too large.");
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new CliManifestUnavailable("sha256.sum is too large.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** GET over https only (a redirect away from https is refused), at most 64 KiB of text. */
async function fetchSmallText(fetchImpl: FetchLike, start: string): Promise<string> {
  let url = start;
  for (let hop = 0; hop <= MANIFEST_MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new CliManifestUnavailable("A redirect without a location.");
      const next = new URL(location, url);
      if (next.protocol !== "https:")
        throw new CliManifestUnavailable("A redirect away from https was refused.");
      url = next.href;
      continue;
    }
    if (!response.ok) throw new CliManifestUnavailable(`sha256.sum answered ${response.status}.`);
    return new TextDecoder().decode(await readCapped(response, SHA256_SUM_MAX_BYTES));
  }
  throw new CliManifestUnavailable("Too many redirects.");
}

/** Reads the manifest of what `/install.sh` installs (no cache). */
export async function readCliReleaseManifest(
  source: CliInstallSource,
  fetchImpl: FetchLike = fetch,
): Promise<CliReleaseManifest> {
  if (source.kind === "source")
    return {
      version: SERVER_VERSION,
      commit: source.rev ?? null,
      releaseUrl: null,
      sourceBuild: true,
      artifacts: {},
    };
  const releaseUrl = source.baseUrl.replace(/\/+$/, "");
  let text: string;
  try {
    text = await fetchSmallText(fetchImpl, `${releaseUrl}/sha256.sum`);
  } catch (error) {
    if (error instanceof CliManifestUnavailable) throw error;
    throw new CliManifestUnavailable("sha256.sum could not be downloaded.");
  }
  const artifacts = parseSha256Sum(text, releaseUrl);
  if (Object.keys(artifacts).length === 0)
    throw new CliManifestUnavailable("sha256.sum lists no wsmp archive.");
  return {
    version: SERVER_VERSION,
    commit: cliInstallCommit(source),
    releaseUrl,
    sourceBuild: false,
    artifacts,
  };
}

/**
 * The manifest, cached briefly (a read for 5 minutes, a failure for 30 seconds), one read at a
 * time. `get` throws {@link CliManifestUnavailable} when it cannot be read.
 */
export function createCliManifestCache(options: {
  source: () => CliInstallSource;
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  failureTtlMs?: number;
}) {
  const now = options.now ?? Date.now;
  let cached: {
    at: number;
    ok: boolean;
    value: CliReleaseManifest | CliManifestUnavailable;
  } | null = null;
  let reading: Promise<CliReleaseManifest> | null = null;
  const fresh = () =>
    cached !== null &&
    now() - cached.at <
      (cached.ok
        ? (options.ttlMs ?? CLI_MANIFEST_TTL_MS)
        : (options.failureTtlMs ?? CLI_MANIFEST_FAILURE_TTL_MS));
  return {
    async get(): Promise<CliReleaseManifest> {
      if (cached && fresh()) {
        if (cached.ok) return cached.value as CliReleaseManifest;
        throw cached.value;
      }
      reading ??= readCliReleaseManifest(options.source(), options.fetch)
        .then((manifest) => {
          cached = { at: now(), ok: true, value: manifest };
          return manifest;
        })
        .catch((error: unknown) => {
          const failure =
            error instanceof CliManifestUnavailable
              ? error
              : new CliManifestUnavailable("The release manifest could not be read.");
          cached = { at: now(), ok: false, value: failure };
          throw failure;
        })
        .finally(() => {
          reading = null;
        });
      return reading;
    },
  };
}

/** This server's: what its `/install.sh` installs. */
export const cliReleaseManifests = createCliManifestCache({
  source: () => cliInstallSource(env.WMP_CLI_SOURCE_REV, env.WMP_CLI_RELEASE_BASE_URL),
});

/** `GET /cli/manifest.json`. 503 when the release's checksums cannot be read (fail closed). */
export function cliManifestHandler(
  cache: { get(): Promise<CliReleaseManifest> } = cliReleaseManifests,
) {
  return async (c: Context) => {
    try {
      return c.json(await cache.get(), 200, { "cache-control": "no-store" });
    } catch (error) {
      return c.json(
        {
          error: "manifest_unavailable",
          message:
            error instanceof CliManifestUnavailable
              ? error.message
              : "The release manifest could not be read.",
        },
        503,
        { "cache-control": "no-store" },
      );
    }
  };
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
  /** The release manifest cache (`GET /cli/manifest.json`). */
  manifest?: { get(): Promise<CliReleaseManifest> };
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
  app.get("/install.ps1", (c) =>
    c.body(
      windowsInstallScript(
        canonicalOrigin(),
        cliInstallSource(env.WMP_CLI_SOURCE_REV, env.WMP_CLI_RELEASE_BASE_URL),
      ),
      200,
      {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    ),
  );
  app.get(CLI_MANIFEST_PATH, cliManifestHandler(deps.manifest));
  app.use(
    NODE_ENROLL_PATH,
    bodyLimit({
      maxSize: NODE_ENROLL_MAX_BODY_BYTES,
      onError: (c) => c.json({ ok: false, error: "invalid_code" }, 413),
    }),
  );
  app.post(NODE_ENROLL_PATH, nodeEnrollHandler(deps));
}
