//! The self-replace mechanics: download, verify, unpack, test-run, and the
//! file moves of the swap and of a rollback.
//!
//! Everything happens beside the live binary, on its filesystem, so every
//! move is a rename (never `/tmp`: often tmpfs, and cleared at boot).
//!
//! - Unix: the rollback copy `wsmp.prev` is a hard link to the live binary,
//!   made before the state that names it; the swap is one atomic rename of
//!   `wsmp.new` over `wsmp`, so `wsmp` always exists. A rollback links the
//!   failed build to `wsmp.failed` and renames `wsmp.prev` over `wsmp`.
//! - Windows cannot replace a running `.exe` but can rename it: the rollback
//!   copy is a copy, and the swap renames `wsmp.exe` aside, then
//!   `wsmp.new.exe` to `wsmp.exe` (moving it back if that fails).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

/// Release archives are a few MiB; anything this large is not one.
pub const ARCHIVE_MAX_BYTES: u64 = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

fn exe_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// The files of one update, all in the live binary's directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub live: PathBuf,
    pub new: PathBuf,
    pub prev: PathBuf,
    pub failed: PathBuf,
    /// Downloads and unpacks here (`.wsmp-update-<id>`), then removed.
    pub staging: PathBuf,
    /// Windows: where the swap renames the running binary.
    pub retired: PathBuf,
}

impl Layout {
    pub fn beside(live: &Path, update_id: &str) -> Result<Self> {
        let dir = live
            .parent()
            .context("the wsmp binary has no parent directory")?;
        Ok(Self {
            live: live.to_path_buf(),
            new: dir.join(exe_name("wsmp.new")),
            prev: dir.join(exe_name("wsmp.prev")),
            failed: dir.join(exe_name("wsmp.failed")),
            staging: dir.join(format!(".wsmp-update-{update_id}")),
            retired: dir.join(exe_name(&format!(".wsmp-retired-{update_id}"))),
        })
    }
}

/// Download `url` to `dest`, at most [`ARCHIVE_MAX_BYTES`]. Redirects are
/// followed (release assets redirect to a CDN); from an https URL never to
/// plain http.
pub fn download(url: &str, dest: &Path) -> Result<()> {
    let https = url.starts_with("https://");
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(DOWNLOAD_TIMEOUT))
        .max_redirects(5)
        .https_only(https)
        .build()
        .into();
    let mut response = agent
        .get(url)
        .call()
        .with_context(|| format!("downloading `{url}`"))?;
    let mut reader = response
        .body_mut()
        .with_config()
        .limit(ARCHIVE_MAX_BYTES + 1)
        .reader()
        .take(ARCHIVE_MAX_BYTES + 1);
    let mut file =
        std::fs::File::create(dest).with_context(|| format!("creating `{}`", dest.display()))?;
    let copied =
        std::io::copy(&mut reader, &mut file).with_context(|| format!("downloading `{url}`"))?;
    anyhow::ensure!(
        copied <= ARCHIVE_MAX_BYTES,
        "`{url}` is larger than {ARCHIVE_MAX_BYTES} bytes"
    );
    file.sync_all()
        .with_context(|| format!("syncing `{}`", dest.display()))?;
    Ok(())
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        std::fs::File::open(path).with_context(|| format!("opening `{}`", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("reading `{}`", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Public keys an update signature must match (D9, deferred). Empty: this
/// build verifies no signature, and the reserved `signature` field is ignored.
/// Once keys are listed here, an update without a valid signature is refused.
pub const SIGNING_KEYS: &[&str] = &[];

/// The reserved signature step (D9): a no-op while [`SIGNING_KEYS`] is empty.
pub fn verify_signature(signature: Option<&str>, _archive: &Path) -> Result<(), &'static str> {
    if SIGNING_KEYS.is_empty() {
        let _ = signature;
        return Ok(());
    }
    Err("this build cannot verify update signatures yet")
}

/// The system `tar` (bsdtar on macOS and Windows reads `.zip` too).
pub fn system_tar() -> PathBuf {
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        PathBuf::from(root).join("System32").join("tar.exe")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("tar")
    }
}

/// Unpack `archive` into the empty directory `into` with `tar`, and find the
/// `wsmp` binary: at the top or in `wsmp-<target>/` (as the release archives
/// lay it out), a regular file (never a link).
pub fn extract(tar: &Path, archive: &Path, into: &Path, target: &str) -> Result<PathBuf> {
    std::fs::create_dir_all(into).with_context(|| format!("creating `{}`", into.display()))?;
    let (ok, output) = super::deadman::run_bounded(
        &tar.display().to_string(),
        &[
            "-xf".into(),
            archive.display().to_string(),
            "-C".into(),
            into.display().to_string(),
        ],
        &[],
        Duration::from_secs(120),
    )?;
    anyhow::ensure!(ok, "could not unpack the update archive: {}", output.trim());
    let name = exe_name("wsmp");
    for candidate in [
        into.join(&name),
        into.join(format!("wsmp-{target}")).join(&name),
    ] {
        if let Ok(meta) = std::fs::symlink_metadata(&candidate)
            && meta.file_type().is_file()
        {
            return Ok(candidate);
        }
    }
    anyhow::bail!("the update archive does not contain `{name}` or `wsmp-{target}/{name}`")
}

/// Run `binary --version` (bounded) and return the version it prints after
/// `wsmp `.
pub fn probe_version(binary: &Path) -> Result<String> {
    let (ok, output) = super::deadman::run_bounded(
        &binary.display().to_string(),
        &["--version".into()],
        &[],
        VERSION_PROBE_TIMEOUT,
    )
    .context("the new build does not run on this machine")?;
    anyhow::ensure!(
        ok,
        "the new build does not run on this machine: {}",
        super::clip_detail(&output)
    );
    output
        .lines()
        .next()
        .and_then(|line| line.trim().strip_prefix("wsmp "))
        .map(|version| version.trim().to_string())
        .with_context(|| format!("the new build printed `{}` for `--version`", output.trim()))
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .with_context(|| format!("setting permissions on `{}`", path.display()))
}

/// Move the verified binary to `wsmp.new`.
pub fn stage_new(found: &Path, layout: &Layout) -> Result<()> {
    remove_if_present(&layout.new)?;
    std::fs::rename(found, &layout.new)
        .with_context(|| format!("moving the new build to `{}`", layout.new.display()))?;
    #[cfg(unix)]
    make_executable(&layout.new)?;
    sync_dir(&layout.new);
    Ok(())
}

fn remove_if_present(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("removing `{}`", path.display())),
    }
}

/// Make room at `path`: remove it, or (Windows, a file still running) move it
/// aside under a unique name.
fn clear(path: &Path) -> Result<()> {
    match remove_if_present(path) {
        Ok(()) => Ok(()),
        Err(error) if cfg!(windows) => {
            let aside = path.with_extension(format!("old-{}", super::new_update_id()));
            std::fs::rename(path, &aside).map_err(|_| error)
        }
        Err(error) => Err(error),
    }
}

fn sync_dir(path: &Path) {
    #[cfg(unix)]
    if let Some(dir) = path.parent()
        && let Ok(dir) = std::fs::File::open(dir)
    {
        let _ = dir.sync_all();
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Write the rollback copy (before the state that names it).
pub fn prepare_prev(layout: &Layout) -> Result<()> {
    clear(&layout.prev)?;
    #[cfg(unix)]
    {
        if std::fs::hard_link(&layout.live, &layout.prev).is_err() {
            copy_file(&layout.live, &layout.prev)?;
        }
    }
    #[cfg(not(unix))]
    copy_file(&layout.live, &layout.prev)?;
    sync_dir(&layout.prev);
    Ok(())
}

fn copy_file(from: &Path, to: &Path) -> Result<()> {
    let mut source =
        std::fs::File::open(from).with_context(|| format!("opening `{}`", from.display()))?;
    let mut dest =
        std::fs::File::create(to).with_context(|| format!("creating `{}`", to.display()))?;
    std::io::copy(&mut source, &mut dest)
        .with_context(|| format!("copying `{}` to `{}`", from.display(), to.display()))?;
    dest.flush()?;
    dest.sync_all()?;
    #[cfg(unix)]
    make_executable(to)?;
    Ok(())
}

/// Put `wsmp.new` in place of the live binary.
pub fn swap(layout: &Layout) -> Result<()> {
    #[cfg(unix)]
    {
        std::fs::rename(&layout.new, &layout.live).with_context(|| {
            format!(
                "moving `{}` over `{}`",
                layout.new.display(),
                layout.live.display()
            )
        })?;
    }
    #[cfg(not(unix))]
    {
        clear(&layout.retired)?;
        std::fs::rename(&layout.live, &layout.retired)
            .with_context(|| format!("moving `{}` aside", layout.live.display()))?;
        if let Err(error) = std::fs::rename(&layout.new, &layout.live) {
            let _ = std::fs::rename(&layout.retired, &layout.live);
            return Err(error)
                .with_context(|| format!("moving the new build to `{}`", layout.live.display()));
        }
    }
    sync_dir(&layout.live);
    Ok(())
}

/// Roll back: the live (failed) build to `wsmp.failed`, the rollback copy
/// back to the live path. `false` when there is no rollback copy.
pub fn restore(layout: &Layout) -> Result<bool> {
    if std::fs::symlink_metadata(&layout.prev).is_err() {
        return Ok(false);
    }
    clear(&layout.failed)?;
    #[cfg(unix)]
    {
        if layout.live.exists() && std::fs::hard_link(&layout.live, &layout.failed).is_err() {
            let _ = copy_file(&layout.live, &layout.failed);
        }
    }
    #[cfg(not(unix))]
    {
        if layout.live.exists() {
            std::fs::rename(&layout.live, &layout.failed)
                .with_context(|| format!("moving `{}` aside", layout.live.display()))?;
        }
    }
    std::fs::rename(&layout.prev, &layout.live).with_context(|| {
        format!(
            "moving `{}` back to `{}`",
            layout.prev.display(),
            layout.live.display()
        )
    })?;
    sync_dir(&layout.live);
    Ok(true)
}

/// Remove what an update left that nothing needs: the staging directory, a
/// `wsmp.new` that was never swapped in, and (Windows) retired binaries no
/// longer running.
pub fn clean(layout: &Layout) {
    let _ = std::fs::remove_dir_all(&layout.staging);
    let _ = std::fs::remove_file(&layout.new);
    let _ = std::fs::remove_file(&layout.retired);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn write_exe(path: &Path, body: &str) {
        std::fs::write(path, body).expect("write");
        #[cfg(unix)]
        make_executable(path).expect("chmod");
    }

    #[test]
    fn hashes_files() {
        let dir = tempfile::tempdir().expect("dir");
        let file = dir.path().join("a");
        std::fs::write(&file, b"abc").expect("write");
        assert_eq!(
            sha256_file(&file).expect("hash"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn the_signature_step_is_reserved() {
        let dir = tempfile::tempdir().expect("dir");
        assert!(verify_signature(None, dir.path()).is_ok());
        assert!(verify_signature(Some("anything"), dir.path()).is_ok());
    }

    #[test]
    fn the_layout_stays_beside_the_live_binary() {
        let layout = Layout::beside(Path::new("/home/u/.cargo/bin/wsmp"), "id").expect("layout");
        assert_eq!(
            layout.staging,
            Path::new("/home/u/.cargo/bin/.wsmp-update-id")
        );
        assert_eq!(layout.new.parent(), layout.live.parent());
        assert_eq!(layout.prev.parent(), layout.live.parent());
    }

    #[cfg(unix)]
    #[test]
    fn swap_and_restore_keep_a_live_binary_and_the_rollback_copy() {
        let dir = tempfile::tempdir().expect("dir");
        let live = dir.path().join("wsmp");
        write_exe(&live, "old");
        let layout = Layout::beside(&live, "id").expect("layout");
        write_exe(&layout.new, "new");
        prepare_prev(&layout).expect("prev");
        assert_eq!(std::fs::read_to_string(&layout.prev).expect("prev"), "old");
        swap(&layout).expect("swap");
        assert_eq!(std::fs::read_to_string(&live).expect("live"), "new");
        assert_eq!(std::fs::read_to_string(&layout.prev).expect("prev"), "old");
        assert!(!layout.new.exists());
        assert!(restore(&layout).expect("restore"));
        assert_eq!(std::fs::read_to_string(&live).expect("live"), "old");
        assert_eq!(
            std::fs::read_to_string(&layout.failed).expect("failed"),
            "new"
        );
        assert!(!layout.prev.exists());
        // Nothing to roll back to a second time.
        assert!(!restore(&layout).expect("restore again"));
        assert_eq!(std::fs::read_to_string(&live).expect("live"), "old");
    }

    #[cfg(unix)]
    #[test]
    fn unpacks_release_archives_and_probes_the_version() {
        let dir = tempfile::tempdir().expect("dir");
        let src = dir.path().join("src");
        let inner = src.join("wsmp-x86_64-unknown-linux-gnu");
        std::fs::create_dir_all(&inner).expect("mkdir");
        write_exe(&inner.join("wsmp"), "#!/bin/sh\necho 'wsmp 9.8.7'\n");
        let archive = dir.path().join("a.tar.gz");
        let status = std::process::Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(&src)
            .arg("wsmp-x86_64-unknown-linux-gnu")
            .status()
            .expect("tar");
        assert!(status.success());
        let found = extract(
            &system_tar(),
            &archive,
            &dir.path().join("out"),
            "x86_64-unknown-linux-gnu",
        )
        .expect("extract");
        assert_eq!(probe_version(&found).expect("probe"), "9.8.7");
        assert!(
            extract(
                &system_tar(),
                &archive,
                &dir.path().join("other"),
                "aarch64-apple-darwin"
            )
            .is_err()
        );
        let broken = dir.path().join("broken");
        write_exe(&broken, "#!/bin/sh\nexit 3\n");
        assert!(probe_version(&broken).is_err());
    }
}
