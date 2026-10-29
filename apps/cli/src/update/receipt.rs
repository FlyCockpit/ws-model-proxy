//! The install receipt, `<state>/install.json`: how wsmp was installed. The
//! installers write it; the first successful update writes it for installs
//! older than self-update.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::protocol::frames::InstallMethod;

pub const RECEIPT_FILE: &str = "install.json";

/// Not strict: installers may add keys this version does not read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReceipt {
    pub method: InstallMethod,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<String>,
}

/// The receipt in `state_dir`; `None` when there is none or it cannot be read
/// (an unreadable receipt is logged and treated as missing).
pub fn read(state_dir: &Path) -> Option<InstallReceipt> {
    let path = state_dir.join(RECEIPT_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "the install receipt cannot be read");
            return None;
        }
    };
    serde_json::from_slice(&bytes)
        .inspect_err(|error| {
            tracing::warn!(path = %path.display(), %error, "the install receipt is not valid");
        })
        .ok()
}

pub fn write(state_dir: &Path, receipt: &InstallReceipt) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(receipt).context("encoding the install receipt")?;
    bytes.push(b'\n');
    crate::approvals::write_private_atomic(
        &state_dir.join(RECEIPT_FILE),
        &bytes,
        "install receipt",
        false,
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipts_round_trip_and_tolerate_new_keys() {
        let dir = tempfile::tempdir().expect("dir");
        assert_eq!(read(dir.path()), None);
        let receipt = InstallReceipt {
            method: InstallMethod::ScriptPs1,
            version: "0.4.3".into(),
            commit: Some("a".repeat(40)),
            target: Some("x86_64-pc-windows-msvc".into()),
            binary: Some(PathBuf::from("/x/wsmp.exe")),
            installed_at: Some("2026-10-28T10:00:00Z".into()),
        };
        write(dir.path(), &receipt).expect("write");
        assert_eq!(read(dir.path()), Some(receipt));
        std::fs::write(
            dir.path().join(RECEIPT_FILE),
            r#"{"method":"homebrew","version":"0.4.2","tap":"flycockpit/tap"}"#,
        )
        .expect("write");
        assert_eq!(
            read(dir.path()).map(|receipt| receipt.method),
            Some(InstallMethod::Homebrew)
        );
        std::fs::write(dir.path().join(RECEIPT_FILE), "{").expect("write");
        assert_eq!(read(dir.path()), None);
    }
}
