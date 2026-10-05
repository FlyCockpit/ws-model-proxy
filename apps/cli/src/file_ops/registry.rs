//! Durable index of live `.wsmp-recover-*` directories in the CLI state
//! directory. Startup reads this instead of walking file roots.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::intent::{Intent, IntentSummary};

#[cfg(not(test))]
const REGISTRY_DIR_NAME: &str = "file-recovery";
const ENTRY_MAX_BYTES: usize = 64 * 1024;
/// Server `node.metrics.abandonedRecovery` wire max (`protocol.ts`).
const ABANDONED_RECOVERY_WIRE_MAX: u32 = 10_000;

#[cfg(test)]
thread_local! {
    static OVERRIDE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Tests that never call `install_temp_registry` (file_relay pool threads)
/// still must not write the developer's real state directory.
#[cfg(test)]
static PROCESS_REGISTRY: OnceLock<PathBuf> = OnceLock::new();

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

/// Why a registry write failed. A state directory without directory fsync can
/// never hold a durable discovery entry: callers report an unsafe filesystem
/// naming that directory instead of a transient I/O error.
#[derive(Debug)]
pub enum RegistryError {
    UnsupportedDirSync(PathBuf),
    Io(String),
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedDirSync(dir) => write!(
                f,
                "the CLI state directory `{}` does not support directory fsync, so file-recovery journals cannot be registered durably; nothing was changed",
                dir.display()
            ),
            Self::Io(message) => f.write_str(message),
        }
    }
}

impl From<String> for RegistryError {
    fn from(message: String) -> Self {
        Self::Io(message)
    }
}

impl From<&str> for RegistryError {
    fn from(message: &str) -> Self {
        Self::Io(message.to_string())
    }
}

pub fn register(recovery: &Path, intent: &Intent) -> Result<(), RegistryError> {
    let dir = registry_dir()?;
    create_dir_synced(&dir)?;
    let path = entry_path(&dir, recovery);
    let body = serde_json::to_vec_pretty(&RegistryEntry::from_intent(recovery, intent))
        .map_err(|err| format!("registry serialize: {err}"))?;
    write_entry_atomic(&dir, &path, &body)
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
    if let Err(error) = sync_dir(&dir) {
        tracing::warn!(recovery = %recovery.display(), %error, "registry removal sync failed; stale discovery may remain");
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
    (count > 0).then(|| count.min(ABANDONED_RECOVERY_WIRE_MAX as usize) as u32)
}

fn is_abandoned(entry: &RegistryEntry) -> bool {
    // Telemetry never stats an arbitrary recovery path (possibly blocked NFS).
    // Stale rows remain visible until an explicit `recover --apply` sweep.
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
    {
        if let Some(path) = OVERRIDE.with(|slot| slot.borrow().clone()) {
            return Ok(path);
        }
        Ok(PROCESS_REGISTRY
            .get_or_init(|| {
                let dir = tempfile::TempDir::new().expect("process registry");
                let path = dir.path().to_path_buf();
                std::mem::forget(dir);
                path
            })
            .clone())
    }
    #[cfg(not(test))]
    {
        let state = crate::paths::state_dir().map_err(|err| format!("state directory: {err}"))?;
        Ok(state.join(REGISTRY_DIR_NAME))
    }
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
    match serde_json::from_slice(&buf) {
        Ok(entry) => Some(entry),
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                error = %error,
                "file-recovery registry entry is unparsable"
            );
            None
        }
    }
}

fn write_entry_atomic(dir: &Path, dest: &Path, body: &[u8]) -> Result<(), RegistryError> {
    let tmp = dest.with_extension("json.tmp");
    match fs::remove_file(&tmp) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(format!("registry tmp unlink: {err}").into()),
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|err| format!("registry tmp create: {err}"))?;
    let written = file
        .write_all(body)
        .and_then(|()| file.write_all(b"\n"))
        .and_then(|()| file.sync_all());
    drop(file);
    if let Err(err) = written.and_then(|()| fs::rename(&tmp, dest)) {
        // Never leave a torn temp behind; its writeback is not retried.
        let _ = fs::remove_file(&tmp);
        return Err(format!("registry tmp write: {err}").into());
    }
    sync_dir(dir)
}

fn create_dir_synced(dir: &Path) -> Result<(), RegistryError> {
    let mut missing = Vec::new();
    let mut ancestor = dir;
    while !ancestor.is_dir() {
        missing.push(ancestor);
        ancestor = ancestor
            .parent()
            .ok_or("registry has no existing ancestor")?;
    }
    fs::create_dir_all(dir).map_err(|err| format!("registry mkdir: {err}"))?;
    sync_dir(dir)?;
    for created in missing {
        sync_dir(created)?;
        if let Some(parent) = created.parent() {
            sync_dir(parent)?;
        }
    }
    Ok(())
}

fn sync_dir(dir: &Path) -> Result<(), RegistryError> {
    File::open(dir)
        .and_then(|file| file.sync_all())
        .map_err(|error| {
            let raw = error.raw_os_error();
            if raw == Some(nix::libc::EINVAL) || raw == Some(nix::libc::ENOTSUP) {
                RegistryError::UnsupportedDirSync(dir.to_path_buf())
            } else {
                RegistryError::Io(format!("registry directory sync: {error}"))
            }
        })
}

#[cfg(test)]
pub(crate) fn current_registry_dir() -> PathBuf {
    registry_dir().expect("registry dir")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_ops::intent::Intent;

    #[test]
    fn register_round_trips_through_an_atomic_rename() {
        let _guard = install_temp_registry();
        let recovery = PathBuf::from("/tmp/wsmp-recover-test-entry");
        let intent = Intent::delete(&recovery.join("gone"));
        register(&recovery, &intent).expect("register");
        let entries = list_entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].summary.op, "delete");
        unregister(&recovery);
        assert!(list_entries().is_empty());
    }

    #[test]
    fn unparsable_registry_files_are_skipped() {
        let _guard = install_temp_registry();
        let dir = registry_dir().expect("dir");
        create_dir_synced(&dir).expect("mkdir");
        std::fs::write(dir.join("deadbeef.json"), "{not json").unwrap();
        assert!(list_entries().is_empty());
    }
}
