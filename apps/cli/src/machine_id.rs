//! Login-time machine id.
//!
//! A device credential is bound to this id when `wsmp login` completes. Hello
//! presents the same id. `/etc/machine-id` wins when it is a real machine id.
//! Otherwise the CLI keeps a UUID it generated in the state directory, next to
//! `device-auth.json` and not in the user-edited config. Hostname is only a
//! display label.
//!
//! The server accepts the same two shapes (`normalizeLoginMachineId` in
//! `packages/config/src/login-machine-id.ts`).

use std::io::Write;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

use anyhow::{Context, Result};
use rand::Rng;

const ETC_MACHINE_ID: &str = "/etc/machine-id";

/// This machine's login id: `/etc/machine-id`, else the state-directory UUID,
/// creating that file the first time it is needed.
pub fn login_machine_id() -> Result<String> {
    let etc = read_etc_machine_id().context("reading /etc/machine-id")?;
    if let Some(id) = etc {
        return Ok(id);
    }
    read_or_create_sidecar(&crate::paths::machine_id_file()?)
}

/// `/etc/machine-id` when it contains a machine id. `Ok(None)` when the file
/// is missing or is not a machine id (empty, `uninitialized`, all zeros), so
/// the caller falls back to the generated UUID. A file that exists but cannot
/// be read is an error: do not quietly mint a copyable id on that machine.
fn read_etc_machine_id() -> std::io::Result<Option<String>> {
    #[cfg(unix)]
    {
        match std::fs::read_to_string(ETC_MACHINE_ID) {
            Ok(text) => Ok(parse_login_machine_id(&text).filter(|id| is_machine_id(id))),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err),
        }
    }
    #[cfg(not(unix))]
    {
        Ok(None)
    }
}

fn read_or_create_sidecar(path: &Path) -> Result<String> {
    if let Some(id) = read_sidecar(path)? {
        return Ok(id);
    }
    let id = random_uuid_v4();
    write_sidecar(path, &id)?;
    Ok(id)
}

fn read_sidecar(path: &Path) -> Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(parse_login_machine_id(&text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).with_context(|| format!("reading machine id `{}`", path.display())),
    }
}

/// A systemd machine-id (32 hex digits, not all zeros) or a UUID. Trimmed and
/// lowercased. Anything else, including the nil UUID, is `None`.
pub fn parse_login_machine_id(raw: &str) -> Option<String> {
    let value = raw.trim().to_ascii_lowercase();
    if is_machine_id(&value) || is_uuid(&value) {
        Some(value)
    } else {
        None
    }
}

fn is_machine_id(value: &str) -> bool {
    value.len() == 32
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        && value.bytes().any(|byte| byte != b'0')
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let groups = [8, 4, 4, 4, 12];
    let mut index = 0;
    for (group_index, length) in groups.iter().enumerate() {
        if group_index > 0 {
            if bytes.get(index) != Some(&b'-') {
                return false;
            }
            index += 1;
        }
        for _ in 0..*length {
            if !bytes
                .get(index)
                .is_some_and(|byte| byte.is_ascii_hexdigit())
            {
                return false;
            }
            index += 1;
        }
    }
    value != "00000000-0000-0000-0000-000000000000"
}

fn random_uuid_v4() -> String {
    let mut bytes = [0_u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn write_sidecar(path: &Path, id: &str) -> Result<()> {
    let dir = path
        .parent()
        .map(Path::to_path_buf)
        .context("machine id path has no parent directory")?;
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating state directory `{}`", dir.display()))?;
    set_private_dir(&dir)?;
    write_private_file(path, id.as_bytes())?;
    sync_parent_dir(path)?;
    Ok(())
}

#[cfg(unix)]
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("opening machine id `{}`", path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("writing machine id `{}`", path.display()))?;
    file.write_all(b"\n")
        .with_context(|| format!("writing machine id `{}`", path.display()))?;
    file.sync_all()
        .with_context(|| format!("syncing machine id `{}`", path.display()))?;
    let mut permissions = file
        .metadata()
        .with_context(|| format!("reading metadata for `{}`", path.display()))?
        .permissions();
    permissions.set_mode(0o600);
    std::fs::set_permissions(path, permissions)
        .with_context(|| format!("setting private permissions on `{}`", path.display()))
}

#[cfg(not(unix))]
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .with_context(|| format!("opening machine id `{}`", path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("writing machine id `{}`", path.display()))?;
    file.write_all(b"\n")
        .with_context(|| format!("writing machine id `{}`", path.display()))?;
    file.sync_all()
        .with_context(|| format!("syncing machine id `{}`", path.display()))
}

#[cfg(unix)]
fn set_private_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = std::fs::metadata(path)
        .with_context(|| format!("reading metadata for `{}`", path.display()))?
        .permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(path, permissions)
        .with_context(|| format!("setting private permissions on `{}`", path.display()))
}

#[cfg(not(unix))]
fn set_private_dir(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_parent_dir(path: &Path) -> Result<()> {
    let Some(dir) = path.parent() else {
        return Ok(());
    };
    std::fs::File::open(dir)
        .and_then(|dir_file| dir_file.sync_all())
        .with_context(|| format!("syncing state directory `{}`", dir.display()))
}

#[cfg(not(unix))]
fn sync_parent_dir(_path: &Path) -> Result<()> {
    Ok(())
}

/// Used by tests that need a path without touching the process state dir.
#[cfg(test)]
fn sidecar_in(dir: &Path) -> PathBuf {
    dir.join("machine-id")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_machine_ids_and_uuids_only() {
        assert_eq!(
            parse_login_machine_id(" 0123456789ABCDEF0123456789ABCDEF\n").as_deref(),
            Some("0123456789abcdef0123456789abcdef")
        );
        assert_eq!(
            parse_login_machine_id("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE").as_deref(),
            Some("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
        );
        assert_eq!(parse_login_machine_id("uninitialized"), None);
        assert_eq!(
            parse_login_machine_id("00000000000000000000000000000000"),
            None
        );
        assert_eq!(
            parse_login_machine_id("00000000-0000-0000-0000-000000000000"),
            None
        );
        assert_eq!(parse_login_machine_id("short"), None);
    }

    #[test]
    fn a_missing_sidecar_is_created_once_and_reused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = sidecar_in(dir.path());
        let first = read_or_create_sidecar(&path).expect("create");
        let second = read_or_create_sidecar(&path).expect("reuse");
        assert_eq!(first, second);
        assert!(parse_login_machine_id(&first).is_some());
        assert_ne!(first.len(), 32, "generated ids are UUIDs, not machine-ids");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn an_existing_sidecar_is_not_rewritten() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = sidecar_in(dir.path());
        std::fs::write(&path, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n").unwrap();
        let id = read_or_create_sidecar(&path).expect("read");
        assert_eq!(id, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    }
}
