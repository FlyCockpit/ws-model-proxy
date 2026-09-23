//! Long-lived CLI identity key for terminal pinning (protocol 2.5).
//!
//! The daemon's ECDH terminal key is generated on every start and never
//! written. This P-256 ECDSA key is created once in `terminal-identity.json`
//! (mode 0600, next to `terminal-approvals.json`) and signs the current ECDH
//! key. The browser pins it per CLI device on first use, so a relay cannot swap
//! the ECDH key without the browser seeing a new identity.
//!
//! The signed statement binds the CLI slug, not the server's CLI device id.
//! The CLI does not learn its device id: the server upserts the device by
//! `(user, slug)` during hello and never sends the id back. The slug is what
//! the CLI reports in that same hello and what the server stores and lists for
//! the device, so each (user, slug) is exactly one device id.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use serde::{Deserialize, Serialize};

use crate::approvals::write_private_atomic;
use crate::terminal_crypto::{
    decode_exact, decode_public_key, encode_b64url, identity_fingerprint, identity_public_raw,
    sign_cli_identity,
};

const IDENTITY_FILE: &str = "terminal-identity.json";
const IDENTITY_FILE_VERSION: u32 = 1;
const IDENTITY_ALGORITHM: &str = "ecdsa-p256";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityFile {
    version: u32,
    algorithm: String,
    /// 32-byte private scalar, base64url without padding.
    private_key: String,
    /// 65-byte uncompressed SEC1 point, base64url without padding.
    public_key: String,
}

/// The persistent identity. The private key never leaves this struct.
pub struct CliIdentity {
    signing_key: SigningKey,
    public_raw: [u8; 65],
}

impl std::fmt::Debug for CliIdentity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CliIdentity")
            .field("fingerprint", &self.fingerprint())
            .finish_non_exhaustive()
    }
}

/// Identity public key and its signature over one ECDH key and CLI slug.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIdentityProof {
    /// 65-byte uncompressed SEC1, base64url without padding.
    pub public_key: String,
    /// 64-byte P1363 `r ‖ s`, base64url without padding.
    pub signature: String,
}

impl CliIdentity {
    pub fn from_scalar_bytes(bytes: &[u8]) -> Result<Self> {
        let signing_key = SigningKey::from_slice(bytes).context("parsing the identity key")?;
        let public_raw = identity_public_raw(&signing_key)?;
        Ok(Self {
            signing_key,
            public_raw,
        })
    }

    fn generate() -> Result<Self> {
        let signing_key =
            SigningKey::try_generate().context("generating the terminal identity key")?;
        let public_raw = identity_public_raw(&signing_key)?;
        Ok(Self {
            signing_key,
            public_raw,
        })
    }

    pub fn public_raw(&self) -> &[u8; 65] {
        &self.public_raw
    }

    pub fn public_b64url(&self) -> String {
        encode_b64url(&self.public_raw)
    }

    pub fn fingerprint(&self) -> String {
        identity_fingerprint(&self.public_raw)
    }

    /// Signs `lp16("wsmp-term-cli-id-v1") ‖ lp16(cli_slug) ‖ ecdh_public_raw`.
    pub fn prove(
        &self,
        cli_slug: &str,
        ecdh_public_raw: &[u8; 65],
    ) -> Result<TerminalIdentityProof> {
        let signature = sign_cli_identity(&self.signing_key, cli_slug, ecdh_public_raw)?;
        Ok(TerminalIdentityProof {
            public_key: self.public_b64url(),
            signature: encode_b64url(&signature),
        })
    }

    fn to_file(&self) -> IdentityFile {
        IdentityFile {
            version: IDENTITY_FILE_VERSION,
            algorithm: IDENTITY_ALGORITHM.to_string(),
            private_key: encode_b64url(&self.signing_key.to_bytes()),
            public_key: self.public_b64url(),
        }
    }
}

pub fn identity_path(state_dir: &Path) -> PathBuf {
    state_dir.join(IDENTITY_FILE)
}

/// Read the identity, or `None` when the file does not exist yet.
pub fn load(state_dir: &Path) -> Result<Option<CliIdentity>> {
    let path = identity_path(state_dir);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("reading terminal identity file `{}`", path.display()));
        }
    };
    let file: IdentityFile = serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing terminal identity file `{}`", path.display()))?;
    if file.version != IDENTITY_FILE_VERSION || file.algorithm != IDENTITY_ALGORITHM {
        anyhow::bail!(
            "terminal identity file `{}` has an unsupported version",
            path.display()
        );
    }
    let scalar = decode_exact(&file.private_key, 32)
        .with_context(|| format!("reading the key in `{}`", path.display()))?;
    let identity = CliIdentity::from_scalar_bytes(&scalar)
        .with_context(|| format!("reading the key in `{}`", path.display()))?;
    let stored_public = decode_public_key(&file.public_key)
        .with_context(|| format!("reading the public key in `{}`", path.display()))?;
    if stored_public != identity.public_raw {
        anyhow::bail!(
            "terminal identity file `{}` does not match its private key",
            path.display()
        );
    }
    Ok(Some(identity))
}

/// Load the identity, creating it on first use. An existing file is never
/// replaced: a damaged file is an error, so the pinned key is not lost silently.
pub fn load_or_create(state_dir: &Path) -> Result<CliIdentity> {
    if let Some(identity) = load(state_dir)? {
        return Ok(identity);
    }
    let identity = CliIdentity::generate()?;
    let mut bytes =
        serde_json::to_vec_pretty(&identity.to_file()).context("serializing terminal identity")?;
    bytes.push(b'\n');
    let created =
        write_private_atomic(&identity_path(state_dir), &bytes, "terminal identity", true)?;
    bytes.fill(0);
    if created {
        return Ok(identity);
    }
    // Another process created it first. Use that one.
    load(state_dir)?.context("terminal identity file disappeared after creation")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_crypto::{CliTerminalKey, verify_cli_identity};

    #[test]
    fn identity_is_created_once_and_reused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = dir.path().join("state");
        assert!(load(&state).expect("empty").is_none());
        let first = load_or_create(&state).expect("create");
        let path = identity_path(&state);
        assert!(path.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).expect("metadata").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
            let dir_mode = fs::metadata(&state).expect("dir").permissions().mode();
            assert_eq!(dir_mode & 0o777, 0o700);
        }
        let before = fs::read(&path).expect("read");
        let second = load_or_create(&state).expect("reuse");
        assert_eq!(first.public_raw(), second.public_raw());
        assert_eq!(first.fingerprint(), second.fingerprint());
        assert_eq!(fs::read(&path).expect("read again"), before);
        assert_eq!(first.fingerprint().len(), 32 + 7);
    }

    #[test]
    fn a_damaged_identity_file_is_an_error_and_is_kept() {
        let dir = tempfile::tempdir().expect("tempdir");
        load_or_create(dir.path()).expect("create");
        let path = identity_path(dir.path());
        fs::write(&path, b"{\"version\":1}").expect("damage");
        assert!(load_or_create(dir.path()).is_err());
        assert_eq!(fs::read(&path).expect("kept"), b"{\"version\":1}");
    }

    #[test]
    fn a_mismatched_public_key_is_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        load_or_create(dir.path()).expect("create");
        let path = identity_path(dir.path());
        let mut file: IdentityFile =
            serde_json::from_slice(&fs::read(&path).expect("read")).expect("parse");
        let other = CliIdentity::generate().expect("other");
        file.public_key = other.public_b64url();
        fs::write(&path, serde_json::to_vec(&file).expect("encode")).expect("write");
        let error = load(dir.path()).expect_err("mismatch");
        assert!(format!("{error:#}").contains("does not match"));
    }

    #[test]
    fn proofs_verify_for_the_signed_slug_and_key_only() {
        let identity = CliIdentity::generate().expect("identity");
        let ecdh = CliTerminalKey::generate().expect("ecdh");
        let other = CliTerminalKey::generate().expect("other");
        let proof = identity.prove("desk-01", ecdh.public_raw()).expect("prove");
        let signature = decode_exact(&proof.signature, 64).expect("signature");
        let public = decode_public_key(&proof.public_key).expect("public");
        assert!(verify_cli_identity(
            &public,
            &signature,
            "desk-01",
            ecdh.public_raw()
        ));
        assert!(!verify_cli_identity(
            &public,
            &signature,
            "desk-02",
            ecdh.public_raw()
        ));
        assert!(!verify_cli_identity(
            &public,
            &signature,
            "desk-01",
            other.public_raw()
        ));
    }
}
