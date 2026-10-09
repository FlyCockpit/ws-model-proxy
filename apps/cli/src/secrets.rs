//! Node secrets (`WSMP_SECRET_*`).
//!
//! Set remotely with `secret.set` / `secret.delete` at Full control only, and
//! locally with `wsmp secret set|remove` on a terminal at any trust. Values
//! live in `<state dir>/node-secrets.json` (mode 0600 in a 0700 directory,
//! written atomically) and never leave this machine again: the node reports
//! names and update times only (`features.secrets`), and no value is ever
//! logged. Runtime commands receive the ones their definition names
//! (`launch.secrets`) as environment variables; always-on runtimes send them
//! as auth/header values (`address.auth.env`, `address.headers[].env`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::protocol::frames::{NODE_SECRET_VALUE_MAX_BYTES, SecretRefusal, is_secret_name};
use crate::protocol::runtime_spec::SecretEntry;

const SECRETS_FILE: &str = "node-secrets.json";
const SECRETS_VERSION: u32 = 1;
/// Secrets one node keeps.
pub const NODE_SECRETS_MAX: usize = 64;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretsFile {
    version: u32,
    secrets: BTreeMap<String, StoredSecret>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSecret {
    /// Never printed: `StoredSecret` has no `Debug`.
    value: String,
    updated_at: String,
}

/// What a secret write or removal did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Set { updated_at: String },
    Deleted,
    NotFound,
}

fn path() -> Result<PathBuf> {
    Ok(crate::paths::state_dir()?.join(SECRETS_FILE))
}

fn load(path: &Path) -> Result<SecretsFile> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let file: SecretsFile = serde_json::from_slice(&bytes)
                .with_context(|| format!("parsing node secrets `{}`", path.display()))?;
            anyhow::ensure!(
                file.version == SECRETS_VERSION,
                "node secrets `{}` have an unknown version",
                path.display()
            );
            Ok(file)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SecretsFile {
            version: SECRETS_VERSION,
            secrets: BTreeMap::new(),
        }),
        Err(error) => {
            Err(error).with_context(|| format!("reading node secrets `{}`", path.display()))
        }
    }
}

fn save(path: &Path, file: &SecretsFile) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(file).context("serializing node secrets")?;
    bytes.push(b'\n');
    crate::approvals::write_private_atomic(path, &bytes, "node secrets", false).map(|_| ())
}

/// Names and update times, for the hello and `node.state` features.
pub fn entries() -> Vec<SecretEntry> {
    path()
        .and_then(|path| load(&path))
        .map(|file| entries_of(&file))
        .unwrap_or_else(|error| {
            tracing::warn!(error = %format!("{error:#}"), "reading node secrets failed");
            Vec::new()
        })
}

fn entries_of(file: &SecretsFile) -> Vec<SecretEntry> {
    file.secrets
        .iter()
        .map(|(name, secret)| SecretEntry {
            name: name.clone(),
            updated_at: secret.updated_at.clone(),
        })
        .collect()
}

/// One secret's value, for a runtime command or an upstream header. Never
/// log the result.
pub fn value(name: &str) -> Option<String> {
    let path = path().ok()?;
    load(&path)
        .ok()?
        .secrets
        .remove(name)
        .map(|secret| secret.value)
}

/// The value an upstream header or auth names (`address.auth.env`,
/// `address.headers[].env`): node secrets only, never the process
/// environment. The error names the secret, never a value.
pub fn credential(name: &str) -> Result<String> {
    anyhow::ensure!(
        is_secret_name(name),
        "`{name}` is not a node secret name (`WSMP_SECRET_*`)"
    );
    #[cfg(test)]
    if let Some(value) = test_secrets()
        .lock()
        .ok()
        .and_then(|secrets| secrets.get(name).cloned())
    {
        return Ok(value);
    }
    value(name)
        .with_context(|| format!("node secret `{name}` is not set; run `wsmp secret set {name}`"))
}

/// Secrets unit tests provide without touching the state directory.
#[cfg(test)]
pub(crate) fn test_secrets() -> &'static std::sync::Mutex<BTreeMap<String, String>> {
    static SECRETS: std::sync::OnceLock<std::sync::Mutex<BTreeMap<String, String>>> =
        std::sync::OnceLock::new();
    SECRETS.get_or_init(|| std::sync::Mutex::new(BTreeMap::new()))
}

/// The named secrets that exist, as `(name, value)` for a child environment.
/// Missing names are skipped (the caller reports which, never values).
pub fn values(names: &[String]) -> (Vec<(String, String)>, Vec<String>) {
    let mut file = path().and_then(|path| load(&path)).unwrap_or_default();
    let mut found = Vec::new();
    let mut missing = Vec::new();
    for name in names {
        match file.secrets.remove(name) {
            Some(secret) => found.push((name.clone(), secret.value)),
            None => missing.push(name.clone()),
        }
    }
    (found, missing)
}

/// `secret.set`: refused at Relay only.
pub fn set(full_control: bool, name: &str, value: &str) -> Result<Outcome, SecretRefusal> {
    let path = path().map_err(|_| SecretRefusal::StoreFailed)?;
    set_at(&path, full_control, name, value)
}

/// `wsmp secret set` on this machine: allowed at any trust.
pub fn set_local(name: &str, value: &str) -> Result<Outcome, SecretRefusal> {
    let path = path().map_err(|_| SecretRefusal::StoreFailed)?;
    set_at(&path, true, name, value)
}

/// `wsmp secret remove` on this machine: allowed at any trust.
pub fn delete_local(name: &str) -> Result<Outcome, SecretRefusal> {
    let path = path().map_err(|_| SecretRefusal::StoreFailed)?;
    delete_at(&path, true, name)
}

/// `secret.delete`: refused at Relay only.
pub fn delete(full_control: bool, name: &str) -> Result<Outcome, SecretRefusal> {
    let path = path().map_err(|_| SecretRefusal::StoreFailed)?;
    delete_at(&path, full_control, name)
}

fn set_at(
    path: &Path,
    full_control: bool,
    name: &str,
    value: &str,
) -> Result<Outcome, SecretRefusal> {
    if !full_control {
        return Err(SecretRefusal::TrustRelay);
    }
    if !is_secret_name(name)
        || value.is_empty()
        || value.len() > NODE_SECRET_VALUE_MAX_BYTES
        || value.contains('\0')
    {
        return Err(SecretRefusal::Invalid);
    }
    let _lock = crate::config::ConfigLock::exclusive().map_err(|_| SecretRefusal::StoreFailed)?;
    let mut file = load(path).map_err(|_| SecretRefusal::StoreFailed)?;
    if !file.secrets.contains_key(name) && file.secrets.len() >= NODE_SECRETS_MAX {
        return Err(SecretRefusal::Limit);
    }
    let updated_at = crate::telemetry::now_rfc3339();
    file.secrets.insert(
        name.to_string(),
        StoredSecret {
            value: value.to_string(),
            updated_at: updated_at.clone(),
        },
    );
    save(path, &file).map_err(|error| {
        tracing::warn!(name, error = %format!("{error:#}"), "storing a node secret failed");
        SecretRefusal::StoreFailed
    })?;
    tracing::info!(name, "stored a node secret");
    Ok(Outcome::Set { updated_at })
}

fn delete_at(path: &Path, full_control: bool, name: &str) -> Result<Outcome, SecretRefusal> {
    if !full_control {
        return Err(SecretRefusal::TrustRelay);
    }
    if !is_secret_name(name) {
        return Err(SecretRefusal::Invalid);
    }
    let _lock = crate::config::ConfigLock::exclusive().map_err(|_| SecretRefusal::StoreFailed)?;
    let mut file = load(path).map_err(|_| SecretRefusal::StoreFailed)?;
    if file.secrets.remove(name).is_none() {
        return Ok(Outcome::NotFound);
    }
    save(path, &file).map_err(|_| SecretRefusal::StoreFailed)?;
    tracing::info!(name, "removed a node secret");
    Ok(Outcome::Deleted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_stored_privately_listed_by_name_and_removed() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("state").join(SECRETS_FILE);
        assert_eq!(
            set_at(&path, false, "WSMP_SECRET_HF", "v"),
            Err(SecretRefusal::TrustRelay)
        );
        assert_eq!(
            set_at(&path, true, "HF_TOKEN", "v"),
            Err(SecretRefusal::Invalid)
        );
        assert_eq!(
            set_at(&path, true, "WSMP_SECRET_HF", ""),
            Err(SecretRefusal::Invalid)
        );
        assert!(matches!(
            set_at(&path, true, "WSMP_SECRET_HF", "hf_value"),
            Ok(Outcome::Set { .. })
        ));
        let file = load(&path).expect("load");
        let entries = entries_of(&file);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "WSMP_SECRET_HF");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(
            delete_at(&path, false, "WSMP_SECRET_HF"),
            Err(SecretRefusal::TrustRelay)
        );
        assert_eq!(
            delete_at(&path, true, "WSMP_SECRET_HF"),
            Ok(Outcome::Deleted)
        );
        assert_eq!(
            delete_at(&path, true, "WSMP_SECRET_HF"),
            Ok(Outcome::NotFound)
        );
    }
}
