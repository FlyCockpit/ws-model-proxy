//! Durable index of live `.wsmp-recover-*` directories in the CLI state
//! directory. Startup reads this instead of walking file roots.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::intent::{Intent, IntentSummary};

const REGISTRY_DIR_NAME: &str = "file-recovery";
const ENTRY_MAX_BYTES: usize = 64 * 1024;

#[cfg(test)]
thread_local! {
    static OVERRIDE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub path: String,
    pub path_bytes: String,
    pub summary: IntentSummary,
}

impl RegistryEntry {
    pub fn from_intent(recovery: &Path, intent: &Intent) -> Self {
        Self {
            path: recovery.to_string_lossy().into_owned(),
            path_bytes: super::intent::IntentPath::from_path(recovery).bytes,
            summary: intent.summary(),
        }
    }

    pub fn recovery_path(&self) -> PathBuf {
        super::intent::IntentPath {
            display: self.path.clone(),
            bytes: self.path_bytes.clone(),
        }
        .to_path()
        .unwrap_or_else(|| PathBuf::from(&self.path))
    }
}

pub fn register(recovery: &Path, intent: &Intent) -> Result<(), String> {
    let dir = registry_dir()?;
    create_dir_synced(&dir)?;
    let path = entry_path(&dir, recovery);
    let body = serde_json::to_vec_pretty(&RegistryEntry::from_intent(recovery, intent))
        .map_err(|err| format!("registry serialize: {err}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .map_err(|err| format!("registry create: {err}"))?;
    file.write_all(&body)
        .and_then(|()| file.write_all(b"\n"))
        .and_then(|()| file.sync_all())
        .map_err(|err| format!("registry write: {err}"))?;
    sync_dir(&dir);
    Ok(())
}

pub fn unregister(recovery: &Path) {
    let Ok(dir) = registry_dir() else {
        return;
    };
    let path = entry_path(&dir, recovery);
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => tracing::warn!(
            recovery = %recovery.display(),
            error = %err,
            "could not remove file-recovery registry entry"
        ),
    }
}

pub fn list_entries() -> Vec<RegistryEntry> {
    let Ok(dir) = registry_dir() else {
        return Vec::new();
    };
    let Ok(read) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    for item in read {
        let Ok(item) = item else { continue };
        let path = item.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(entry) = read_entry(&path) else {
            continue;
        };
        entries.push(entry);
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    entries
}

/// Live R directories whose creating process is gone (or belongs to another
/// host). In-flight operations of this process are not abandoned.
pub fn abandoned_entries() -> Vec<RegistryEntry> {
    list_entries().into_iter().filter(is_abandoned).collect()
}

pub fn abandoned_count() -> Option<u32> {
    let count = abandoned_entries().len();
    (count > 0).then(|| count.min(u32::MAX as usize) as u32)
}

fn is_abandoned(entry: &RegistryEntry) -> bool {
    let path = entry.recovery_path();
    if !path.is_dir() {
        // Stale index row: R is already gone. Still report so recover can
        // drop the registry entry; startup should mention it.
        return true;
    }
    let host = crate::hostname::reported_hostname().unwrap_or_else(|| "unknown".to_string());
    if entry.summary.host != host {
        return true;
    }
    !pid_is_live(entry.summary.pid)
}

fn pid_is_live(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    if pid == std::process::id() {
        return true;
    }
    let Ok(raw) = i32::try_from(pid) else {
        return false;
    };
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(raw), None) {
        Ok(()) => true,
        Err(nix::errno::Errno::ESRCH) => false,
        Err(_) => true,
    }
}

fn registry_dir() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(path) = OVERRIDE.with(|slot| slot.borrow().clone()) {
        return Ok(path);
    }
    let state = crate::paths::state_dir().map_err(|err| format!("state directory: {err}"))?;
    Ok(state.join(REGISTRY_DIR_NAME))
}

fn entry_path(dir: &Path, recovery: &Path) -> PathBuf {
    let mut hasher = Sha256::new();
    use std::os::unix::ffi::OsStrExt;
    hasher.update(recovery.as_os_str().as_bytes());
    let digest = hasher.finalize();
    let mut name = String::with_capacity(digest.len() * 2 + 5);
    for byte in digest {
        name.push_str(&format!("{byte:02x}"));
    }
    name.push_str(".json");
    dir.join(name)
}

fn read_entry(path: &Path) -> Option<RegistryEntry> {
    let file = File::open(path).ok()?;
    let mut buf = Vec::new();
    file.take(ENTRY_MAX_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .ok()?;
    if buf.len() > ENTRY_MAX_BYTES {
        tracing::warn!(path = %path.display(), "file-recovery registry entry exceeds 64 KiB");
        return None;
    }
    serde_json::from_slice(&buf).ok()
}

fn create_dir_synced(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| format!("registry mkdir: {err}"))?;
    sync_dir(dir);
    Ok(())
}

fn sync_dir(dir: &Path) {
    if let Ok(file) = File::open(dir)
        && let Err(err) = file.sync_all()
    {
        let raw = err.raw_os_error();
        if raw == Some(nix::libc::EINVAL) || raw == Some(nix::libc::ENOTSUP) {
            tracing::warn!(
                dir = %dir.display(),
                "directory fsync is unsupported; file-recovery registry durability is best-effort"
            );
            return;
        }
        tracing::warn!(dir = %dir.display(), error = %err, "file-recovery registry dir fsync failed");
    }
}

#[cfg(test)]
pub(crate) fn install_temp_registry() -> RegistryGuard {
    let dir = tempfile::tempdir().expect("registry tempdir");
    OVERRIDE.with(|slot| *slot.borrow_mut() = Some(dir.path().to_path_buf()));
    RegistryGuard { _dir: Some(dir) }
}

#[cfg(test)]
pub(crate) struct RegistryGuard {
    _dir: Option<tempfile::TempDir>,
}

#[cfg(test)]
impl Drop for RegistryGuard {
    fn drop(&mut self) {
        OVERRIDE.with(|slot| *slot.borrow_mut() = None);
    }
}
