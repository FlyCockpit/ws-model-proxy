//! Durable node credential storage (`node-credential.json`, 0600).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// What `wsmp login` stored. `Debug` never prints the credential.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeCredential {
    pub node_id: String,
    pub slug: String,
    pub server: String,
    pub credential: String,
}

impl std::fmt::Debug for NodeCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodeCredential")
            .field("node_id", &self.node_id)
            .field("slug", &self.slug)
            .field("server", &self.server)
            .field("credential", &"[redacted]")
            .finish()
    }
}

pub fn load_node_credential() -> Result<Option<NodeCredential>> {
    let path = crate::paths::node_credential_file()?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .with_context(|| format!("parsing node credential `{}`", path.display()))
            .map(Some),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => {
            Err(err).with_context(|| format!("reading node credential `{}`", path.display()))
        }
    }
}

/// Written through a synced temp file in the same 0700 directory, renamed
/// over the old credential (mode 0600), then the directory synced: a crash
/// leaves the old credential or the new one, never a torn file.
pub fn save_node_credential(credential: &NodeCredential) -> Result<()> {
    write_node_credential(&crate::paths::node_credential_file()?, credential)
}

fn write_node_credential(path: &std::path::Path, credential: &NodeCredential) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(credential).context("serializing node credential")?;
    bytes.push(b'\n');
    crate::approvals::write_private_atomic(path, &bytes, "node credential", false).map(|_| ())
}

pub fn remove_node_credential() -> Result<bool> {
    let path = crate::paths::node_credential_file()?;
    match std::fs::remove_file(&path) {
        Ok(()) => {
            sync_parent_dir(&path)?;
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => {
            Err(err).with_context(|| format!("removing node credential `{}`", path.display()))
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_credential_is_replaced_whole_in_its_format_and_mode() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("state").join("node-credential.json");
        let credential = |secret: &str| NodeCredential {
            node_id: "node-1".into(),
            slug: "box".into(),
            server: "https://wmp.example".into(),
            credential: secret.into(),
        };
        write_node_credential(&path, &credential("first")).expect("first write");
        write_node_credential(&path, &credential("second")).expect("replacing it");
        let text = std::fs::read_to_string(&path).expect("read back");
        let expected = format!(
            "{}\n",
            serde_json::to_string_pretty(&credential("second")).expect("json")
        );
        assert_eq!(text, expected);
        // Only the credential is left: no temp file beside it.
        let names: Vec<_> = std::fs::read_dir(path.parent().expect("parent"))
            .expect("list")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(names, ["node-credential.json"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &std::path::Path| {
                std::fs::metadata(path)
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777
            };
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(path.parent().expect("parent")), 0o700);
        }
    }
}
