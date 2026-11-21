#!/usr/bin/env bash
# The glibc floor of a GNU wsmp build: fails when <binary> needs a GLIBC_x.y
# symbol version newer than <floor> (for example 2.34), so it would not start
# on a system /install.sh treats as new enough. The release and CLI CI run it
# on every *-unknown-linux-gnu binary; the floor they pass must equal
# CLI_RELEASE_MIN_GLIBC in apps/server/src/node-http.ts.
#
#   bash scripts/check-glibc-floor.sh <binary> <floor>
set -euo pipefail

[ "$#" -eq 2 ] || { echo "usage: $0 <binary> <floor>" >&2; exit 2; }
bin=$1
floor=$2
[[ "$floor" =~ ^[0-9]+\.[0-9]+$ ]] || { echo "::error::floor must be MAJOR.MINOR, not '$floor'" >&2; exit 2; }

# Capture first: a failed readelf must fail the check too.
needs="$(readelf -VW "$bin")"
versions="$(grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' <<<"$needs" | sed 's/^GLIBC_//' | sort -u -V || true)"
if [ -z "$versions" ]; then
  echo "::error::$bin needs no GLIBC_ symbol version; it is not a glibc build" >&2
  exit 1
fi
newest="$(tail -n 1 <<<"$versions")"
highest="$(printf '%s\n%s\n' "$newest" "$floor" | sort -V | tail -n 1)"
if [ "$highest" != "$floor" ]; then
  echo "::error::$bin needs glibc $newest, above the $floor floor that /install.sh promises; build it on an older glibc (the release runner) or raise CLI_RELEASE_MIN_GLIBC deliberately" >&2
  exit 1
fi
echo "$bin: newest glibc symbol version $newest (floor $floor)"
