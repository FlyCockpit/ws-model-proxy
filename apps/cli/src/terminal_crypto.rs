//! End-to-end terminal crypto shared with the browser.
//!
//! The CLI keeps one reusable P-256 [`SecretKey`] for the daemon lifetime.
//! Each open or attach uses a fresh nonce and new session keys. `EphemeralSecret`
//! is single-use, so it cannot hold that static key.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::elliptic_curve::Generate;
use p256::elliptic_curve::sec1::ToSec1Point;
use p256::{PublicKey, SecretKey};
use sha2::{Digest, Sha256};

pub const DIR_BROWSER_TO_CLI: u8 = 0x01;
pub const DIR_CLI_TO_BROWSER: u8 = 0x02;
const HKDF_INFO_LABEL: &[u8] = b"wsmp-term-v1";
const APPROVAL_LABEL: &[u8] = b"wsmp-term-approve-v1";
const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Daemon-lifetime ECDH key. The secret stays in memory and is never written.
pub struct CliTerminalKey {
    secret: SecretKey,
    public_raw: [u8; 65],
    public_b64url: String,
}

impl std::fmt::Debug for CliTerminalKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CliTerminalKey")
            .field("public_b64url", &self.public_b64url)
            .finish_non_exhaustive()
    }
}

impl CliTerminalKey {
    pub fn generate() -> Result<Self> {
        let secret = SecretKey::try_generate().context("generating the terminal key")?;
        Self::from_secret(secret)
    }

    pub fn from_scalar_bytes(bytes: &[u8]) -> Result<Self> {
        let secret = SecretKey::from_slice(bytes).context("parsing the terminal scalar")?;
        Self::from_secret(secret)
    }

    fn from_secret(secret: SecretKey) -> Result<Self> {
        let encoded = secret.public_key().to_sec1_point(false);
        let public_raw = copy_exact::<65>(encoded.as_bytes(), "terminal public key")?;
        if public_raw[0] != 0x04 {
            anyhow::bail!("terminal public key is not uncompressed");
        }
        let public_b64url = URL_SAFE_NO_PAD.encode(public_raw);
        Ok(Self {
            secret,
            public_raw,
            public_b64url,
        })
    }

    pub fn public_raw(&self) -> &[u8; 65] {
        &self.public_raw
    }

    pub fn public_b64url(&self) -> &str {
        &self.public_b64url
    }

    /// 32-byte big-endian X coordinate. Reusable: this is not `EphemeralSecret`.
    pub fn shared_x(&self, browser_public_raw: &[u8; 65]) -> Result<[u8; 32]> {
        let public = PublicKey::from_sec1_bytes(browser_public_raw)
            .context("parsing the browser terminal public key")?;
        let shared = self.secret.diffie_hellman(&public);
        copy_exact::<32>(shared.raw_secret_bytes(), "terminal shared secret")
    }
}

#[derive(Clone)]
pub struct DirectionKeys {
    pub browser_to_cli: [u8; 32],
    pub cli_to_browser: [u8; 32],
}

pub fn derive_direction_keys(
    cli_key: &CliTerminalKey,
    browser_public_raw: &[u8; 65],
    browser_nonce: &[u8; 16],
    cli_nonce: &[u8; 16],
    terminal_id: &str,
) -> Result<DirectionKeys> {
    let ikm = cli_key.shared_x(browser_public_raw)?;
    derive_direction_keys_from_ikm(
        &ikm,
        cli_key.public_raw(),
        browser_public_raw,
        browser_nonce,
        cli_nonce,
        terminal_id,
    )
}

pub fn derive_direction_keys_from_ikm(
    ikm: &[u8; 32],
    cli_public_raw: &[u8; 65],
    browser_public_raw: &[u8; 65],
    browser_nonce: &[u8; 16],
    cli_nonce: &[u8; 16],
    terminal_id: &str,
) -> Result<DirectionKeys> {
    let mut salt = [0_u8; 32];
    salt[..16].copy_from_slice(browser_nonce);
    salt[16..].copy_from_slice(cli_nonce);
    let mut info = Vec::with_capacity(
        HKDF_INFO_LABEL.len() + terminal_id.len() + cli_public_raw.len() + browser_public_raw.len(),
    );
    info.extend_from_slice(HKDF_INFO_LABEL);
    info.extend_from_slice(terminal_id.as_bytes());
    info.extend_from_slice(cli_public_raw);
    info.extend_from_slice(browser_public_raw);
    let mut okm = [0_u8; 64];
    hkdf::Hkdf::<Sha256>::new(Some(&salt), ikm)
        .expand(&info, &mut okm)
        .context("deriving terminal session keys")?;
    Ok(DirectionKeys {
        browser_to_cli: copy_exact::<32>(&okm[..32], "browser-to-cli key")?,
        cli_to_browser: copy_exact::<32>(&okm[32..], "cli-to-browser key")?,
    })
}

pub fn random_nonce() -> Result<[u8; 16]> {
    <[u8; 16]>::try_generate().context("generating a terminal nonce")
}

pub fn encode_b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn decode_exact(value: &str, len: usize) -> Result<Vec<u8>> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value.trim())
        .context("decoding base64url")?;
    if bytes.len() != len {
        anyhow::bail!("expected {len} base64url bytes");
    }
    Ok(bytes)
}

pub fn decode_public_key(value: &str) -> Result<[u8; 65]> {
    let bytes = decode_exact(value, 65)?;
    let raw = copy_exact::<65>(&bytes, "public key")?;
    if raw[0] != 0x04 {
        anyhow::bail!("public key is not uncompressed");
    }
    PublicKey::from_sec1_bytes(&raw).context("parsing a P-256 public key")?;
    Ok(raw)
}

pub fn decode_nonce(value: &str) -> Result<[u8; 16]> {
    let bytes = decode_exact(value, 16)?;
    copy_exact::<16>(&bytes, "nonce")
}

pub enum TermPlaintext {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
}

pub fn encode_plaintext(message: &TermPlaintext) -> Result<Vec<u8>> {
    match message {
        TermPlaintext::Data(bytes) => {
            let mut out = Vec::with_capacity(1 + bytes.len());
            out.push(0x01);
            out.extend_from_slice(bytes);
            Ok(out)
        }
        TermPlaintext::Resize { cols, rows } => {
            validate_size(*cols, *rows)?;
            let mut out = Vec::with_capacity(5);
            out.push(0x02);
            out.extend_from_slice(&cols.to_be_bytes());
            out.extend_from_slice(&rows.to_be_bytes());
            Ok(out)
        }
    }
}

pub fn decode_plaintext(bytes: &[u8]) -> Result<TermPlaintext> {
    match bytes.first().copied() {
        Some(0x01) => Ok(TermPlaintext::Data(bytes[1..].to_vec())),
        Some(0x02) if bytes.len() == 5 => {
            let cols = u16::from_be_bytes([bytes[1], bytes[2]]);
            let rows = u16::from_be_bytes([bytes[3], bytes[4]]);
            validate_size(cols, rows)?;
            Ok(TermPlaintext::Resize { cols, rows })
        }
        _ => anyhow::bail!("terminal payload is invalid"),
    }
}

pub fn validate_size(cols: u16, rows: u16) -> Result<()> {
    if (1..=1000).contains(&cols) && (1..=1000).contains(&rows) {
        Ok(())
    } else {
        anyhow::bail!("terminal size is out of range")
    }
}

/// Accept `seq` only when it is strictly greater than the last accepted value.
pub fn accept_seq(last_accepted: &mut u64, seq: u64) -> bool {
    if seq > *last_accepted {
        *last_accepted = seq;
        true
    } else {
        false
    }
}

pub fn seal(
    key: &[u8; 32],
    terminal_id: &str,
    direction: u8,
    seq: u64,
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key).context("building the terminal cipher")?;
    let nonce_bytes = gcm_nonce(seq);
    let nonce = Nonce::try_from(nonce_bytes.as_slice()).context("building the terminal nonce")?;
    let aad = aad(terminal_id, direction, seq);
    cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .context("sealing a terminal frame")
}

pub fn open(
    key: &[u8; 32],
    terminal_id: &str,
    direction: u8,
    seq: u64,
    ciphertext: &[u8],
) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key).context("building the terminal cipher")?;
    let nonce_bytes = gcm_nonce(seq);
    let nonce = Nonce::try_from(nonce_bytes.as_slice()).context("building the terminal nonce")?;
    let aad = aad(terminal_id, direction, seq);
    cipher
        .decrypt(
            &nonce,
            Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
        .context("opening a terminal frame")
}

fn gcm_nonce(seq: u64) -> [u8; 12] {
    let mut nonce = [0_u8; 12];
    nonce[4..].copy_from_slice(&seq.to_be_bytes());
    nonce
}

fn aad(terminal_id: &str, direction: u8, seq: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(terminal_id.len() + 1 + 8);
    out.extend_from_slice(terminal_id.as_bytes());
    out.push(direction);
    out.extend_from_slice(&seq.to_be_bytes());
    out
}

/// First 8 characters of RFC 4648 base32 (no padding) over SHA-256(pubkey).
pub fn approval_code(public_raw: &[u8]) -> String {
    let digest = Sha256::digest(public_raw);
    base32_nopad(&digest).chars().take(8).collect()
}

pub fn base32_nopad(data: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer = 0_u64;
    let mut bits = 0_u32;
    for byte in data {
        buffer = (buffer << 8) | u64::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = ((buffer >> bits) & 0x1f) as usize;
            out.push(BASE32_ALPHABET[index] as char);
        }
    }
    if bits > 0 {
        let index = ((buffer << (5 - bits)) & 0x1f) as usize;
        out.push(BASE32_ALPHABET[index] as char);
    }
    out
}

pub fn approval_transcript(
    terminal_id: &str,
    browser_public_raw: &[u8; 65],
    browser_nonce: &[u8; 16],
    cli_public_raw: &[u8; 65],
    cli_nonce: &[u8; 16],
) -> Result<Vec<u8>> {
    let mut transcript = Vec::new();
    push_length_prefixed(&mut transcript, APPROVAL_LABEL)?;
    push_length_prefixed(&mut transcript, terminal_id.as_bytes())?;
    push_length_prefixed(&mut transcript, browser_public_raw)?;
    push_length_prefixed(&mut transcript, browser_nonce)?;
    push_length_prefixed(&mut transcript, cli_public_raw)?;
    push_length_prefixed(&mut transcript, cli_nonce)?;
    Ok(transcript)
}

fn push_length_prefixed(out: &mut Vec<u8>, bytes: &[u8]) -> Result<()> {
    let len = u16::try_from(bytes.len()).context("approval transcript part is too long")?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

pub fn verify_approval_signature(
    identity_public_raw: &[u8; 65],
    signature: &[u8],
    terminal_id: &str,
    browser_public_raw: &[u8; 65],
    browser_nonce: &[u8; 16],
    cli_public_raw: &[u8; 65],
    cli_nonce: &[u8; 16],
) -> bool {
    let Ok(transcript) = approval_transcript(
        terminal_id,
        browser_public_raw,
        browser_nonce,
        cli_public_raw,
        cli_nonce,
    ) else {
        return false;
    };
    let Ok(verifying) = VerifyingKey::from_sec1_bytes(identity_public_raw) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(signature) else {
        return false;
    };
    verifying.verify(&transcript, &signature).is_ok()
}

pub fn sign_approval(
    signing_key: &SigningKey,
    terminal_id: &str,
    browser_public_raw: &[u8; 65],
    browser_nonce: &[u8; 16],
    cli_public_raw: &[u8; 65],
    cli_nonce: &[u8; 16],
) -> Result<Vec<u8>> {
    let transcript = approval_transcript(
        terminal_id,
        browser_public_raw,
        browser_nonce,
        cli_public_raw,
        cli_nonce,
    )?;
    let signature: Signature = signing_key.sign(&transcript);
    Ok(signature.to_bytes().to_vec())
}

fn copy_exact<const N: usize>(bytes: &[u8], what: &str) -> Result<[u8; N]> {
    bytes
        .try_into()
        .with_context(|| format!("{what} has the wrong length"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(value: &str) -> Vec<u8> {
        (0..value.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("hex"))
            .collect()
    }

    fn array<const N: usize>(value: &str) -> [u8; N] {
        hex(value).try_into().expect("width")
    }

    #[test]
    fn shared_terminal_vector_matches_the_browser() {
        let cli = CliTerminalKey::from_scalar_bytes(&hex(
            "c88f01f510d9ac3f70a292daa2316de544e9aab8afe84049c62a9c57862d1433",
        ))
        .expect("cli key");
        assert_eq!(
            cli.public_b64url(),
            "BNrQtlOUIhz5sFHh_spXh9CY3-Y3_JC575RdDDdyWBGAUnGgRhzbglLWHxxFb6PlmrH0WzOsz19YOJ4Fd7iZC7M"
        );
        let browser = CliTerminalKey::from_scalar_bytes(&hex(
            "c6ef9c5d78ae012a011164acb397ce2088685d8f06bf9be0b283ab46476bee53",
        ))
        .expect("browser key");
        assert_eq!(
            browser.public_b64url(),
            "BNEt-1KJyNT4Egi3AnA5jDQilpcKC8y3THNvx1VElL9jVvvzyjZswj6BV4VME8WNaqwj8Eatow-DU-dPMwOYcqs"
        );
        let browser_nonce: [u8; 16] = array("00112233445566778899aabbccddeeff");
        let cli_nonce: [u8; 16] = array("ffeeddccbbaa99887766554433221100");
        let ikm = cli.shared_x(browser.public_raw()).expect("ikm");
        assert_eq!(
            hex::encode_like(&ikm),
            "d6840f6b42f6edafd13116e0e12565202fef8e9ece7dce03812464d04b9442de"
        );
        let keys = derive_direction_keys(
            &cli,
            browser.public_raw(),
            &browser_nonce,
            &cli_nonce,
            "term_vector_1",
        )
        .expect("keys");
        assert_eq!(
            hex::encode_like(&keys.browser_to_cli),
            "f2726c8e442ef54d9c71c2057c8c5ab0e79da6536f134351bce6ec870d1dcb8f"
        );
        assert_eq!(
            hex::encode_like(&keys.cli_to_browser),
            "cb095d76e3491169f6bd4bacdc50c6382e05ec25ffada619f418a4e26541b3c1"
        );

        let data = hex("016869");
        let sealed = seal(
            &keys.browser_to_cli,
            "term_vector_1",
            DIR_BROWSER_TO_CLI,
            1,
            &data,
        )
        .expect("seal data");
        assert_eq!(
            hex::encode_like(&sealed),
            "abf7af28ff10f995b04e545dd9510ca490ec2e"
        );
        let opened = open(
            &keys.browser_to_cli,
            "term_vector_1",
            DIR_BROWSER_TO_CLI,
            1,
            &sealed,
        )
        .expect("open data");
        assert_eq!(opened, data);

        let resize = hex("0200500018");
        let sealed_resize = seal(
            &keys.cli_to_browser,
            "term_vector_1",
            DIR_CLI_TO_BROWSER,
            1,
            &resize,
        )
        .expect("seal resize");
        assert_eq!(
            hex::encode_like(&sealed_resize),
            "52433cf15579f5953561372e175ec4d22245c3e5d8"
        );

        assert_eq!(approval_code(browser.public_raw()), "QSOWJSS6");
    }

    #[test]
    fn receivers_reject_a_seq_that_does_not_advance() {
        let mut last = 0_u64;
        assert!(accept_seq(&mut last, 1));
        assert!(!accept_seq(&mut last, 1));
        assert!(!accept_seq(&mut last, 0));
        assert!(accept_seq(&mut last, 2));
    }

    #[test]
    fn resize_bounds_and_approval_transcript_round_trip() {
        assert!(encode_plaintext(&TermPlaintext::Resize { cols: 0, rows: 24 }).is_err());
        assert!(
            encode_plaintext(&TermPlaintext::Resize {
                cols: 1001,
                rows: 24
            })
            .is_err()
        );
        let encoded =
            encode_plaintext(&TermPlaintext::Resize { cols: 80, rows: 24 }).expect("encode");
        assert_eq!(encoded, hex("0200500018"));

        let cli = CliTerminalKey::generate().expect("cli");
        let browser = CliTerminalKey::generate().expect("browser");
        let identity = SigningKey::try_generate().expect("identity");
        let identity_raw = copy_exact::<65>(
            identity.verifying_key().to_sec1_point(false).as_bytes(),
            "identity",
        )
        .expect("identity raw");
        let nonce = [7_u8; 16];
        let cli_nonce = [9_u8; 16];
        let signature = sign_approval(
            &identity,
            "term_vector_1",
            browser.public_raw(),
            &nonce,
            cli.public_raw(),
            &cli_nonce,
        )
        .expect("sign");
        let transcript = approval_transcript(
            "term_vector_1",
            browser.public_raw(),
            &nonce,
            cli.public_raw(),
            &cli_nonce,
        )
        .expect("transcript");
        assert!(transcript.windows(16).any(|window| window == cli_nonce));
        assert!(verify_approval_signature(
            &identity_raw,
            &signature,
            "term_vector_1",
            browser.public_raw(),
            &nonce,
            cli.public_raw(),
            &cli_nonce,
        ));
        let other_nonce = [8_u8; 16];
        assert!(!verify_approval_signature(
            &identity_raw,
            &signature,
            "term_vector_1",
            browser.public_raw(),
            &nonce,
            cli.public_raw(),
            &other_nonce,
        ));
        let mut bad = signature.clone();
        bad[0] ^= 0x01;
        assert!(!verify_approval_signature(
            &identity_raw,
            &bad,
            "term_vector_1",
            browser.public_raw(),
            &nonce,
            cli.public_raw(),
            &cli_nonce,
        ));
        assert_eq!(approval_code(&identity_raw).len(), 8);
    }

    mod hex {
        pub fn encode_like(bytes: &[u8]) -> String {
            bytes.iter().map(|byte| format!("{byte:02x}")).collect()
        }
    }
}
