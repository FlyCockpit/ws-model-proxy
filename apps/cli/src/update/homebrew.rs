//! The Homebrew strategy (D10): `brew upgrade flycockpit/tap/wsmp`, only for an
//! unpinned install from `flycockpit/tap`, and only when the refreshed tap has
//! exactly the version asked for (checked before anything is installed). No
//! dead-man and no rollback: the server's deadline marks an update that never
//! confirms.
//!
//! `brew upgrade` installs whatever the tap's formula says when it runs, so
//! the last version check and the upgrade both run while wsmp holds Homebrew's
//! own update lock ([`TapLock`]). That keeps the version installed the version
//! checked against an ordinary concurrent refresh, not against every way the
//! tap can change (below). Every `brew update` (and every auto-update, which
//! runs `brew update --auto-update`) tries that lock before it touches a tap
//! and does not wait for it: while wsmp holds it, the refresh fails at once
//! ("Another `brew update` process is already running") and has to be run
//! again later. `brew info` and `brew upgrade` with `HOMEBREW_NO_AUTO_UPDATE`
//! never take it. Homebrew 7.0.11 (c6069d2a943b71b0a90d91fc1ac93cb9c1634dcc):
//! `Library/Homebrew/cmd/update.sh:712` (`lock update`, before any tap fetch
//! or merge at :759-1083), `Library/Homebrew/utils/lock.sh:7-75` (`flock(2)`
//! on `${HOMEBREW_PREFIX}/var/homebrew/locks/update`, non-blocking: `lockf -t
//! 0` / `flock -n`, and an error when taken),
//! `Library/Homebrew/utils/auto-update.sh:21,119` (no auto-update with
//! `HOMEBREW_NO_AUTO_UPDATE`; otherwise `brew update --auto-update`); no other
//! `lock update` in Homebrew. The same lock is in 3.0.0 and 4.0.0. `brew
//! cleanup` unlinks lock files it can lock (`Library/Homebrew/cleanup.rb`
//! `cleanup_lockfiles`), so wsmp checks after locking that it holds the file
//! the path names ([`TapLock::acquire`]).
//!
//! Not stopped by the lock (accepted residuals):
//! - a `brew update` that was already starting when a `brew cleanup` replaced
//!   the lock file: `lock.sh` opens the old file, then locks it without
//!   checking it is still the one the path names, so it can move the tap
//!   during the upgrade. That is a gap in Homebrew's own locking that wsmp
//!   cannot close;
//! - a tap changed by hand (`git` in the tap, `brew update-reset`, deleting
//!   the lock file);
//! - wsmp dying while its `brew upgrade` keeps running: the lock goes with
//!   wsmp, so a `brew update` in that window can move the tap.
//!
//! While the wsmp that ran the upgrade is alive, its version check after the
//! upgrade reports the first two as failed / version mismatch. The third
//! leaves no such check: the wsmp that would run it is gone. What shows it is
//! the server's deadline for the update, and the version the relay reports
//! when it next starts.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};

pub const FORMULA: &str = "flycockpit/tap/wsmp";
pub const TAP: &str = "flycockpit/tap";
/// What a person runs when Homebrew cannot update wsmp by itself.
pub const MANUAL_COMMAND: &str = "brew reinstall flycockpit/tap/wsmp && wsmp service restart";

/// `brew update` (every tap and Homebrew itself).
pub const REFRESH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// `brew info` reads the local tap.
pub const INFO_TIMEOUT: Duration = Duration::from_secs(2 * 60);
/// `brew upgrade` downloads and pours the bottle. Inside the server's download
/// deadline (15 min after the last progress), so a hung brew is ended here
/// first and reported as a failure.
pub const UPGRADE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// `brew --prefix` (a shell builtin of brew: no Ruby, no network).
pub const PREFIX_TIMEOUT: Duration = Duration::from_secs(60);
/// How long to wait for another `brew update` to let go of Homebrew's update
/// lock.
pub const TAP_LOCK_WAIT: Duration = Duration::from_secs(5 * 60);

/// A wsmp keg: `<prefix>/Cellar/wsmp/<version>/bin/wsmp`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keg {
    pub prefix: PathBuf,
    pub dir: PathBuf,
}

/// The keg a (canonical) binary path lies in.
pub fn keg_of(exe: &Path) -> Option<Keg> {
    let parts: Vec<Component<'_>> = exe.components().collect();
    let cellar = parts
        .iter()
        .rposition(|part| part.as_os_str() == "Cellar")?;
    let rest: Vec<&std::ffi::OsStr> = parts[cellar + 1..]
        .iter()
        .map(|part| part.as_os_str())
        .collect();
    let file = exe.file_name()?;
    if rest.len() != 4
        || rest[0] != "wsmp"
        || rest[2] != "bin"
        || !(file == "wsmp" || file == "wsmp.exe")
    {
        return None;
    }
    let prefix: PathBuf = parts[..cellar].iter().collect();
    let dir = prefix.join("Cellar").join("wsmp").join(rest[1]);
    Some(Keg { prefix, dir })
}

/// The link Homebrew keeps pointing at the current keg:
/// `<prefix>/opt/wsmp/bin/wsmp`. Services record this, never a versioned
/// `Cellar` path that `brew upgrade` and `brew cleanup` remove.
pub fn stable_path(exe: &Path) -> Option<PathBuf> {
    let keg = keg_of(exe)?;
    Some(keg.prefix.join("opt").join("wsmp").join("bin").join("wsmp"))
}

/// The tap a keg was installed from (`INSTALL_RECEIPT.json` `source.tap`).
pub fn tap_of(keg: &Keg) -> Option<String> {
    let text = std::fs::read_to_string(keg.dir.join("INSTALL_RECEIPT.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("source")?
        .get("tap")?
        .as_str()
        .map(str::to_ascii_lowercase)
}

/// Whether `brew list --pinned` names wsmp.
pub fn pinned_in(listing: &str) -> bool {
    listing
        .lines()
        .any(|line| matches!(line.trim(), "wsmp" | "flycockpit/tap/wsmp"))
}

fn brew(keg: &Keg) -> PathBuf {
    keg.prefix.join("bin").join("brew")
}

/// Why Homebrew may not update this install, if it may not: a pinned
/// formula, or one from another tap.
pub fn refusal(keg: &Keg) -> Result<Option<String>> {
    let (ok, listing) = super::deadman::run_bounded(
        brew(keg),
        &["list", "--pinned"],
        &[],
        Duration::from_secs(60),
    )
    .context("running `brew list --pinned`")?;
    anyhow::ensure!(ok, "`brew list --pinned` failed: {}", listing.trim());
    if pinned_in(&listing) {
        return Ok(Some(format!(
            "wsmp is pinned in Homebrew (`brew unpin wsmp` to allow updates); run: {MANUAL_COMMAND}"
        )));
    }
    match tap_of(keg) {
        Some(tap) if tap == TAP => Ok(None),
        Some(tap) => Ok(Some(format!(
            "wsmp came from the Homebrew tap `{tap}`, not `{TAP}`; run: {MANUAL_COMMAND}"
        ))),
        None => Ok(Some(format!(
            "wsmp's Homebrew tap is unknown; run: {MANUAL_COMMAND}"
        ))),
    }
}

/// `brew update`: fetch the taps, so the formula's version is the tap's latest.
/// Changes Homebrew's tap checkouts only, never an installed keg. It takes
/// Homebrew's update lock itself: never call it while holding a [`TapLock`].
pub fn refresh(keg: &Keg) -> Result<()> {
    let (ok, output) = super::deadman::run_bounded(brew(keg), &["update"], &[], REFRESH_TIMEOUT)
        .context("running `brew update`")?;
    anyhow::ensure!(ok, "`brew update` failed: {}", output.trim());
    Ok(())
}

/// The version `flycockpit/tap/wsmp` installs now, from the local tap
/// (`brew info --json=v2`; no refresh of its own).
pub fn tap_version(keg: &Keg) -> Result<String> {
    let (ok, json, errors) = super::deadman::run_bounded_split(
        brew(keg),
        &["info", "--json=v2", FORMULA],
        &[("HOMEBREW_NO_AUTO_UPDATE", "1".into())],
        INFO_TIMEOUT,
    )
    .with_context(|| format!("running `brew info {FORMULA}`"))?;
    anyhow::ensure!(
        ok,
        "`brew info {FORMULA}` failed: {}",
        format!("{json}{errors}").trim()
    );
    formula_version(&json)
        .with_context(|| format!("`brew info {FORMULA}` did not name a release version"))
}

/// `formulae[0].versions.stable` of `brew info --json=v2` for wsmp, when it is
/// a release version.
pub fn formula_version(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let formula = value.get("formulae")?.as_array()?.first()?;
    if formula.get("name")?.as_str()? != "wsmp" {
        return None;
    }
    let version = formula.get("versions")?.get("stable")?.as_str()?;
    crate::protocol::frames::is_release_version(version).then(|| version.to_string())
}

/// Why the tap cannot install `requested` (it has `available`; this node runs
/// `current`), or nothing when they are the same version. The advice follows the
/// direction: a tap ahead of the server's version means upgrading the server
/// (or installing the tap's version anyway); a tap behind it does not have that
/// version yet.
pub fn version_refusal(available: &str, requested: &str, current: &str) -> Option<String> {
    if available == requested {
        return None;
    }
    let newer = |a: &str, b: &str| compare_release(a, b) == Some(std::cmp::Ordering::Greater);
    let anyway = format!(
        "install {available} anyway (Install anyway on the node's page, or `brew upgrade {FORMULA}` on the node)"
    );
    Some(if newer(available, requested) {
        format!(
            "the Homebrew tap `{TAP}` has wsmp {available}, newer than {requested}; wsmp was not upgraded. Upgrade the server to wsmp {available}, or {anyway}"
        )
    } else if newer(available, current) {
        format!(
            "the Homebrew tap `{TAP}` does not have wsmp {requested} yet (it has {available}); wsmp was not upgraded. Update again once it has {requested}, or {anyway}"
        )
    } else {
        format!(
            "the Homebrew tap `{TAP}` does not have wsmp {requested} yet (it has {available}); wsmp was not upgraded. Update again once it has {requested}"
        )
    })
}

/// SemVer precedence of two release versions (build metadata ignored), or
/// nothing when either is not one. Numeric identifiers of any length compare
/// as numbers.
pub fn compare_release(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    fn parts(version: &str) -> Option<(Vec<&str>, Vec<&str>)> {
        if !crate::protocol::frames::is_release_version(version) {
            return None;
        }
        let version = version.split('+').next()?;
        let (core, pre) = match version.split_once('-') {
            Some((core, pre)) => (core, pre.split('.').collect()),
            None => (version, Vec::new()),
        };
        let core: Vec<&str> = core.split('.').collect();
        (core.len() == 3 && core.iter().all(|part| numeric(part))).then_some((core, pre))
    }
    fn numeric(part: &str) -> bool {
        !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
    }
    fn number(a: &str, b: &str) -> Ordering {
        let a = a.trim_start_matches('0');
        let b = b.trim_start_matches('0');
        a.len().cmp(&b.len()).then_with(|| a.cmp(b))
    }
    let (left_core, left_pre) = parts(a)?;
    let (right_core, right_pre) = parts(b)?;
    for (x, y) in left_core.iter().zip(&right_core) {
        let order = number(x, y);
        if order != Ordering::Equal {
            return Some(order);
        }
    }
    // A pre-release sorts before its release.
    match (left_pre.is_empty(), right_pre.is_empty()) {
        (true, true) => return Some(Ordering::Equal),
        (true, false) => return Some(Ordering::Greater),
        (false, true) => return Some(Ordering::Less),
        (false, false) => {}
    }
    for (x, y) in left_pre.iter().zip(&right_pre) {
        let order = match (numeric(x), numeric(y)) {
            (true, true) => number(x, y),
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => x.cmp(y),
        };
        if order != Ordering::Equal {
            return Some(order);
        }
    }
    Some(left_pre.len().cmp(&right_pre.len()))
}

/// `brew --prefix`: where Homebrew keeps its locks (`var/homebrew/locks`).
/// The path is the output exactly ([`prefix_from_output`]): the lock is the
/// file `brew` itself takes, never one at a path trimmed differently.
pub fn prefix(keg: &Keg) -> Result<PathBuf> {
    let ran = super::deadman::run_bounded_bytes(
        brew(keg),
        &["--prefix"],
        &[("HOMEBREW_NO_AUTO_UPDATE", "1".into())],
        PREFIX_TIMEOUT,
    )
    .context("running `brew --prefix`")?;
    anyhow::ensure!(
        ran.code == Some(0),
        "`brew --prefix` failed: {}",
        String::from_utf8_lossy(&ran.stderr).trim()
    );
    prefix_from_output(&ran.stdout)
}

/// What `brew --prefix` printed, as a path: one line, its terminator (`\n`,
/// or `\r\n`) taken off and nothing else, so a prefix that ends in a space
/// keeps it. Output that is not UTF-8, empty, more than one line, without
/// its terminator (cut short) or not an absolute path is refused: such a
/// prefix cannot be told apart from another one.
pub fn prefix_from_output(out: &[u8]) -> Result<PathBuf> {
    let text = std::str::from_utf8(out)
        .map_err(|_| anyhow::anyhow!("`brew --prefix` printed something that is not UTF-8"))?;
    let line = text
        .strip_suffix('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .ok_or_else(|| anyhow::anyhow!("`brew --prefix` printed `{text}`, not one line"))?;
    anyhow::ensure!(
        !line.is_empty() && !line.contains(['\n', '\r']),
        "`brew --prefix` printed `{}`, not one line",
        line.escape_debug()
    );
    let prefix = PathBuf::from(line);
    anyhow::ensure!(
        prefix.is_absolute(),
        "`brew --prefix` printed `{line}`, not a directory"
    );
    Ok(prefix)
}

/// Homebrew's own update lock, held: while it is, an ordinary `brew update`
/// (or auto-update) fails at once instead of changing a tap, and has to be
/// run again. Not every change is stopped: see the module documentation for
/// the residuals and the Homebrew source this relies on.
pub struct TapLock {
    #[cfg(unix)]
    _file: nix::fcntl::Flock<std::fs::File>,
}

/// How a try at the [`TapLock`] went.
#[cfg(unix)]
enum Attempt {
    Held(TapLock),
    /// Someone else (a `brew update`) holds it.
    Taken,
    /// The path names another file now, or none: try again at once.
    Replaced,
}

/// How long the [`TapLock`] wait sleeps between tries while it is taken.
#[cfg(unix)]
const LOCK_RETRY: Duration = Duration::from_millis(250);

impl TapLock {
    /// `<prefix>/var/homebrew/locks/update`, as `utils/lock.sh` names it.
    pub fn path(prefix: &Path) -> PathBuf {
        prefix
            .join("var")
            .join("homebrew")
            .join("locks")
            .join("update")
    }

    /// The lock, waiting up to `wait` while another `brew update` holds it;
    /// nothing when it stayed taken. `keep_going` is asked between tries: an
    /// update that may not go on stops waiting.
    ///
    /// What is held is the file the lock path names, and every step of getting
    /// it returns at once, so the wait ends at `wait`:
    /// - opened without blocking and without following a last symlink
    ///   (`O_NONBLOCK | O_NOFOLLOW`, as Homebrew's `lock_file.rb` opens its
    ///   locks), and only a regular file is locked: a FIFO, a symlink, a
    ///   directory or a device there is an error, not a wait;
    /// - after `flock(2)`, the locked file must still be the one the path names
    ///   (same device and inode), else it is let go and taken again: `brew
    ///   cleanup` unlinks lock files it can lock (`cleanup.rb` `cleanup_lockfiles`)
    ///   and the next `brew update` creates a new one, so a lock on the unlinked
    ///   file would exclude nobody (Homebrew's `lock_file.rb:43-59` checks the
    ///   same). Once checked, cleanup cannot unlink it: it only unlinks a file it
    ///   has locked itself.
    /// - a missing locks directory (never made, or removed while empty) is made.
    #[cfg(unix)]
    pub fn acquire(
        prefix: &Path,
        wait: Duration,
        keep_going: &dyn Fn() -> bool,
    ) -> Result<Option<Self>> {
        let path = Self::path(prefix);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("creating `{}`", dir.display()))?;
        }
        let until = std::time::Instant::now() + wait;
        loop {
            let retry_at_once = match Self::try_lock(&path)? {
                Attempt::Held(lock) => return Ok(Some(lock)),
                Attempt::Taken => false,
                Attempt::Replaced => true,
            };
            let now = std::time::Instant::now();
            if now >= until || !keep_going() {
                return Ok(None);
            }
            if !retry_at_once {
                std::thread::sleep(until.saturating_duration_since(now).min(LOCK_RETRY));
            }
        }
    }

    /// One try at the lock, never blocking.
    #[cfg(unix)]
    fn try_lock(path: &Path) -> Result<Attempt> {
        Self::try_lock_with(path, &|| {})
    }

    /// [`Self::try_lock`], running `between` after the open and before the
    /// lock (where `brew cleanup` can unlink the file; tests).
    #[cfg(unix)]
    fn try_lock_with(path: &Path, between: &dyn Fn()) -> Result<Attempt> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

        // Opened as `lock.sh` opens it (`exec 200>file`, for writing), without
        // truncating, without blocking and without following a last symlink.
        let opened = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .custom_flags(nix::libc::O_NONBLOCK | nix::libc::O_NOFOLLOW)
            .open(path);
        let file = match opened {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // No locks directory (yet, or any more): make it and try again.
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)
                        .with_context(|| format!("creating `{}`", dir.display()))?;
                }
                return Ok(Attempt::Replaced);
            }
            Err(error) if error.raw_os_error() == Some(nix::libc::ELOOP) => {
                anyhow::bail!(
                    "Homebrew's update lock `{}` is a symbolic link; wsmp locks only a regular file there",
                    path.display()
                );
            }
            Err(error) => {
                return Err(
                    anyhow::Error::from(error).context(format!("opening `{}`", path.display()))
                );
            }
        };
        let opened = file
            .metadata()
            .with_context(|| format!("reading `{}`", path.display()))?;
        anyhow::ensure!(
            opened.file_type().is_file(),
            "Homebrew's update lock `{}` is not a regular file",
            path.display()
        );
        between();
        let file = match nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock)
        {
            Ok(file) => file,
            Err((_, nix::errno::Errno::EWOULDBLOCK)) => return Ok(Attempt::Taken),
            Err((_, error)) => {
                return Err(
                    anyhow::Error::from(error).context(format!("locking `{}`", path.display()))
                );
            }
        };
        // Still the file the path names? `brew cleanup` may have unlinked it
        // between the open and the lock.
        match std::fs::symlink_metadata(path) {
            Ok(named) if named.dev() == opened.dev() && named.ino() == opened.ino() => {
                Ok(Attempt::Held(Self { _file: file }))
            }
            Ok(_) => Ok(Attempt::Replaced),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Attempt::Replaced),
            Err(error) => {
                Err(anyhow::Error::from(error).context(format!("reading `{}`", path.display())))
            }
        }
    }

    /// Homebrew runs on macOS and Linux only.
    #[cfg(not(unix))]
    pub fn acquire(
        _prefix: &Path,
        _wait: Duration,
        _keep_going: &dyn Fn() -> bool,
    ) -> Result<Option<Self>> {
        anyhow::bail!("Homebrew updates are not supported on this platform")
    }
}

/// `brew upgrade flycockpit/tap/wsmp` (bounded: [`UPGRADE_TIMEOUT`]), with the
/// old keg kept (`HOMEBREW_NO_INSTALL_CLEANUP`) so the running relay's files
/// stay put. Takes (and lets go of, when brew is done) the [`TapLock`] the last
/// version check ran under, so an ordinary `brew update` cannot change the
/// formula between that check and this install (it fails on the held lock),
/// and `HOMEBREW_NO_AUTO_UPDATE` keeps this one from refreshing. The residuals
/// the lock does not stop are in the module documentation: the caller's
/// version check after the upgrade reports them as a version mismatch while
/// the caller lives; if wsmp dies mid-upgrade, the server's deadline and the
/// version the next start reports do. Its output on failure.
pub fn upgrade(keg: &Keg, _checked_under: TapLock) -> Result<()> {
    let (ok, output) = super::deadman::run_bounded(
        brew(keg),
        &["upgrade", FORMULA],
        &[
            ("HOMEBREW_NO_AUTO_UPDATE", "1".into()),
            ("HOMEBREW_NO_INSTALL_CLEANUP", "1".into()),
        ],
        UPGRADE_TIMEOUT,
    )
    .context("running `brew upgrade`")?;
    anyhow::ensure!(ok, "`brew upgrade {FORMULA}` failed: {}", output.trim());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// F-FB-1 (the review's C9 two-path probe, with the fixed expectation): a Homebrew prefix
    /// whose path is not UTF-8 runs its own `brew` for every call (`list --pinned`, `update`,
    /// `info`, `--prefix`, `upgrade`), exactly as named; the sibling whose name is that path
    /// shown as text (U+FFFD for the invalid byte) never runs.
    #[cfg(unix)]
    #[test]
    fn non_utf8_brew_prefix_never_runs_the_replacement_character_sibling() {
        use std::os::unix::{ffi::OsStringExt, fs::PermissionsExt};
        let root = tempfile::tempdir().expect("root");
        let intended = root
            .path()
            .join(std::ffi::OsString::from_vec(b"brew-\xff".to_vec()));
        let sibling = PathBuf::from(intended.display().to_string());
        assert_ne!(intended, sibling);
        let marker = root.path().join("marker");
        for (prefix, name) in [(&intended, "intended"), (&sibling, "sibling")] {
            std::fs::create_dir_all(prefix.join("bin")).expect("bin");
            let brew = prefix.join("bin/brew");
            std::fs::write(
                &brew,
                format!(
                    "#!/bin/sh\nprintf '%s %s\\n' {name} \"$1\" >> '{marker}'\n\
                     case \"$1\" in\n\
                     info) printf '%s' '{{\"formulae\":[{{\"name\":\"wsmp\",\"versions\":{{\"stable\":\"0.4.3\"}}}}]}}' ;;\n\
                     --prefix) printf '%s\\n' '{root}' ;;\n\
                     esac\n",
                    marker = marker.display(),
                    root = root.path().display(),
                ),
            )
            .expect("brew");
            std::fs::set_permissions(&brew, std::fs::Permissions::from_mode(0o700)).expect("chmod");
        }
        let keg = Keg {
            prefix: intended.clone(),
            dir: intended.join("Cellar/wsmp/0.4.3"),
        };
        std::fs::create_dir_all(&keg.dir).expect("keg");
        std::fs::write(
            keg.dir.join("INSTALL_RECEIPT.json"),
            br#"{"source":{"tap":"flycockpit/tap"}}"#,
        )
        .expect("receipt");
        assert_eq!(refusal(&keg).expect("refusal"), None);
        refresh(&keg).expect("refresh");
        assert_eq!(tap_version(&keg).expect("info"), "0.4.3");
        assert_eq!(prefix(&keg).expect("prefix"), root.path());
        let lock = TapLock::acquire(root.path(), Duration::from_secs(5), &|| true)
            .expect("lock")
            .expect("held");
        upgrade(&keg, lock).expect("upgrade");
        assert_eq!(
            std::fs::read_to_string(&marker).expect("marker"),
            "intended list\nintended update\nintended info\nintended --prefix\nintended upgrade\n"
        );
    }

    #[test]
    fn finds_the_keg_and_its_stable_link() {
        let exe = Path::new("/opt/homebrew/Cellar/wsmp/0.4.2/bin/wsmp");
        let keg = keg_of(exe).expect("keg");
        assert_eq!(keg.prefix, Path::new("/opt/homebrew"));
        assert_eq!(keg.dir, Path::new("/opt/homebrew/Cellar/wsmp/0.4.2"));
        assert_eq!(
            stable_path(exe).as_deref(),
            Some(Path::new("/opt/homebrew/opt/wsmp/bin/wsmp"))
        );
        assert!(keg_of(Path::new("/home/u/.cargo/bin/wsmp")).is_none());
        assert!(keg_of(Path::new("/opt/homebrew/opt/wsmp/bin/wsmp")).is_none());
        assert!(keg_of(Path::new("/opt/homebrew/Cellar/other/1.0/bin/wsmp")).is_none());
        assert!(
            keg_of(Path::new(
                "/home/linuxbrew/.linuxbrew/Cellar/wsmp/0.4.1/bin/wsmp"
            ))
            .is_some()
        );
    }

    #[test]
    fn reads_the_tap_and_the_pins() {
        let dir = tempfile::tempdir().expect("dir");
        let keg = Keg {
            prefix: dir.path().to_path_buf(),
            dir: dir.path().to_path_buf(),
        };
        assert_eq!(tap_of(&keg), None);
        std::fs::write(
            dir.path().join("INSTALL_RECEIPT.json"),
            r#"{"source":{"tap":"FlyCockpit/tap","path":"x"}}"#,
        )
        .expect("write");
        assert_eq!(tap_of(&keg).as_deref(), Some(TAP));
        assert!(pinned_in("node\nwsmp\n"));
        assert!(!pinned_in("wsmpx\nnode\n"));
        assert!(!pinned_in(""));
    }

    #[test]
    fn reads_the_formula_version_from_brew_info() {
        let info = |name: &str, stable: &str| {
            format!(
                r#"{{"formulae":[{{"name":"{name}","versions":{{"stable":"{stable}","head":null}}}}],"casks":[]}}"#
            )
        };
        assert_eq!(
            formula_version(&info("wsmp", "0.4.4")).as_deref(),
            Some("0.4.4")
        );
        assert_eq!(
            formula_version(&info("wsmp", "0.4.4-rc.1")).as_deref(),
            Some("0.4.4-rc.1")
        );
        assert_eq!(formula_version(&info("other", "0.4.4")), None);
        assert_eq!(formula_version(&info("wsmp", "HEAD")), None);
        assert_eq!(formula_version(r#"{"formulae":[]}"#), None);
        assert_eq!(formula_version("Warning: not json"), None);
    }

    #[test]
    fn a_tap_with_another_version_says_both_and_which_way() {
        assert_eq!(version_refusal("0.4.3", "0.4.3", "0.4.2"), None);
        // Ahead of the server: upgrade the server, or install it anyway.
        let why = version_refusal("0.4.4", "0.4.3", "0.4.2").expect("refused");
        assert!(
            why.contains("has wsmp 0.4.4, newer than 0.4.3")
                && why.contains("wsmp was not upgraded")
                && why.contains("Upgrade the server to wsmp 0.4.4")
                && why.contains("install 0.4.4 anyway"),
            "{why}"
        );
        // Behind the server but ahead of the node: never "upgrade the server" to it.
        let why = version_refusal("0.4.2", "0.4.3", "0.4.1").expect("refused");
        assert!(
            why.contains("does not have wsmp 0.4.3 yet (it has 0.4.2)")
                && why.contains("install 0.4.2 anyway")
                && !why.contains("Upgrade the server"),
            "{why}"
        );
        // Behind the server at the node's own version: nothing to install anyway.
        let why = version_refusal("0.4.2", "0.4.3", "0.4.2").expect("refused");
        assert!(
            why.contains("does not have wsmp 0.4.3 yet") && !why.contains("anyway"),
            "{why}"
        );
    }

    /// F-FB-2: the prefix is `brew --prefix`'s line exactly, only its
    /// terminator taken off; anything else is refused.
    #[test]
    fn the_prefix_is_brews_line_exactly() {
        let ok = |out: &[u8]| prefix_from_output(out).expect("prefix");
        assert_eq!(ok(b"/opt/homebrew\n"), PathBuf::from("/opt/homebrew"));
        assert_eq!(ok(b"/opt/homebrew\r\n"), PathBuf::from("/opt/homebrew"));
        assert_eq!(ok(b"/opt/home brew \n"), PathBuf::from("/opt/home brew "));
        assert_eq!(ok(b"/x\t\n"), PathBuf::from("/x\t"));
        for bad in [
            &b""[..],
            b"\n",
            b"\r\n",
            b"/opt/homebrew",
            b"/opt/homebrew\n\n",
            b"/opt/homebrew\n/other\n",
            b"/opt/home\rbrew\n",
            b"/opt/\xffbrew\n",
            b"opt/homebrew\n",
            b" /x\n",
        ] {
            assert!(prefix_from_output(bad).is_err(), "{bad:?}");
        }
    }

    /// F-FB-2 (FB-P1): through the real `brew --prefix` run, a prefix whose
    /// name ends in a space is that directory, and Homebrew's update lock is
    /// taken in it, not in the directory without the space.
    #[cfg(unix)]
    #[test]
    fn a_prefix_ending_in_a_space_keeps_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("dir");
        let prefix = dir.path().join("prefix ");
        std::fs::create_dir_all(prefix.join("bin")).expect("bin");
        let script = prefix.join("bin/brew");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' '{}'\n",
                prefix.to_str().expect("utf-8")
            ),
        )
        .expect("brew");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("mode");
        let keg = Keg {
            prefix: prefix.clone(),
            dir: prefix.clone(),
        };
        let got = super::prefix(&keg).expect("prefix");
        assert_eq!(got, prefix);
        assert_eq!(
            TapLock::path(&got),
            prefix.join("var/homebrew/locks/update")
        );
        assert_ne!(
            TapLock::path(&got),
            dir.path().join("prefix/var/homebrew/locks/update")
        );
    }

    /// F-FB-1: the node orders every pair of the shared vectors exactly as
    /// the server's `compareReleaseVersions` does (it checks the same file).
    #[test]
    fn release_versions_compare_as_the_servers_vectors_say() {
        #[derive(serde::Deserialize)]
        struct Shared {
            comparisons: Vec<(String, String, i8)>,
        }
        let shared: Shared = serde_json::from_str(include_str!(
            "../../../../packages/api/src/lib/agent-release-version-vectors.json"
        ))
        .expect("shared release version vectors");
        assert!(shared.comparisons.len() > 1000);
        for (a, b, order) in shared.comparisons {
            assert_eq!(
                compare_release(&a, &b).map(|o| o as i8),
                Some(order),
                "{a:?} vs {b:?}"
            );
        }
    }

    #[test]
    fn release_versions_compare_by_semver_precedence() {
        use std::cmp::Ordering::{Equal, Greater, Less};
        assert_eq!(compare_release("0.4.4", "0.4.3"), Some(Greater));
        assert_eq!(compare_release("0.4.3", "0.4.10"), Some(Less));
        assert_eq!(compare_release("0.4.3", "0.4.3+abc"), Some(Equal));
        assert_eq!(compare_release("0.4.4-rc.1", "0.4.4"), Some(Less));
        assert_eq!(compare_release("0.4.4-rc.2", "0.4.4-rc.10"), Some(Less));
        assert_eq!(
            compare_release("0.4.4-beta", "0.4.4-alpha.9"),
            Some(Greater)
        );
        assert_eq!(compare_release("0.4.4-rc", "0.4.4-rc.1"), Some(Less));
        assert_eq!(
            compare_release("99999999999999999999.0.0", "99999999999999999998.0.0"),
            Some(Greater)
        );
        assert_eq!(compare_release("HEAD", "0.4.3"), None);
        // The same cases as the server's `compareReleaseVersions` test.
        assert_eq!(compare_release("1.0.0-01.a", "1.0.0-1.b"), Some(Less));
        assert_eq!(compare_release("1.0.0-01.a", "1.0.0-1.a"), Some(Equal));
        assert_eq!(compare_release("1.0.0-01", "1.0.0-1.a"), Some(Less));
    }

    #[cfg(unix)]
    #[test]
    fn the_tap_lock_is_homebrews_update_lock_and_excludes_another_holder() {
        let dir = tempfile::tempdir().expect("dir");
        assert_eq!(
            TapLock::path(dir.path()),
            dir.path().join("var/homebrew/locks/update")
        );
        let held = TapLock::acquire(dir.path(), Duration::ZERO, &|| true)
            .expect("lock")
            .expect("free");
        // Another holder (a `brew update`: `flock(2)` on the same file) is refused.
        let other = std::fs::OpenOptions::new()
            .write(true)
            .open(TapLock::path(dir.path()))
            .expect("open");
        assert!(matches!(
            nix::fcntl::Flock::lock(other, nix::fcntl::FlockArg::LockExclusiveNonblock),
            Err((_, nix::errno::Errno::EWOULDBLOCK))
        ));
        assert!(
            TapLock::acquire(dir.path(), Duration::from_millis(300), &|| true)
                .expect("lock")
                .is_none(),
            "taken: waits, then gives up"
        );
        drop(held);
        assert!(
            TapLock::acquire(dir.path(), Duration::ZERO, &|| true)
                .expect("lock")
                .is_some()
        );
    }

    /// A file the lock path names, locked by "another process" (a second open
    /// file description) the way `brew update` and `brew cleanup` lock it.
    #[cfg(unix)]
    fn lock_as_brew(path: &Path) -> nix::fcntl::Flock<std::fs::File> {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .expect("open");
        nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock)
            .map_err(|(_, error)| error)
            .expect("lock")
    }

    #[cfg(unix)]
    #[test]
    fn the_tap_lock_holds_the_file_the_path_names_after_brew_cleanup_unlinks_it() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().expect("dir");
        let path = TapLock::path(dir.path());
        std::fs::create_dir_all(path.parent().expect("parent")).expect("locks dir");
        // The interleaving `brew cleanup` makes possible: wsmp has the old file
        // open; cleanup locks it, unlinks it and lets go; the next `brew update`
        // creates and locks a new one. Here: the old file is unlinked and a new
        // one at the path is held by "brew update".
        let old = std::fs::File::create(&path).expect("old");
        let old_inode = old.metadata().expect("meta").ino();
        std::fs::remove_file(&path).expect("cleanup unlinks it");
        let updater = lock_as_brew(&path);
        let new_inode = std::fs::metadata(&path).expect("meta").ino();
        assert_ne!(old_inode, new_inode);
        // A lock on the unlinked file would exclude nobody; the new one is taken,
        // so wsmp waits (and gives up), it does not "hold" the stale file.
        drop(old);
        assert!(
            TapLock::acquire(dir.path(), Duration::from_millis(300), &|| true)
                .expect("lock")
                .is_none(),
            "the file the path names is taken"
        );
        drop(updater);
        let held = TapLock::acquire(dir.path(), Duration::ZERO, &|| true)
            .expect("lock")
            .expect("free");
        // And it is the one the path names: `brew update` is excluded.
        let other = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open");
        assert!(matches!(
            nix::fcntl::Flock::lock(other, nix::fcntl::FlockArg::LockExclusiveNonblock),
            Err((_, nix::errno::Errno::EWOULDBLOCK))
        ));
        drop(held);
    }

    #[cfg(unix)]
    #[test]
    fn the_tap_lock_retries_when_cleanup_unlinks_the_file_between_open_and_lock() {
        let dir = tempfile::tempdir().expect("dir");
        let path = TapLock::path(dir.path());
        std::fs::create_dir_all(path.parent().expect("parent")).expect("locks dir");
        // Each try opens the file; between the open and the lock "cleanup"
        // unlinks it (on the first try only): the first try must come back
        // `Replaced`, the second hold the file the path names.
        let unlinked = std::cell::Cell::new(false);
        let between = || {
            if !unlinked.replace(true) {
                std::fs::remove_file(&path).expect("cleanup unlinks it");
            }
        };
        assert!(matches!(
            TapLock::try_lock_with(&path, &between).expect("try"),
            Attempt::Replaced
        ));
        assert!(
            !path.exists(),
            "the stale file is not recreated by that try"
        );
        let Attempt::Held(held) = TapLock::try_lock_with(&path, &between).expect("try") else {
            panic!("the second try holds the lock");
        };
        // A `brew update` now (a new open of the path) is excluded.
        let other = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open");
        assert!(matches!(
            nix::fcntl::Flock::lock(other, nix::fcntl::FlockArg::LockExclusiveNonblock),
            Err((_, nix::errno::Errno::EWOULDBLOCK))
        ));
        drop(held);
    }

    #[cfg(unix)]
    #[test]
    fn the_tap_lock_never_blocks_on_what_is_not_a_regular_file() {
        use std::os::unix::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().expect("dir");
        let path = TapLock::path(dir.path());
        let locks = path.parent().expect("parent").to_path_buf();
        std::fs::create_dir_all(&locks).expect("locks dir");
        let timed = |what: &str| {
            let started = std::time::Instant::now();
            let result = TapLock::acquire(dir.path(), Duration::from_millis(300), &|| true);
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "{what}: returned in {:?}",
                started.elapsed()
            );
            result
        };
        // A FIFO with no reader: a blocking open would never return.
        nix::unistd::mkfifo(&path, nix::sys::stat::Mode::S_IRWXU).expect("fifo");
        let error = timed("fifo").err().expect("a FIFO is an error");
        assert!(format!("{error:#}").contains("opening"), "{error:#}");
        // A FIFO someone reads: it opens, and is still not a lock file.
        let reader = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NONBLOCK)
            .open(&path)
            .expect("reader");
        let error = timed("read fifo").err().expect("a FIFO is an error");
        assert!(
            format!("{error:#}").contains("not a regular file"),
            "{error:#}"
        );
        drop(reader);
        std::fs::remove_file(&path).expect("rm fifo");
        // A symlink (even to a regular file) is not followed.
        let target = dir.path().join("elsewhere");
        std::fs::write(&target, "").expect("target");
        std::os::unix::fs::symlink(&target, &path).expect("symlink");
        let error = timed("symlink").err().expect("a symlink is an error");
        assert!(format!("{error:#}").contains("symbolic link"), "{error:#}");
        std::fs::remove_file(&path).expect("rm symlink");
        // A directory.
        std::fs::create_dir(&path).expect("dir");
        assert!(timed("directory").is_err());
        std::fs::remove_dir(&path).expect("rm dir");
        // No locks directory at all: made, and the lock taken.
        std::fs::remove_dir_all(&locks).expect("rm locks");
        assert!(timed("missing dir").expect("lock").is_some());
        assert!(path.is_file());
    }
}
