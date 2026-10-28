//! The Homebrew strategy (D10): `brew upgrade flycockpit/tap/wsmp`, only for an
//! unpinned install from `flycockpit/tap`. No dead-man and no rollback: the
//! server's deadline marks an update that never confirms.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};

pub const FORMULA: &str = "flycockpit/tap/wsmp";
pub const TAP: &str = "flycockpit/tap";
/// What a person runs when Homebrew cannot update wsmp by itself.
pub const MANUAL_COMMAND: &str = "brew reinstall flycockpit/tap/wsmp && wsmp service restart";

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
        &brew(keg).display().to_string(),
        &["list".into(), "--pinned".into()],
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

/// `brew upgrade flycockpit/tap/wsmp`, with the tap refreshed
/// (`HOMEBREW_NO_AUTO_UPDATE` unset) and the old keg kept
/// (`HOMEBREW_NO_INSTALL_CLEANUP`) so the running relay's files stay put.
/// Its output on failure.
pub fn upgrade(keg: &Keg) -> Result<()> {
    use std::process::{Command, Stdio};
    let output = Command::new(brew(keg))
        .args(["upgrade", FORMULA])
        .env_remove("HOMEBREW_NO_AUTO_UPDATE")
        .env("HOMEBREW_NO_INSTALL_CLEANUP", "1")
        .stdin(Stdio::null())
        .output()
        .context("running `brew upgrade`")?;
    anyhow::ensure!(
        output.status.success(),
        "`brew upgrade {FORMULA}` failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
