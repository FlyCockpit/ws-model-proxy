//! The config file on disk: the advisory lock every local mutation holds,
//! loading, and the private, synced atomic save.

use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
#[cfg(unix)]
use nix::fcntl::{Flock, FlockArg};
use tempfile::NamedTempFile;

use super::{Config, Setting};

/// A short-lived advisory lock shared by every local config mutation.  The
/// daemon still owns the future control-plane mutation API; this is the
/// transitional guard that prevents a standalone command from overwriting a
/// concurrent reload/probe write. Saving the config file takes it
/// ([`ConfigLock::save`]).
#[cfg(unix)]
pub struct ConfigLock {
    // Keeping the RAII guard alive holds the advisory lock for the critical
    // section; the field is intentionally otherwise unused.
    _guard: Flock<std::fs::File>,
}

#[cfg(windows)]
pub struct ConfigLock {
    _file: std::fs::File,
}

#[cfg(not(any(unix, windows)))]
pub struct ConfigLock;

impl ConfigLock {
    pub fn exclusive() -> Result<Self> {
        let config = crate::paths::config_file()?;
        let directory = config
            .parent()
            .context("config path has no parent directory")?;
        std::fs::create_dir_all(directory)
            .with_context(|| format!("creating config directory `{}`", directory.display()))?;
        create_private_dir(directory)?;
        #[cfg(unix)]
        {
            let lock_path = config.with_extension("json.lock");
            let file = std::fs::OpenOptions::new()
                .create(true)
                // Lock files are persistent coordination points. Preserve any
                // existing inode/content rather than truncating on each lock.
                .truncate(false)
                .read(true)
                .write(true)
                .open(&lock_path)
                .with_context(|| format!("opening config lock `{}`", lock_path.display()))?;
            let lock = Flock::lock(file, FlockArg::LockExclusive)
                .map_err(|(_, error)| anyhow::anyhow!(error))
                .with_context(|| format!("locking config `{}`", config.display()))?;
            Ok(Self { _guard: lock })
        }
        #[cfg(windows)]
        {
            Self::exclusive_at(
                &config.with_extension("json.lock"),
                std::time::Duration::from_secs(10),
            )
        }
        #[cfg(not(any(unix, windows)))]
        {
            Ok(Self)
        }
    }

    /// Save `config` as the config file: only while holding this lock, so
    /// no other local change lands between its read and this write.
    pub fn save(&self, config: &Config) -> Result<()> {
        let path = crate::paths::config_file()?;
        config.save_to_path(path)
    }

    /// Record `setting` in the config file: one read-modify-write under this
    /// lock (a missing file starts from the defaults).
    pub fn save_setting(setting: Setting) -> Result<()> {
        let lock = Self::exclusive()?;
        let mut config = Config::load()?;
        config.apply(setting);
        lock.save(&config)
    }

    /// Save `config` as the config file unless one exists. Returns whether
    /// it was written.
    pub fn save_new(&self, config: &Config) -> Result<bool> {
        let path = crate::paths::config_file()?;
        if path
            .try_exists()
            .with_context(|| format!("checking whether config file `{}` exists", path.display()))?
        {
            return Ok(false);
        }
        config.save_to_path(path)?;
        Ok(true)
    }
}

#[cfg(windows)]
impl ConfigLock {
    fn try_exclusive_at(path: &std::path::Path) -> Result<Option<Self>> {
        use std::os::windows::fs::OpenOptionsExt;
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(path)
        {
            Ok(file) => Ok(Some(Self { _file: file })),
            // ERROR_SHARING_VIOLATION: another process owns this lock.
            Err(error) if error.raw_os_error() == Some(32) => Ok(None),
            Err(error) => Err(error).context("opening config lock"),
        }
    }

    fn exclusive_at(path: &std::path::Path, wait: std::time::Duration) -> Result<Self> {
        let deadline = std::time::Instant::now() + wait;
        loop {
            if let Some(lock) = Self::try_exclusive_at(path)? {
                return Ok(lock);
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            anyhow::ensure!(!remaining.is_zero(), "config is busy; try again shortly");
            std::thread::sleep(remaining.min(std::time::Duration::from_millis(50)));
        }
    }
}

#[cfg(all(windows, test))]
mod windows_config_lock_tests {
    use super::ConfigLock;

    #[test]
    fn windows_config_lock_excludes_other_handles_and_releases_on_drop() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.json.lock");
        let lock = ConfigLock::try_exclusive_at(&path)
            .expect("open")
            .expect("lock");
        let other = path.clone();
        std::thread::spawn(move || {
            assert!(
                ConfigLock::try_exclusive_at(&other)
                    .expect("try lock")
                    .is_none()
            );
            assert!(
                ConfigLock::exclusive_at(&other, std::time::Duration::from_millis(10)).is_err()
            );
        })
        .join()
        .expect("thread");
        drop(lock);
        assert!(
            ConfigLock::try_exclusive_at(&path)
                .expect("retry")
                .is_some()
        );
    }
}

impl Config {
    pub fn load() -> Result<Self> {
        Self::load_from_path(&crate::paths::config_file()?)
    }

    pub fn load_required() -> Result<Self> {
        let path = crate::paths::config_file()?;
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)
                .with_context(|| format!("parsing config file `{}`", path.display())),
            Err(err) if err.kind() == ErrorKind::NotFound => {
                anyhow::bail!(
                    "config file `{}` does not exist; run `wsmp config init`",
                    path.display()
                )
            }
            Err(err) => {
                Err(err).with_context(|| format!("reading config file `{}`", path.display()))
            }
        }
    }

    pub(super) fn load_from_path(path: &Path) -> Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text)
                .with_context(|| format!("parsing config file `{}`", path.display())),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(Self::default()),
            Err(err) => {
                Err(err).with_context(|| format!("reading config file `{}`", path.display()))
            }
        }
    }

    pub(super) fn save_to_path(&self, path: PathBuf) -> Result<()> {
        let dir = path
            .parent()
            .map(Path::to_path_buf)
            .context("config path has no parent directory")?;
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("creating config directory `{}`", dir.display()))?;
        create_private_dir(&dir)?;
        let text = serde_json::to_string_pretty(self).context("serializing config")?;
        let mut file = NamedTempFile::new_in(&dir)
            .with_context(|| format!("creating temporary config file in `{}`", dir.display()))?;
        file.write_all(text.as_bytes())
            .with_context(|| format!("writing temporary config file for `{}`", path.display()))?;
        file.write_all(b"\n")
            .with_context(|| format!("writing temporary config file for `{}`", path.display()))?;
        file.as_file()
            .sync_all()
            .with_context(|| format!("syncing temporary config file for `{}`", path.display()))?;
        file.persist(&path)
            .map_err(|err| err.error)
            .with_context(|| format!("moving temporary config file to `{}`", path.display()))?;
        sync_parent_dir(&path)?;
        Ok(())
    }
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = std::fs::metadata(dir)
        .with_context(|| format!("reading metadata for `{}`", dir.display()))?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(dir, permissions)
        .with_context(|| format!("setting private permissions on `{}`", dir.display()))
}

#[cfg(not(unix))]
fn create_private_dir(_dir: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_parent_dir(path: &Path) -> Result<()> {
    let Some(dir) = path.parent() else {
        return Ok(());
    };
    std::fs::File::open(dir)
        .and_then(|dir_file| dir_file.sync_all())
        .with_context(|| format!("syncing config directory `{}`", dir.display()))
}

#[cfg(not(unix))]
fn sync_parent_dir(_path: &Path) -> Result<()> {
    Ok(())
}
