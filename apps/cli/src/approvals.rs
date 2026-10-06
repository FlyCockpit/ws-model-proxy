//! Browser-identity approvals for `requireTerminalApproval`.
//!
//! Pending and approved records live in the state directory. The daemon re-reads
//! the approved file on every open and attach, so approving does not need a restart.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::exit::{CodedError, ExitCode};
use crate::terminal_crypto::{approval_code, decode_public_key, encode_b64url};

const PENDING_FILE: &str = "terminal-approval-pending.json";
const APPROVED_FILE: &str = "terminal-approvals.json";

const PENDING_CAP: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
struct ApprovalFile {
    entries: BTreeMap<String, String>,
    /// Insertion order for the pending file. Empty on older files.
    #[serde(default)]
    order: Vec<String>,
    /// Pending file only: codes that two different browser identities asked
    /// for. Neither can be approved by that code until it is revoked.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    conflicted: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApprovalEntry {
    pub code: String,
    pub public_key: String,
}

pub fn pending_path(state_dir: &Path) -> PathBuf {
    state_dir.join(PENDING_FILE)
}

pub fn approved_path(state_dir: &Path) -> PathBuf {
    state_dir.join(APPROVED_FILE)
}

/// Records a browser identity that asked for approval and returns its code.
///
/// Codes are short (40 bits), so another identity with the same code can be
/// ground. A code is never moved to a different identity: one already
/// approved for another identity is refused, and a pending one is marked
/// conflicted, so neither identity can be approved by that code.
pub fn record_pending(state_dir: &Path, public_raw: &[u8; 65]) -> Result<String> {
    let code = approval_code(public_raw);
    let public_key = encode_b64url(public_raw);
    if read_file(&approved_path(state_dir))?
        .get(&code)
        .is_some_and(|approved| approved != &public_key)
    {
        anyhow::bail!(
            "terminal approval code `{code}` is already approved for another browser identity"
        );
    }
    let mut file = read_approval(&pending_path(state_dir))?;
    if file.conflicted.contains(&code) {
        anyhow::bail!("{}", conflicted_message(&code));
    }
    if file.order.is_empty() {
        file.order = file.entries.keys().cloned().collect();
    }
    if file
        .entries
        .get(&code)
        .is_some_and(|pending| pending != &public_key)
    {
        file.entries.remove(&code);
        file.order.retain(|existing| existing != &code);
        file.conflicted.push(code.clone());
        if file.conflicted.len() > PENDING_CAP {
            file.conflicted.remove(0);
        }
        write_approval(&pending_path(state_dir), &file)?;
        anyhow::bail!("{}", conflicted_message(&code));
    }
    file.entries.insert(code.clone(), public_key);
    file.order.retain(|existing| existing != &code);
    file.order.push(code.clone());
    while file.order.len() > PENDING_CAP {
        if let Some(oldest) = file.order.first().cloned() {
            file.order.remove(0);
            file.entries.remove(&oldest);
        } else {
            break;
        }
    }
    write_approval(&pending_path(state_dir), &file)?;
    Ok(code)
}

pub fn approved_public_key(state_dir: &Path, code: &str) -> Result<Option<[u8; 65]>> {
    let approved = read_file(&approved_path(state_dir))?;
    let Some(stored) = approved.get(code) else {
        return Ok(None);
    };
    match decode_public_key(stored) {
        Ok(raw) => Ok(Some(raw)),
        Err(error) => {
            tracing::warn!(error = %error, "ignoring an invalid terminal approval entry");
            Ok(None)
        }
    }
}

pub fn approve(state_dir: &Path, code: &str) -> Result<String> {
    let code = normalize_code(code)?;
    let mut pending = read_approval(&pending_path(state_dir))?;
    if pending.conflicted.contains(&code) {
        anyhow::bail!("{}", conflicted_message(&code));
    }
    let Some(public_key) = pending.entries.remove(&code) else {
        return Err(anyhow::anyhow!("terminal approval `{code}` not found")
            .context(CodedError::new(ExitCode::NotFound)));
    };
    let mut approved = read_file(&approved_path(state_dir))?;
    if approved
        .get(&code)
        .is_some_and(|existing| existing != &public_key)
    {
        anyhow::bail!(
            "terminal approval code `{code}` is already approved for another browser identity; \
             it is not replaced"
        );
    }
    pending.order.retain(|existing| existing != &code);
    write_approval(&pending_path(state_dir), &pending)?;
    approved.insert(code.clone(), public_key);
    write_file(&approved_path(state_dir), &approved)?;
    Ok(code)
}

fn conflicted_message(code: &str) -> String {
    format!(
        "terminal approval code `{code}` was requested by two different browser identities, \
         so it cannot be approved; run `wsmp terminal approvals revoke {code}` to clear it. \
         If your browser shows this code again, clear the dashboard's site data in that \
         browser so it creates a new identity"
    )
}

pub fn list(state_dir: &Path) -> Result<Vec<ApprovalEntry>> {
    let approved = read_file(&approved_path(state_dir))?;
    Ok(approved
        .into_iter()
        .map(|(code, public_key)| ApprovalEntry { code, public_key })
        .collect())
}

pub fn revoke(state_dir: &Path, code: &str) -> Result<String> {
    let code = normalize_code(code)?;
    let mut approved = read_file(&approved_path(state_dir))?;
    let mut pending = read_approval(&pending_path(state_dir))?;
    let removed_approved = approved.remove(&code).is_some();
    let removed_conflict = pending.conflicted.contains(&code);
    pending.conflicted.retain(|existing| existing != &code);
    let removed_pending = pending.entries.remove(&code).is_some() || removed_conflict;
    if !removed_approved && !removed_pending {
        return Err(anyhow::anyhow!("terminal approval `{code}` not found")
            .context(CodedError::new(ExitCode::NotFound)));
    }
    if removed_approved {
        write_file(&approved_path(state_dir), &approved)?;
    }
    if removed_pending {
        pending.order.retain(|existing| existing != &code);
        write_approval(&pending_path(state_dir), &pending)?;
    }
    Ok(code)
}

pub fn normalize_code(code: &str) -> Result<String> {
    let code = code.trim().to_ascii_uppercase();
    let valid = code.len() == 8
        && code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || (b'2'..=b'7').contains(&byte));
    if !valid {
        anyhow::bail!("terminal approval code `{code}` is invalid");
    }
    Ok(code)
}

fn read_file(path: &Path) -> Result<BTreeMap<String, String>> {
    Ok(read_approval(path)?.entries)
}

fn read_approval(path: &Path) -> Result<ApprovalFile> {
    match fs::read(path) {
        Ok(bytes) if bytes.is_empty() => Ok(ApprovalFile::default()),
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("parsing terminal approval file `{}`", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ApprovalFile::default()),
        Err(error) => Err(error)
            .with_context(|| format!("reading terminal approval file `{}`", path.display())),
    }
}

fn write_file(path: &Path, entries: &BTreeMap<String, String>) -> Result<()> {
    write_approval(
        path,
        &ApprovalFile {
            entries: entries.clone(),
            order: Vec::new(),
            conflicted: Vec::new(),
        },
    )
}

fn write_approval(path: &Path, file: &ApprovalFile) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(file).context("serializing terminal approvals")?;
    bytes.push(b'\n');
    write_private_atomic(path, &bytes, "terminal approval", false).map(|_| ())
}

/// Write `bytes` to `path` through a synced temp file: mode 0600 in a 0700
/// directory. With `no_clobber`, an existing file is kept and `Ok(false)` is
/// returned, so two processes creating the same file agree on one winner.
pub(crate) fn write_private_atomic(
    path: &Path,
    bytes: &[u8],
    what: &str,
    no_clobber: bool,
) -> Result<bool> {
    write_private_atomic_with_sync(path, bytes, what, no_clobber, |dir| {
        fs::File::open(dir).and_then(|directory| directory.sync_all())
    })
}

fn write_private_atomic_with_sync(
    path: &Path,
    bytes: &[u8],
    what: &str,
    no_clobber: bool,
    parent_sync: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<bool> {
    let dir = path
        .parent()
        .with_context(|| format!("{what} path has no parent directory"))?;
    fs::create_dir_all(dir)
        .with_context(|| format!("creating {what} directory `{}`", dir.display()))?;
    #[cfg(unix)]
    set_mode(dir, 0o700)?;
    let mut temp = tempfile::NamedTempFile::new_in(dir)
        .with_context(|| format!("creating a temporary {what} file in `{}`", dir.display()))?;
    {
        use std::io::Write;
        temp.write_all(bytes)
            .with_context(|| format!("writing {what} file `{}`", path.display()))?;
        temp.as_file()
            .sync_all()
            .with_context(|| format!("syncing {what} file `{}`", path.display()))?;
    }
    #[cfg(unix)]
    set_mode(temp.path(), 0o600)?;
    if no_clobber {
        match temp.persist_noclobber(path) {
            Ok(_) => {}
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Ok(false);
            }
            Err(error) => {
                return Err(error.error)
                    .with_context(|| format!("creating {what} file `{}`", path.display()));
            }
        }
    } else {
        temp.persist(path)
            .map_err(|error| error.error)
            .with_context(|| format!("replacing {what} file `{}`", path.display()))?;
    }
    #[cfg(unix)]
    set_mode(path, 0o600)?;
    #[cfg(unix)]
    parent_sync(dir).with_context(|| format!("syncing {what} directory `{}`", dir.display()))?;
    #[cfg(not(unix))]
    let _ = parent_sync;
    Ok(true)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)
        .with_context(|| format!("reading permissions for `{}`", path.display()))?
        .permissions();
    permissions.set_mode(mode);
    fs::set_permissions(path, permissions)
        .with_context(|| format!("setting permissions on `{}`", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_crypto::CliTerminalKey;

    #[cfg(unix)]
    #[test]
    fn atomic_parent_sync_error_propagates_after_publication() {
        let root = tempfile::tempdir().expect("root");
        let path = root.path().join("state.json");
        let error =
            write_private_atomic_with_sync(&path, b"durable-intent", "test state", false, |_| {
                Err(std::io::Error::from_raw_os_error(nix::libc::EIO))
            })
            .expect_err("parent sync failure must propagate");
        assert!(error.to_string().contains("syncing test state directory"));
        assert_eq!(fs::read(&path).expect("published"), b"durable-intent");
        assert!(
            write_private_atomic(&path, b"durable-intent", "test state", false).expect("retry")
        );
    }

    #[test]
    fn approve_moves_a_pending_identity() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key = CliTerminalKey::generate().expect("key");
        let code = record_pending(dir.path(), key.public_raw()).expect("pending");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(pending_path(dir.path()))
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(
            approved_public_key(dir.path(), &code)
                .expect("read")
                .is_none()
        );
        approve(dir.path(), &code.to_ascii_lowercase()).expect("approve");
        assert_eq!(
            approved_public_key(dir.path(), &code).expect("approved"),
            Some(*key.public_raw())
        );
        assert!(
            read_file(&pending_path(dir.path()))
                .expect("pending read")
                .is_empty()
        );
        let listed = list(dir.path()).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].code, code);
        revoke(dir.path(), &code).expect("revoke");
        assert!(list(dir.path()).expect("empty").is_empty());
    }

    #[test]
    fn pending_file_drops_the_oldest_entry_past_64() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut first = String::new();
        for index in 0..65_u16 {
            let mut raw = [0_u8; 65];
            raw[0] = 0x04;
            raw[1] = index.to_be_bytes()[0];
            raw[2] = index.to_be_bytes()[1];
            raw[3] = 1;
            let code = record_pending(dir.path(), &raw).expect("pending");
            if index == 0 {
                first = code;
            }
        }
        let file = read_approval(&pending_path(dir.path())).expect("read");
        assert_eq!(file.entries.len(), 64);
        assert_eq!(file.order.len(), 64);
        assert!(!file.entries.contains_key(&first));
        assert!(!file.order.iter().any(|code| code == &first));
    }

    /// Two distinct keys; the tests make `other` claim `key`'s code, standing
    /// in for a ground 40-bit collision.
    fn two_keys() -> (CliTerminalKey, CliTerminalKey) {
        (
            CliTerminalKey::generate().expect("key"),
            CliTerminalKey::generate().expect("other"),
        )
    }

    #[test]
    fn a_pending_code_collision_blocks_both_identities() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (key, other) = two_keys();
        let code = record_pending(dir.path(), key.public_raw()).expect("pending");
        // Recording the same identity again is not a collision.
        assert_eq!(
            record_pending(dir.path(), key.public_raw()).expect("again"),
            code
        );
        // Another identity got there first with the same code.
        let mut file = read_approval(&pending_path(dir.path())).expect("read");
        file.entries
            .insert(code.clone(), encode_b64url(other.public_raw()));
        write_approval(&pending_path(dir.path()), &file).expect("write");

        let error = record_pending(dir.path(), key.public_raw()).expect_err("collision");
        assert!(
            error
                .to_string()
                .contains("two different browser identities")
        );
        let file = read_approval(&pending_path(dir.path())).expect("read");
        assert!(
            !file.entries.contains_key(&code),
            "neither key stays pending"
        );
        assert_eq!(file.conflicted, vec![code.clone()]);

        // Neither identity can be approved by the code, nor re-recorded.
        assert!(approve(dir.path(), &code).is_err());
        assert!(record_pending(dir.path(), key.public_raw()).is_err());
        assert!(
            approved_public_key(dir.path(), &code)
                .expect("read")
                .is_none()
        );

        // Revoking the code clears the block.
        revoke(dir.path(), &code).expect("revoke clears the conflict");
        assert_eq!(
            record_pending(dir.path(), key.public_raw()).expect("pending"),
            code
        );
        approve(dir.path(), &code).expect("approve");
        assert_eq!(
            approved_public_key(dir.path(), &code).expect("approved"),
            Some(*key.public_raw())
        );
    }

    #[test]
    fn an_approved_code_is_never_moved_to_another_identity() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (key, other) = two_keys();
        let code = record_pending(dir.path(), key.public_raw()).expect("pending");
        approve(dir.path(), &code).expect("approve");

        // A colliding identity cannot become pending under the approved code.
        let mut approved = read_file(&approved_path(dir.path())).expect("read");
        approved.insert(code.clone(), encode_b64url(other.public_raw()));
        write_file(&approved_path(dir.path()), &approved).expect("write");
        let error = record_pending(dir.path(), key.public_raw()).expect_err("approved for other");
        assert!(error.to_string().contains("already approved"));

        // Nor can a pending entry for it replace the approved identity.
        approved.insert(code.clone(), encode_b64url(key.public_raw()));
        write_file(&approved_path(dir.path()), &approved).expect("write");
        let mut pending = read_approval(&pending_path(dir.path())).expect("read");
        pending
            .entries
            .insert(code.clone(), encode_b64url(other.public_raw()));
        pending.order.push(code.clone());
        write_approval(&pending_path(dir.path()), &pending).expect("write");
        let error = approve(dir.path(), &code).expect_err("no overwrite");
        assert!(error.to_string().contains("not replaced"));
        assert_eq!(
            approved_public_key(dir.path(), &code).expect("approved"),
            Some(*key.public_raw())
        );
    }

    #[test]
    fn unknown_approval_code_is_not_found() {
        let dir = tempfile::tempdir().expect("tempdir");
        let error = approve(dir.path(), "QSOWJSS6").expect_err("missing");
        assert_eq!(crate::exit::code_for(&error), ExitCode::NotFound);
        assert!(crate::exit::message_for(&error).contains("not found"));
    }
}
