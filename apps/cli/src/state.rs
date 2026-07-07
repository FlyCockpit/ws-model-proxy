//! Durable product-native device credential storage.

use std::io::Write;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCredential {
    pub credential_id: Option<String>,
    pub user_id: Option<String>,
    pub secret: String,
}

pub fn load_device_credential() -> Result<Option<DeviceCredential>> {
    let path = crate::paths::device_credential_file()?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .with_context(|| format!("parsing device credential `{}`", path.display()))
            .map(Some),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => {
            Err(err).with_context(|| format!("reading device credential `{}`", path.display()))
        }
    }
}

pub fn save_device_credential(credential: &DeviceCredential) -> Result<()> {
    let path = crate::paths::device_credential_file()?;
    let dir = path
        .parent()
        .map(std::path::Path::to_path_buf)
        .context("device credential path has no parent directory")?;
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating state directory `{}`", dir.display()))?;
    set_private_dir(&dir)?;
    let text = serde_json::to_string_pretty(credential).context("serializing device credential")?;
    write_private_file(&path, text.as_bytes())?;
    sync_parent_dir(&path)?;
    Ok(())
}

pub fn remove_device_credential() -> Result<bool> {
    let path = crate::paths::device_credential_file()?;
    match std::fs::remove_file(&path) {
        Ok(()) => {
            sync_parent_dir(&path)?;
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => {
            Err(err).with_context(|| format!("removing device credential `{}`", path.display()))
        }
    }
}

#[cfg(unix)]
fn write_private_file(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("opening private credential file `{}`", path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("writing credential file `{}`", path.display()))?;
    file.write_all(b"\n")
        .with_context(|| format!("writing credential file `{}`", path.display()))?;
    file.sync_all()
        .with_context(|| format!("syncing credential file `{}`", path.display()))?;
    let mut permissions = file
        .metadata()
        .with_context(|| format!("reading metadata for `{}`", path.display()))?
        .permissions();
    use std::os::unix::fs::PermissionsExt;
    permissions.set_mode(0o600);
    std::fs::set_permissions(path, permissions)
        .with_context(|| format!("setting private permissions on `{}`", path.display()))
}

#[cfg(not(unix))]
fn write_private_file(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .with_context(|| format!("opening credential file `{}`", path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("writing credential file `{}`", path.display()))?;
    file.write_all(b"\n")
        .with_context(|| format!("writing credential file `{}`", path.display()))?;
    file.sync_all()
        .with_context(|| format!("syncing credential file `{}`", path.display()))
}

#[cfg(unix)]
fn set_private_dir(path: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = std::fs::metadata(path)
        .with_context(|| format!("reading metadata for `{}`", path.display()))?
        .permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(path, permissions)
        .with_context(|| format!("setting private permissions on `{}`", path.display()))
}

#[cfg(not(unix))]
fn set_private_dir(_path: &std::path::Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_parent_dir(path: &std::path::Path) -> Result<()> {
    let Some(dir) = path.parent() else {
        return Ok(());
    };
    std::fs::File::open(dir)
        .and_then(|dir_file| dir_file.sync_all())
        .with_context(|| format!("syncing state directory `{}`", dir.display()))
}

#[cfg(not(unix))]
fn sync_parent_dir(_path: &std::path::Path) -> Result<()> {
    Ok(())
}
