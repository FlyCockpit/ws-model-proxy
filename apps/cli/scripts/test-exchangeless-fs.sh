#!/usr/bin/env bash
# Run the file tools' real-filesystem tests on FUSE mounts that lack atomic
# exchange (issue #172). It builds the test-only passthrough daemon in
# tests/support/exchangeless, mounts it as an unprivileged user in six classes, runs
# the env-gated Rust test on each mount, and always unmounts.
#
#   scripts/test-exchangeless-fs.sh test  [class...]   mount, check, run the Rust test
#   scripts/test-exchangeless-fs.sh smoke [class...]   mount and check only (no cargo)
#   scripts/test-exchangeless-fs.sh cleanup            unmount leftovers of an aborted run (idempotent)
#
# Classes (all refuse RENAME_EXCHANGE):
#   nr          NOREPLACE rename and link() work
#   link        NOREPLACE is EINVAL, link() works
#   none        NOREPLACE is EINVAL, link() is EPERM
#   <class>-noino   the same, without stable inode numbers (two names of one object
#                   report different st_ino)
#
# Nothing is installed and nothing is skipped: a missing prerequisite or a failed mount
# fails the run. No sudo: mounts go through the distro's setuid fusermount3.
set -uo pipefail

ALL_CLASSES=(nr link none nr-noino link-noino none-noino)
MODE=${1:-test}
[[ $# -gt 0 ]] && shift
CLASSES=("$@")
[[ ${#CLASSES[@]} -eq 0 ]] && CLASSES=("${ALL_CLASSES[@]}")

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cli=$(cd "$here/.." && pwd)
support=$cli/tests/support/exchangeless
vendor=$support/vendor/libfuse3
test_name=file_ops::tests::exchangeless::exchangeless_real_filesystem_optional_e2e
fusermount=/usr/bin/fusermount3
mount_timeout=10
test_timeout=${WSMP_EXCHANGELESS_TEST_TIMEOUT:-180}

case $MODE in test | smoke | cleanup) ;; *) echo "usage: $0 test|smoke|cleanup [class...]" >&2; exit 2 ;; esac

if [[ $MODE == cleanup ]]; then
  # Idempotent last resort for a cancelled job: unmount FUSE mounts that an aborted run left under
  # this runner's temp directory. It touches nothing else and never signals a process.
  base=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/exchangeless-fs.
  status=0
  while read -r mnt; do
    echo "cleanup: unmounting $mnt"
    "$fusermount" -u "$mnt" 2>/dev/null || "$fusermount" -uz "$mnt" 2>/dev/null || { echo "cleanup: could not unmount $mnt" >&2; status=1; }
  done < <(awk -v base="$base" '{ for (i = 1; i <= NF; i++) if ($i == "-") { if (index($5, base) == 1 && $(i + 1) ~ /^fuse/) print $5; break } }' /proc/self/mountinfo)
  exit $status
fi
for class in "${CLASSES[@]}"; do
  ok=0
  for known in "${ALL_CLASSES[@]}"; do [[ $class == "$known" ]] && ok=1; done
  if [[ $ok -ne 1 ]]; then echo "unknown class: $class" >&2; exit 2; fi
done

fail() { echo "FAIL: $*" >&2; }
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/exchangeless-fs.XXXXXX") || exit 2
declare -A DAEMON_PID=() MOUNT_DIR=()
TEST_PID=
failed=0
cleanup_failed=0

mounted() { # exact mountpoint with a FUSE filesystem type
  awk -v mnt="$1" '{ for (i = 1; i <= NF; i++) if ($i == "-") { if ($5 == mnt && $(i + 1) ~ /^fuse/) found = 1; break } } END { exit !found }' /proc/self/mountinfo
}

unmount_class() { # idempotent; only touches what this run mounted
  local class=$1 mnt=${MOUNT_DIR[$1]:-} pid=${DAEMON_PID[$1]:-} tries=0
  [[ -n $mnt ]] || return 0
  while mounted "$mnt" && [[ $tries -lt 10 ]]; do
    "$fusermount" -u "$mnt" 2>/dev/null && break
    tries=$((tries + 1))
    sleep 1
  done
  if mounted "$mnt"; then
    fail "$class: busy mount, using a lazy unmount"
    "$fusermount" -uz "$mnt" 2>/dev/null
    cleanup_failed=1
  fi
  if [[ -n $pid ]]; then
    tries=0
    while kill -0 "$pid" 2>/dev/null && [[ $tries -lt 10 ]]; do sleep 0.5; tries=$((tries + 1)); done
    if kill -0 "$pid" 2>/dev/null; then
      fail "$class: daemon $pid did not exit after unmount; terminating that PID"
      kill -TERM "$pid" 2>/dev/null
      sleep 1
      kill -KILL "$pid" 2>/dev/null
      cleanup_failed=1
    fi
    wait "$pid" 2>/dev/null
  fi
  if mounted "$mnt"; then
    fail "$class: $mnt is still mounted; leaving it"
    cleanup_failed=1
  else
    unset "MOUNT_DIR[$class]" "DAEMON_PID[$class]"
  fi
}

stop_test() { # the active test supervisor (`timeout`, its own process group) and its children
  [[ -n $TEST_PID ]] || return 0
  if kill -0 "$TEST_PID" 2>/dev/null; then
    kill -TERM "$TEST_PID" 2>/dev/null
    local tries=0
    while kill -0 "$TEST_PID" 2>/dev/null && [[ $tries -lt 50 ]]; do sleep 0.1; tries=$((tries + 1)); done
    if kill -0 "$TEST_PID" 2>/dev/null; then kill -KILL -- "-$TEST_PID" 2>/dev/null; kill -KILL "$TEST_PID" 2>/dev/null; fi
  fi
  wait "$TEST_PID" 2>/dev/null
  TEST_PID=
}

cleanup() {
  stop_test
  local class
  for class in "${!MOUNT_DIR[@]}"; do unmount_class "$class"; done
  # Remove the work dir only when nothing of ours is still mounted under it.
  if ! grep -q " $work/" /proc/self/mountinfo; then rm -rf "$work"; else fail "mount left under $work; not removing it"; cleanup_failed=1; fi
}
on_signal() { cleanup; exit 130; }
trap cleanup EXIT
trap on_signal INT TERM

# ---- prerequisites: every one is a hard failure, never a skip --------------------
need() { if ! "$@" >/dev/null 2>&1; then fail "prerequisite missing: $*"; return 1; fi; }
prereq=0
command -v gcc >/dev/null || { fail "gcc is not installed"; prereq=1; }
command -v python3 >/dev/null || { fail "python3 is not installed"; prereq=1; }
[[ -x $fusermount ]] || { fail "$fusermount is not executable"; prereq=1; }
[[ -u $fusermount ]] || { fail "$fusermount is not setuid, unprivileged mounts are impossible"; prereq=1; }
[[ -c /dev/fuse && -r /dev/fuse && -w /dev/fuse ]] || { fail "/dev/fuse is not a readable and writable character device"; prereq=1; }
ldconfig -p 2>/dev/null | grep 'libfuse3\.so\.3 ' >/dev/null || { fail "libfuse3.so.3 is not installed"; prereq=1; }
(cd "$vendor" && sha256sum --quiet -c SHA256SUMS) || { fail "vendored libfuse headers differ from SHA256SUMS"; prereq=1; }
[[ $prereq -eq 0 ]] || exit 1

echo "== FUSE runtime =="
dpkg-query -W fuse3 libfuse3-3 2>&1 || true
"$fusermount" --version 2>&1 || true
header_version=$(sed -n 's/^#define FUSE_MAJOR_VERSION \(.*\)/\1/p;s/^#define FUSE_MINOR_VERSION \(.*\)/\1/p' "$vendor/fuse_common.h" | paste -sd.)
runtime_version=$("$fusermount" --version 2>&1 | sed -n 's/.*version: \([0-9]*\.[0-9]*\).*/\1/p')
echo "vendored headers: $header_version; fusermount3: ${runtime_version:-unknown}"
if [[ $runtime_version != "$header_version" && ${WSMP_EXCHANGELESS_ALLOW_FUSE_MISMATCH:-} != 1 ]]; then
  fail "the FUSE runtime ($runtime_version) differs from the vendored headers ($header_version); review the harness, then set WSMP_EXCHANGELESS_ALLOW_FUSE_MISMATCH=1"
  exit 1
fi

# ---- build ---------------------------------------------------------------------
daemon=$work/fuse-exchangeless
gcc -std=gnu11 -D_FILE_OFFSET_BITS=64 -O2 -Wall -Wextra -Werror -I "$vendor" \
  "$support/fuse-exchangeless.c" -Wl,-l:libfuse3.so.3 -o "$daemon" || { fail "daemon build failed"; exit 1; }

test_binary=
if [[ $MODE == test ]]; then
  (cd "$cli" && cargo test --lib --locked --no-run --message-format=json >"$work/build.json" 2>"$work/build.err") \
    || { cat "$work/build.err" >&2; fail "cargo test --no-run failed"; exit 1; }
  test_binary=$(python3 - "$work/build.json" <<'PY'
import json, sys
exe = None
for line in open(sys.argv[1]):
    try:
        message = json.loads(line)
    except ValueError:
        continue
    if message.get("reason") == "compiler-artifact" and message.get("profile", {}).get("test") and message.get("target", {}).get("kind") == ["lib"] and message.get("executable"):
        exe = message["executable"]
print(exe or "")
PY
  )
  [[ -x $test_binary ]] || { fail "could not locate the lib test binary"; exit 1; }
  count=$("$test_binary" --list --format terse 2>/dev/null | grep -c -x "$test_name: test")
  [[ $count -eq 1 ]] || { fail "the test $test_name is not listed exactly once ($count)"; exit 1; }
fi

# ---- per class -----------------------------------------------------------------
check_capabilities() { # the raw primitives must match the class, independently of the Rust test
  python3 - "$1" "$2" <<'PY'
import ctypes, os, sys
cls, mnt = sys.argv[1], sys.argv[2]
base = cls.removesuffix("-noino")
libc = ctypes.CDLL(None, use_errno=True)
def rename2(a, b, flags):
    ctypes.set_errno(0)
    rc = libc.renameat2(-100, a.encode(), -100, b.encode(), flags)
    return 0 if rc == 0 else ctypes.get_errno()
d = os.path.join(mnt, "cap")
os.mkdir(d)
def put(name):
    with open(os.path.join(d, name), "w") as f: f.write(name)
    return os.path.join(d, name)
a, b = put("a"), put("b")
errors = []
if rename2(a, b, 2) != 22: errors.append("RENAME_EXCHANGE must be EINVAL")
nr = rename2(a, os.path.join(d, "absent"), 1)
if base == "nr":
    if nr != 0: errors.append(f"NOREPLACE to an absent name must work, got errno {nr}")
elif nr != 22: errors.append(f"NOREPLACE must be EINVAL, got errno {nr}")
src = os.path.join(d, "absent") if base == "nr" else a
try:
    os.link(src, os.path.join(d, "alias"))
    linked = True
except OSError as e:
    linked = False
    link_errno = e.errno
if base == "none":
    if linked or link_errno != 1: errors.append("link() must be EPERM")
elif not linked: errors.append(f"link() must work, got errno {link_errno}")
if linked and cls.endswith("-noino"):
    if os.stat(src).st_ino == os.stat(os.path.join(d, "alias")).st_ino: errors.append("noino: two names of one object must report different st_ino")
elif linked and os.stat(src).st_ino != os.stat(os.path.join(d, "alias")).st_ino:
    errors.append("stable inodes: two names of one object must report one st_ino")
for name in os.listdir(d): os.unlink(os.path.join(d, name))
os.rmdir(d)
if errors:
    print("; ".join(errors)); sys.exit(1)
print(f"capabilities match class {cls}")
PY
}

run_class() {
  local class=$1 dir="$work/$1"
  local -a flags=()
  case ${class%-noino} in
    nr) ;;
    link) flags=(PROBE_NO_NOREPLACE=1) ;;
    none) flags=(PROBE_NO_NOREPLACE=1 PROBE_NO_LINK=1) ;;
  esac
  [[ $class == *-noino ]] && flags+=(PROBE_NO_INO=1)
  mkdir -p "$dir/backing" "$dir/mnt" || return 1
  # The none classes cannot create links through the mount. Seed an alias pair
  # in backing storage so the Rust test can verify their declared inode mode.
  printf 'inode-mode fixture\n' >"$dir/backing/inode-probe-a" || return 1
  ln "$dir/backing/inode-probe-a" "$dir/backing/inode-probe-b" || return 1
  MOUNT_DIR[$class]=$dir/mnt
  env PATH=/usr/bin:/bin:"$PATH" PROBE_BACKING="$dir/backing" "${flags[@]}" \
    "$daemon" -f -s "$dir/mnt" >"$dir/daemon.log" 2>&1 &
  DAEMON_PID[$class]=$!
  local waited=0
  until mounted "$dir/mnt"; do
    if ! kill -0 "${DAEMON_PID[$class]}" 2>/dev/null; then fail "$class: the daemon exited before mounting"; cat "$dir/daemon.log" >&2; return 1; fi
    if [[ $waited -ge $((mount_timeout * 10)) ]]; then fail "$class: no FUSE mount at $dir/mnt after ${mount_timeout}s"; cat "$dir/daemon.log" >&2; return 1; fi
    sleep 0.1
    waited=$((waited + 1))
  done
  echo sentinel >"$dir/mnt/.sentinel" && [[ $(cat "$dir/mnt/.sentinel") == sentinel ]] && rm "$dir/mnt/.sentinel" \
    || { fail "$class: the mount does not read and write"; return 1; }
  check_capabilities "$class" "$dir/mnt" || { fail "$class: capability check"; return 1; }
  [[ $MODE == test ]] || return 0
  local out="$dir/test.out"
  # Background plus `wait`: a signal to this script interrupts `wait` at once and the trap runs
  # (a foreground command would defer it), so a cancelled job stops the test before it unmounts.
  WSMP_EXCHANGELESS_REQUIRED=1 WSMP_EXCHANGELESS_CLASS=$class WSMP_EXCHANGELESS_DIR=$dir/mnt \
    timeout -k 10 "$test_timeout" "$test_binary" --exact "$test_name" --nocapture --test-threads=1 >"$out" 2>&1 &
  TEST_PID=$!
  wait "$TEST_PID"
  local status=$?
  TEST_PID=
  cat "$out"
  [[ $status -eq 0 ]] || { fail "$class: the test exited with status $status"; return 1; }
  grep -q '^test result: ok\. 1 passed' "$out" || { fail "$class: the test did not report exactly one pass"; return 1; }
  if grep -q 'SKIP' "$out"; then fail "$class: the test skipped"; return 1; fi
  return 0
}

summary=()
for class in "${CLASSES[@]}"; do
  echo "== class $class =="
  if run_class "$class"; then summary+=("$class: pass"); else summary+=("$class: FAIL"); failed=1; fi
  unmount_class "$class"
done
echo "== summary =="
printf '%s\n' "${summary[@]}"
[[ $cleanup_failed -eq 0 ]] || failed=1
exit $failed
