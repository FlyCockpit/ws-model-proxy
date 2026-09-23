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

pub fn record_pending(state_dir: &Path, public_raw: &[u8; 65]) -> Result<String> {
    let code = approval_code(public_raw);
    let public_key = encode_b64url(public_raw);
    let mut file = read_approval(&pending_path(state_dir))?;
    if file.order.is_empty() {
        file.order = file.entries.keys().cloned().collect();
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
    let Some(public_key) = pending.entries.remove(&code) else {
        return Err(anyhow::anyhow!("terminal approval `{code}` not found")
            .context(CodedError::new(ExitCode::NotFound)));
    };
    pending.order.retain(|existing| existing != &code);
    write_approval(&pending_path(state_dir), &pending)?;
    let mut approved = read_file(&approved_path(state_dir))?;
    approved.insert(code.clone(), public_key);
    write_file(&approved_path(state_dir), &approved)?;
    Ok(code)
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
    let removed_pending = pending.entries.remove(&code).is_some();
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

    #[test]
    fn unknown_approval_code_is_not_found() {
        let dir = tempfile::tempdir().expect("tempdir");
        let error = approve(dir.path(), "QSOWJSS6").expect_err("missing");
        assert_eq!(crate::exit::code_for(&error), ExitCode::NotFound);
        assert!(crate::exit::message_for(&error).contains("not found"));
    }
}
