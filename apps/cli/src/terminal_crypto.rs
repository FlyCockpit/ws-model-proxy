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
const HKDF_INFO_LABEL_V2: &[u8] = b"wsmp-term-v2";
const BROADCAST_LABEL: &[u8] = b"wsmp-term-v2-out";
const APPROVAL_LABEL_V2: &[u8] = b"wsmp-term-approve-v2";
const CLI_IDENTITY_LABEL: &[u8] = b"wsmp-term-cli-id-v1";
pub const PLAINTEXT_OUTPUT_KEY: u8 = 0x03;
/// Browser -> CLI: turn output review on or off for a supervised command.
pub const PLAINTEXT_REVIEW_TOGGLE: u8 = 0x04;
/// CLI -> browser, unicast: the output capture for review.
pub const PLAINTEXT_REVIEW_CAPTURE: u8 = 0x05;
/// CLI -> browser: whether output review is on.
pub const PLAINTEXT_REVIEW_STATE: u8 = 0x06;
/// Retained capture head, matching the server's bounded command output.
pub const CAPTURE_HEAD_MAX: usize = 8192;
/// Retained capture tail, matching the server's bounded command output.
pub const CAPTURE_TAIL_MAX: usize = 40960;
const REVIEW_CAPTURE_HEADER_LEN: usize = 1 + 8 + 4;
const OUTPUT_KEY_PLAINTEXT_LEN: usize = 1 + 4 + 32;
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
    let len = u16::try_from(bytes.len()).context("length-prefixed field is too long")?;
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

// Protocol 2.5 (crypto v2). Every variable-length field is `lp16`, so no two
// (terminalId, viewerId) pairs share an HKDF info or an AAD. `terminal_id` and
// `viewer_id` enter as their UTF-8 wire strings (the viewer id is base64url text).

/// v2 pairwise keys for one viewer. Same ECDH and salt as v1; the info binds the
/// viewer: `lp16("wsmp-term-v2") ‖ lp16(terminalId) ‖ lp16(viewerId) ‖ cliPub ‖ browserPub`.
pub fn derive_direction_keys_v2(
    cli_key: &CliTerminalKey,
    browser_public_raw: &[u8; 65],
    browser_nonce: &[u8; 16],
    cli_nonce: &[u8; 16],
    terminal_id: &str,
    viewer_id: &str,
) -> Result<DirectionKeys> {
    let ikm = cli_key.shared_x(browser_public_raw)?;
    derive_direction_keys_v2_from_ikm(
        &ikm,
        cli_key.public_raw(),
        browser_public_raw,
        browser_nonce,
        cli_nonce,
        terminal_id,
        viewer_id,
    )
}

pub fn derive_direction_keys_v2_from_ikm(
    ikm: &[u8; 32],
    cli_public_raw: &[u8; 65],
    browser_public_raw: &[u8; 65],
    browser_nonce: &[u8; 16],
    cli_nonce: &[u8; 16],
    terminal_id: &str,
    viewer_id: &str,
) -> Result<DirectionKeys> {
    let mut salt = [0_u8; 32];
    salt[..16].copy_from_slice(browser_nonce);
    salt[16..].copy_from_slice(cli_nonce);
    let mut info = Vec::new();
    push_length_prefixed(&mut info, HKDF_INFO_LABEL_V2)?;
    push_length_prefixed(&mut info, terminal_id.as_bytes())?;
    push_length_prefixed(&mut info, viewer_id.as_bytes())?;
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

/// Pairwise (unicast) v2 seal. Nonce `0^4 ‖ be64(seq)`.
pub fn seal_v2(
    key: &[u8; 32],
    terminal_id: &str,
    viewer_id: &str,
    direction: u8,
    seq: u64,
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let aad = aad_v2(terminal_id, viewer_id, direction, seq)?;
    aead_seal(key, &gcm_nonce(require_seq(seq)?), &aad, plaintext)
}

pub fn open_v2(
    key: &[u8; 32],
    terminal_id: &str,
    viewer_id: &str,
    direction: u8,
    seq: u64,
    ciphertext: &[u8],
) -> Result<Vec<u8>> {
    let aad = aad_v2(terminal_id, viewer_id, direction, seq)?;
    aead_open(key, &gcm_nonce(require_seq(seq)?), &aad, ciphertext)
}

/// Broadcast seal under the shared output key. Nonce `be32(epoch) ‖ be64(seq)`.
/// Callers must never reuse `(out_key, epoch, seq)`; a new epoch needs a new key.
pub fn seal_broadcast(
    out_key: &[u8; 32],
    terminal_id: &str,
    epoch: u32,
    seq: u64,
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let aad = broadcast_aad(terminal_id, epoch, seq)?;
    aead_seal(out_key, &broadcast_nonce(epoch, seq)?, &aad, plaintext)
}

pub fn open_broadcast(
    out_key: &[u8; 32],
    terminal_id: &str,
    epoch: u32,
    seq: u64,
    ciphertext: &[u8],
) -> Result<Vec<u8>> {
    let aad = broadcast_aad(terminal_id, epoch, seq)?;
    aead_open(out_key, &broadcast_nonce(epoch, seq)?, &aad, ciphertext)
}

/// A fresh 32-byte output key. Every epoch gets its own.
pub fn random_output_key() -> Result<[u8; 32]> {
    <[u8; 32]>::try_generate().context("generating a terminal output key")
}

fn require_seq(seq: u64) -> Result<u64> {
    if seq == 0 {
        anyhow::bail!("terminal seq starts at 1");
    }
    Ok(seq)
}

fn require_epoch(epoch: u32) -> Result<u32> {
    if epoch == 0 {
        anyhow::bail!("terminal output epoch starts at 1");
    }
    Ok(epoch)
}

fn broadcast_nonce(epoch: u32, seq: u64) -> Result<[u8; 12]> {
    let mut nonce = [0_u8; 12];
    nonce[..4].copy_from_slice(&require_epoch(epoch)?.to_be_bytes());
    nonce[4..].copy_from_slice(&require_seq(seq)?.to_be_bytes());
    Ok(nonce)
}

fn aad_v2(terminal_id: &str, viewer_id: &str, direction: u8, seq: u64) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    push_length_prefixed(&mut out, HKDF_INFO_LABEL_V2)?;
    push_length_prefixed(&mut out, terminal_id.as_bytes())?;
    push_length_prefixed(&mut out, viewer_id.as_bytes())?;
    out.push(direction);
    out.extend_from_slice(&seq.to_be_bytes());
    Ok(out)
}

fn broadcast_aad(terminal_id: &str, epoch: u32, seq: u64) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    push_length_prefixed(&mut out, BROADCAST_LABEL)?;
    push_length_prefixed(&mut out, terminal_id.as_bytes())?;
    out.extend_from_slice(&epoch.to_be_bytes());
    out.extend_from_slice(&seq.to_be_bytes());
    Ok(out)
}

fn aead_seal(key: &[u8; 32], nonce: &[u8; 12], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key).context("building the terminal cipher")?;
    let nonce = Nonce::try_from(nonce.as_slice()).context("building the terminal nonce")?;
    cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .context("sealing a terminal frame")
}

fn aead_open(key: &[u8; 32], nonce: &[u8; 12], aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key).context("building the terminal cipher")?;
    let nonce = Nonce::try_from(nonce.as_slice()).context("building the terminal nonce")?;
    cipher
        .decrypt(
            &nonce,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .context("opening a terminal frame")
}

/// v2 plaintexts. `0x01`/`0x02` match v1; `0x03` carries `be32(epoch) ‖ outKey`
/// and is only ever sent unicast. The v1 codec keeps rejecting `0x03`.
///
/// Supervised commands add `0x04` review toggle (`[0x04, on]`, browser to
/// CLI), `0x05` review capture (`[0x05] ‖ be64(total) ‖ be32(headLen) ‖ head
/// ‖ tail`, CLI to browser, unicast) and `0x06` review state (`[0x06, on]`).
#[derive(Debug, PartialEq, Eq)]
pub enum TermPlaintextV2 {
    Data(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
    },
    OutputKey {
        epoch: u32,
        key: [u8; 32],
    },
    ReviewToggle(bool),
    ReviewCapture {
        total: u64,
        head: Vec<u8>,
        tail: Vec<u8>,
    },
    ReviewState(bool),
}

fn flag_byte(bytes: &[u8]) -> Result<bool> {
    match bytes {
        [_, 0] => Ok(false),
        [_, 1] => Ok(true),
        _ => anyhow::bail!("terminal payload is invalid"),
    }
}

pub fn encode_plaintext_v2(message: &TermPlaintextV2) -> Result<Vec<u8>> {
    match message {
        TermPlaintextV2::Data(bytes) => encode_plaintext(&TermPlaintext::Data(bytes.clone())),
        TermPlaintextV2::Resize { cols, rows } => encode_plaintext(&TermPlaintext::Resize {
            cols: *cols,
            rows: *rows,
        }),
        TermPlaintextV2::OutputKey { epoch, key } => {
            let mut out = Vec::with_capacity(OUTPUT_KEY_PLAINTEXT_LEN);
            out.push(PLAINTEXT_OUTPUT_KEY);
            out.extend_from_slice(&require_epoch(*epoch)?.to_be_bytes());
            out.extend_from_slice(key);
            Ok(out)
        }
        TermPlaintextV2::ReviewToggle(on) => Ok(vec![PLAINTEXT_REVIEW_TOGGLE, u8::from(*on)]),
        TermPlaintextV2::ReviewState(on) => Ok(vec![PLAINTEXT_REVIEW_STATE, u8::from(*on)]),
        TermPlaintextV2::ReviewCapture { total, head, tail } => {
            if head.len() > CAPTURE_HEAD_MAX || tail.len() > CAPTURE_TAIL_MAX {
                anyhow::bail!("review capture is too large");
            }
            let head_len = u32::try_from(head.len()).context("review capture head")?;
            let mut out = Vec::with_capacity(REVIEW_CAPTURE_HEADER_LEN + head.len() + tail.len());
            out.push(PLAINTEXT_REVIEW_CAPTURE);
            out.extend_from_slice(&total.to_be_bytes());
            out.extend_from_slice(&head_len.to_be_bytes());
            out.extend_from_slice(head);
            out.extend_from_slice(tail);
            Ok(out)
        }
    }
}

pub fn decode_plaintext_v2(bytes: &[u8]) -> Result<TermPlaintextV2> {
    if bytes.first().copied() == Some(PLAINTEXT_OUTPUT_KEY) {
        if bytes.len() != OUTPUT_KEY_PLAINTEXT_LEN {
            anyhow::bail!("terminal payload is invalid");
        }
        let epoch = require_epoch(u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]))?;
        let key = copy_exact::<32>(&bytes[5..], "terminal output key")?;
        return Ok(TermPlaintextV2::OutputKey { epoch, key });
    }
    match bytes.first().copied() {
        Some(PLAINTEXT_REVIEW_TOGGLE) => {
            return Ok(TermPlaintextV2::ReviewToggle(flag_byte(bytes)?));
        }
        Some(PLAINTEXT_REVIEW_STATE) => return Ok(TermPlaintextV2::ReviewState(flag_byte(bytes)?)),
        Some(PLAINTEXT_REVIEW_CAPTURE) => {
            if bytes.len() < REVIEW_CAPTURE_HEADER_LEN {
                anyhow::bail!("terminal payload is invalid");
            }
            let mut total = [0_u8; 8];
            total.copy_from_slice(&bytes[1..9]);
            let total = u64::from_be_bytes(total);
            let head_len = u32::from_be_bytes([bytes[9], bytes[10], bytes[11], bytes[12]]) as usize;
            let rest = &bytes[REVIEW_CAPTURE_HEADER_LEN..];
            if head_len > rest.len()
                || head_len > CAPTURE_HEAD_MAX
                || rest.len() - head_len > CAPTURE_TAIL_MAX
            {
                anyhow::bail!("terminal payload is invalid");
            }
            return Ok(TermPlaintextV2::ReviewCapture {
                total,
                head: rest[..head_len].to_vec(),
                tail: rest[head_len..].to_vec(),
            });
        }
        _ => {}
    }
    Ok(match decode_plaintext(bytes)? {
        TermPlaintext::Data(bytes) => TermPlaintextV2::Data(bytes),
        TermPlaintext::Resize { cols, rows } => TermPlaintextV2::Resize { cols, rows },
    })
}

/// v1 transcript with `lp16(viewerId)` after the terminal id.
pub fn approval_transcript_v2(
    terminal_id: &str,
    viewer_id: &str,
    browser_public_raw: &[u8; 65],
    browser_nonce: &[u8; 16],
    cli_public_raw: &[u8; 65],
    cli_nonce: &[u8; 16],
) -> Result<Vec<u8>> {
    let mut transcript = Vec::new();
    push_length_prefixed(&mut transcript, APPROVAL_LABEL_V2)?;
    push_length_prefixed(&mut transcript, terminal_id.as_bytes())?;
    push_length_prefixed(&mut transcript, viewer_id.as_bytes())?;
    push_length_prefixed(&mut transcript, browser_public_raw)?;
    push_length_prefixed(&mut transcript, browser_nonce)?;
    push_length_prefixed(&mut transcript, cli_public_raw)?;
    push_length_prefixed(&mut transcript, cli_nonce)?;
    Ok(transcript)
}

#[allow(clippy::too_many_arguments)]
pub fn verify_approval_signature_v2(
    identity_public_raw: &[u8; 65],
    signature: &[u8],
    terminal_id: &str,
    viewer_id: &str,
    browser_public_raw: &[u8; 65],
    browser_nonce: &[u8; 16],
    cli_public_raw: &[u8; 65],
    cli_nonce: &[u8; 16],
) -> bool {
    let Ok(transcript) = approval_transcript_v2(
        terminal_id,
        viewer_id,
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

pub fn sign_approval_v2(
    signing_key: &SigningKey,
    terminal_id: &str,
    viewer_id: &str,
    browser_public_raw: &[u8; 65],
    browser_nonce: &[u8; 16],
    cli_public_raw: &[u8; 65],
    cli_nonce: &[u8; 16],
) -> Result<Vec<u8>> {
    let transcript = approval_transcript_v2(
        terminal_id,
        viewer_id,
        browser_public_raw,
        browser_nonce,
        cli_public_raw,
        cli_nonce,
    )?;
    let signature: Signature = signing_key.sign(&transcript);
    Ok(signature.to_bytes().to_vec())
}

// CLI identity pinning (protocol 2.5). A long-lived P-256 ECDSA key signs the
// per-start ECDH terminal key, so a relay cannot swap in its own ECDH key
// without the browser seeing a new identity.

/// `lp16("wsmp-term-cli-id-v1") ‖ lp16(cliId) ‖ ecdhPub(65)`. `cli_id` is the
/// CLI slug the hello reports (see `apps/cli/src/terminal_identity.rs`).
pub fn cli_identity_statement(cli_id: &str, ecdh_public_raw: &[u8; 65]) -> Result<Vec<u8>> {
    let mut statement = Vec::with_capacity(2 + CLI_IDENTITY_LABEL.len() + 2 + cli_id.len() + 65);
    push_length_prefixed(&mut statement, CLI_IDENTITY_LABEL)?;
    push_length_prefixed(&mut statement, cli_id.as_bytes())?;
    statement.extend_from_slice(ecdh_public_raw);
    Ok(statement)
}

/// A 64-byte IEEE P1363 (`r ‖ s`) signature over the identity statement.
pub fn sign_cli_identity(
    signing_key: &SigningKey,
    cli_id: &str,
    ecdh_public_raw: &[u8; 65],
) -> Result<Vec<u8>> {
    let statement = cli_identity_statement(cli_id, ecdh_public_raw)?;
    let signature: Signature = signing_key.sign(&statement);
    Ok(signature.to_bytes().to_vec())
}

pub fn verify_cli_identity(
    identity_public_raw: &[u8; 65],
    signature: &[u8],
    cli_id: &str,
    ecdh_public_raw: &[u8; 65],
) -> bool {
    let Ok(statement) = cli_identity_statement(cli_id, ecdh_public_raw) else {
        return false;
    };
    let Ok(verifying) = VerifyingKey::from_sec1_bytes(identity_public_raw) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(signature) else {
        return false;
    };
    verifying.verify(&statement, &signature).is_ok()
}

/// Base32 (RFC 4648, no padding) of the first 20 bytes of SHA-256(identity
/// public key), in space-separated groups of 4. 20 bytes give 32 characters.
pub fn identity_fingerprint(identity_public_raw: &[u8; 65]) -> String {
    let digest = Sha256::digest(identity_public_raw);
    let encoded = base32_nopad(&digest[..20]);
    encoded
        .as_bytes()
        .chunks(4)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

/// 65-byte uncompressed SEC1 point for an identity signing key.
pub fn identity_public_raw(signing_key: &SigningKey) -> Result<[u8; 65]> {
    let raw = copy_exact::<65>(
        signing_key.verifying_key().to_sec1_point(false).as_bytes(),
        "identity public key",
    )?;
    if raw[0] != 0x04 {
        anyhow::bail!("identity public key is not uncompressed");
    }
    Ok(raw)
}

fn copy_exact<const N: usize>(bytes: &[u8], what: &str) -> Result<[u8; N]> {
    bytes
        .try_into()
        .with_context(|| format!("{what} has the wrong length"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_plaintexts_round_trip_and_reject_bad_shapes() {
        for message in [
            TermPlaintextV2::ReviewToggle(true),
            TermPlaintextV2::ReviewToggle(false),
            TermPlaintextV2::ReviewState(true),
            TermPlaintextV2::ReviewCapture {
                total: 70_000,
                head: vec![b'h'; CAPTURE_HEAD_MAX],
                tail: vec![b't'; CAPTURE_TAIL_MAX],
            },
            TermPlaintextV2::ReviewCapture {
                total: 0,
                head: Vec::new(),
                tail: Vec::new(),
            },
        ] {
            let encoded = encode_plaintext_v2(&message).expect("encode");
            assert_eq!(decode_plaintext_v2(&encoded).expect("decode"), message);
        }
        assert_eq!(
            encode_plaintext_v2(&TermPlaintextV2::ReviewToggle(true)).expect("toggle"),
            vec![0x04, 1]
        );
        assert!(decode_plaintext_v2(&[0x04]).is_err());
        assert!(decode_plaintext_v2(&[0x04, 2]).is_err());
        assert!(decode_plaintext_v2(&[0x06, 1, 0]).is_err());
        assert!(decode_plaintext_v2(&[0x05, 0, 0]).is_err());
        let mut long_head = vec![0x05];
        long_head.extend_from_slice(&0_u64.to_be_bytes());
        long_head
            .extend_from_slice(&(u32::try_from(CAPTURE_HEAD_MAX + 1).expect("len")).to_be_bytes());
        long_head.extend(vec![0_u8; CAPTURE_HEAD_MAX + 1]);
        assert!(decode_plaintext_v2(&long_head).is_err());
        let mut past_end = vec![0x05];
        past_end.extend_from_slice(&0_u64.to_be_bytes());
        past_end.extend_from_slice(&5_u32.to_be_bytes());
        past_end.extend_from_slice(b"abc");
        assert!(decode_plaintext_v2(&past_end).is_err());
        assert!(
            encode_plaintext_v2(&TermPlaintextV2::ReviewCapture {
                total: 1,
                head: vec![0; CAPTURE_HEAD_MAX + 1],
                tail: Vec::new(),
            })
            .is_err()
        );
        // The v1 codec never accepts the supervised tags.
        assert!(decode_plaintext(&[0x04, 1]).is_err());
    }

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

    // Crypto v2 vectors. Mirrored in `apps/web/src/hooks/use-terminal-crypto.test.ts`.
    const VIEWER_A: &str = "AQIDBAUGBwgJCgsMDQ4PEA";
    const VIEWER_B: &str = "ERITFBUWFxgZGhscHR4fIA";
    const IDENTITY_SCALAR: &str =
        "5f2d1a6c3b4e8f7a9d0c1b2e3f4a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c";
    const APPROVAL_V2_TRANSCRIPT: &str = "001477736d702d7465726d2d617070726f76652d7632000d7465726d5f766563746f725f31001641514944424155474277674a4367734d445134504541004104d12dfb5289c8d4f81208b70270398c342296970a0bccb74c736fc7554494bf6356fbf3ca366cc23e8157854c13c58d6aac23f046ada30f8353e74f33039872ab001000112233445566778899aabbccddeeff004104dad0b65394221cf9b051e1feca5787d098dfe637fc90b9ef945d0c37725811805271a0461cdb8252d61f1c456fa3e59ab1f45b33accf5f58389e0577b8990bb30010ffeeddccbbaa99887766554433221100";
    // Deterministic (RFC 6979) p256 signature, verified by the web tests.
    const APPROVAL_V2_SIGNATURE_RUST: &str = "6b0c3ea676796d57c38e650c1b4d2f3efb348058de0649397ab3632aad07153111c73b5a92bce9f1ba9822c1f996768d81e32f6e21b77717435d891335c44079";
    // One randomized WebCrypto signature from the web tests.
    const APPROVAL_V2_SIGNATURE_WEB: &str = "0ac67c3ebfcc5257b6bd38492893c7e15225b3f78c38e4ae5dce074bf577c93579ed33bacb3f4e61d68131463d8f633f1269581e74325b8c8947bc7b712151b9";

    struct VectorV2 {
        cli: CliTerminalKey,
        browser: CliTerminalKey,
        browser_nonce: [u8; 16],
        cli_nonce: [u8; 16],
    }

    fn vector_v2() -> VectorV2 {
        VectorV2 {
            cli: CliTerminalKey::from_scalar_bytes(&hex(
                "c88f01f510d9ac3f70a292daa2316de544e9aab8afe84049c62a9c57862d1433",
            ))
            .expect("cli key"),
            browser: CliTerminalKey::from_scalar_bytes(&hex(
                "c6ef9c5d78ae012a011164acb397ce2088685d8f06bf9be0b283ab46476bee53",
            ))
            .expect("browser key"),
            browser_nonce: array("00112233445566778899aabbccddeeff"),
            cli_nonce: array("ffeeddccbbaa99887766554433221100"),
        }
    }

    fn keys_v2(vector: &VectorV2, viewer_id: &str) -> DirectionKeys {
        derive_direction_keys_v2(
            &vector.cli,
            vector.browser.public_raw(),
            &vector.browser_nonce,
            &vector.cli_nonce,
            "term_vector_1",
            viewer_id,
        )
        .expect("v2 keys")
    }

    fn out_key() -> [u8; 32] {
        std::array::from_fn(|index| 0xa0 + index as u8)
    }

    #[test]
    fn v2_keys_bind_the_viewer_id() {
        assert_eq!(
            encode_b64url(&std::array::from_fn::<u8, 16, _>(|i| i as u8 + 1)),
            VIEWER_A
        );
        assert_eq!(
            encode_b64url(&std::array::from_fn::<u8, 16, _>(|i| i as u8 + 17)),
            VIEWER_B
        );
        let vector = vector_v2();
        let a = keys_v2(&vector, VIEWER_A);
        assert_eq!(
            hex::encode_like(&a.browser_to_cli),
            "18d9eb864fb7002963cc992cb4fdf6be3d60f53439fb6fa1e5f772fd33535adf"
        );
        assert_eq!(
            hex::encode_like(&a.cli_to_browser),
            "ea07877ff03ae2c4624bc2d727be559a85d2ab897831c72e908b8f4156c02aa3"
        );
        let b = keys_v2(&vector, VIEWER_B);
        assert_eq!(
            hex::encode_like(&b.browser_to_cli),
            "1bf5fb8640685f2e550385d3dc380c600cf5b9065d715fc87d9773125e82f7e5"
        );
        assert_eq!(
            hex::encode_like(&b.cli_to_browser),
            "c5e0c6c04b496f7dd3e67a19baa9ad33f30f9121ad69d900209cad4049e645f4"
        );
    }

    #[test]
    fn v2_unicast_seals_match_the_browser() {
        let vector = vector_v2();
        let keys = keys_v2(&vector, VIEWER_A);
        let id = "term_vector_1";

        let data = seal_v2(
            &keys.browser_to_cli,
            id,
            VIEWER_A,
            DIR_BROWSER_TO_CLI,
            1,
            &hex("016869"),
        )
        .expect("seal data");
        assert_eq!(
            hex::encode_like(&data),
            "8db4cc4ef29fc34d932252a4c7c961d86a3fd7"
        );
        let opened = open_v2(
            &keys.browser_to_cli,
            id,
            VIEWER_A,
            DIR_BROWSER_TO_CLI,
            1,
            &data,
        )
        .expect("open data");
        assert_eq!(opened, hex("016869"));

        let resize = encode_plaintext_v2(&TermPlaintextV2::Resize { cols: 80, rows: 24 })
            .expect("encode resize");
        let sealed_resize = seal_v2(
            &keys.cli_to_browser,
            id,
            VIEWER_A,
            DIR_CLI_TO_BROWSER,
            1,
            &resize,
        )
        .expect("seal resize");
        assert_eq!(
            hex::encode_like(&sealed_resize),
            "6170ea15143be28521dee2eb18f299562f0a2c568b"
        );

        let key_plaintext = encode_plaintext_v2(&TermPlaintextV2::OutputKey {
            epoch: 1,
            key: out_key(),
        })
        .expect("encode key");
        assert_eq!(
            hex::encode_like(&key_plaintext),
            "0300000001a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf"
        );
        let key_frame = seal_v2(
            &keys.cli_to_browser,
            id,
            VIEWER_A,
            DIR_CLI_TO_BROWSER,
            2,
            &key_plaintext,
        )
        .expect("seal key");
        assert_eq!(
            hex::encode_like(&key_frame),
            "ec1e0c1a988a5751da40eb126b642620a3bbd7ba89b916829cd8c905faf171d294e801f3150c21f42bceb3ef5d7fdac87b2d650834"
        );
        let opened = open_v2(
            &keys.cli_to_browser,
            id,
            VIEWER_A,
            DIR_CLI_TO_BROWSER,
            2,
            &key_frame,
        )
        .expect("open key");
        match decode_plaintext_v2(&opened).expect("decode key") {
            TermPlaintextV2::OutputKey { epoch, key } => {
                assert_eq!(epoch, 1);
                assert_eq!(key, out_key());
            }
            _ => panic!("expected an output key"),
        }
    }

    #[test]
    fn broadcast_seal_matches_the_browser_and_binds_the_epoch() {
        let sealed = seal_broadcast(&out_key(), "term_vector_1", 1, 1, &hex("016869"))
            .expect("seal broadcast");
        assert_eq!(
            hex::encode_like(&sealed),
            "8bbad4ba419145525c441597e232569d485873"
        );
        let opened =
            open_broadcast(&out_key(), "term_vector_1", 1, 1, &sealed).expect("open broadcast");
        assert_eq!(opened, hex("016869"));
        assert!(open_broadcast(&out_key(), "term_vector_1", 2, 1, &sealed).is_err());
        assert!(open_broadcast(&out_key(), "term_vector_1", 0, 1, &sealed).is_err());
        assert!(seal_broadcast(&out_key(), "term_vector_1", 1, 0, &sealed).is_err());
        let fresh = random_output_key().expect("output key");
        assert_ne!(fresh, random_output_key().expect("second output key"));
    }

    #[test]
    fn v2_rejects_a_frame_under_another_viewers_key_or_aad() {
        let vector = vector_v2();
        let a = keys_v2(&vector, VIEWER_A);
        let b = keys_v2(&vector, VIEWER_B);
        let frame = seal_v2(
            &a.browser_to_cli,
            "term_vector_1",
            VIEWER_A,
            DIR_BROWSER_TO_CLI,
            1,
            &hex("016869"),
        )
        .expect("seal");
        assert!(
            open_v2(
                &b.browser_to_cli,
                "term_vector_1",
                VIEWER_A,
                DIR_BROWSER_TO_CLI,
                1,
                &frame
            )
            .is_err()
        );
        assert!(
            open_v2(
                &a.browser_to_cli,
                "term_vector_1",
                VIEWER_B,
                DIR_BROWSER_TO_CLI,
                1,
                &frame
            )
            .is_err()
        );
    }

    #[test]
    fn v2_length_prefixes_keep_shifted_ids_apart() {
        let left = aad_v2("ab", "c", DIR_BROWSER_TO_CLI, 1).expect("left");
        let right = aad_v2("a", "bc", DIR_BROWSER_TO_CLI, 1).expect("right");
        assert_eq!(
            hex::encode_like(&left),
            "000c77736d702d7465726d2d763200026162000163010000000000000001"
        );
        assert_ne!(left, right);
    }

    #[test]
    fn output_key_plaintext_rejects_bad_lengths_and_epoch_zero() {
        assert!(
            encode_plaintext_v2(&TermPlaintextV2::OutputKey {
                epoch: 0,
                key: out_key()
            })
            .is_err()
        );
        let encoded = encode_plaintext_v2(&TermPlaintextV2::OutputKey {
            epoch: 1,
            key: out_key(),
        })
        .expect("encode");
        assert!(decode_plaintext_v2(&encoded[..36]).is_err());
        let mut long = encoded.clone();
        long.push(0);
        assert!(decode_plaintext_v2(&long).is_err());
        let mut epoch_zero = encoded.clone();
        epoch_zero[4] = 0;
        assert!(decode_plaintext_v2(&epoch_zero).is_err());
        assert!(decode_plaintext(&encoded).is_err());
        assert!(matches!(
            decode_plaintext_v2(&hex("0200500018")).expect("resize"),
            TermPlaintextV2::Resize { cols: 80, rows: 24 }
        ));
    }

    #[test]
    fn v2_approval_transcript_and_signatures_match_the_browser() {
        let vector = vector_v2();
        let transcript = approval_transcript_v2(
            "term_vector_1",
            VIEWER_A,
            vector.browser.public_raw(),
            &vector.browser_nonce,
            vector.cli.public_raw(),
            &vector.cli_nonce,
        )
        .expect("transcript");
        assert_eq!(hex::encode_like(&transcript), APPROVAL_V2_TRANSCRIPT);

        let identity = SigningKey::from_slice(&hex(IDENTITY_SCALAR)).expect("identity");
        let identity_raw = copy_exact::<65>(
            identity.verifying_key().to_sec1_point(false).as_bytes(),
            "identity",
        )
        .expect("identity raw");
        let signature = sign_approval_v2(
            &identity,
            "term_vector_1",
            VIEWER_A,
            vector.browser.public_raw(),
            &vector.browser_nonce,
            vector.cli.public_raw(),
            &vector.cli_nonce,
        )
        .expect("sign");
        assert_eq!(hex::encode_like(&signature), APPROVAL_V2_SIGNATURE_RUST);

        let verify = |signature: &str, viewer_id: &str| {
            verify_approval_signature_v2(
                &identity_raw,
                &hex(signature),
                "term_vector_1",
                viewer_id,
                vector.browser.public_raw(),
                &vector.browser_nonce,
                vector.cli.public_raw(),
                &vector.cli_nonce,
            )
        };
        assert!(verify(APPROVAL_V2_SIGNATURE_RUST, VIEWER_A));
        assert!(verify(APPROVAL_V2_SIGNATURE_WEB, VIEWER_A));
        assert!(!verify(APPROVAL_V2_SIGNATURE_RUST, VIEWER_B));
        assert!(!verify(APPROVAL_V2_SIGNATURE_WEB, VIEWER_B));
        // A v1 signature over the same fields does not verify as v2.
        let v1 = sign_approval(
            &identity,
            "term_vector_1",
            vector.browser.public_raw(),
            &vector.browser_nonce,
            vector.cli.public_raw(),
            &vector.cli_nonce,
        )
        .expect("v1 sign");
        assert!(!verify(&hex::encode_like(&v1), VIEWER_A));
    }

    // CLI identity vectors. Mirrored in `apps/web/src/hooks/use-terminal-crypto.test.ts`.
    const CLI_ID_SLUG: &str = "desk-01";
    const CLI_ID_PUBLIC: &str =
        "BKY-mMGIyQrkQbdHpLC2Bkwv4JZwX7l3KzA4_gtn942ZrFQaA2B35fNmWvCS964gZtG7NjDNIbDwES_GuVhy6hY";
    const CLI_ID_STATEMENT: &str = "001377736d702d7465726d2d636c692d69642d763100076465736b2d303104dad0b65394221cf9b051e1feca5787d098dfe637fc90b9ef945d0c37725811805271a0461cdb8252d61f1c456fa3e59ab1f45b33accf5f58389e0577b8990bb3";
    // Deterministic (RFC 6979) p256 signature, verified by the web tests.
    const CLI_ID_SIGNATURE_RUST: &str = "605fffa5e3271aa6dcbf5a23e57a843c2e7c94399eea50331446c8183e5dfeedeac15186cde27a792ed704df722d2474a7902fc9a9ade88cba5f56c04f5a5624";
    // One randomized WebCrypto signature from the web tests.
    const CLI_ID_SIGNATURE_WEB: &str = "41d228ec04946ee19927954be52b2367823c911e99a9abac37cab3d7367ff82bdab3492d700e3976ca96ad5bc991a9948a1e38077d44f2136c2113da71b899c3";
    const CLI_ID_FINGERPRINT: &str = "EHI6 GLCX HTTU Q3DC VR2L P6WK K5PF OMMO";

    #[test]
    fn cli_identity_statement_signature_and_fingerprint_match_the_browser() {
        let vector = vector_v2();
        let cli_raw = vector.cli.public_raw();
        let identity = SigningKey::from_slice(&hex(IDENTITY_SCALAR)).expect("identity");
        let identity_raw = identity_public_raw(&identity).expect("identity raw");
        assert_eq!(encode_b64url(&identity_raw), CLI_ID_PUBLIC);

        let statement = cli_identity_statement(CLI_ID_SLUG, cli_raw).expect("statement");
        assert_eq!(hex::encode_like(&statement), CLI_ID_STATEMENT);

        let signature = sign_cli_identity(&identity, CLI_ID_SLUG, cli_raw).expect("sign");
        assert_eq!(hex::encode_like(&signature), CLI_ID_SIGNATURE_RUST);
        for signature in [CLI_ID_SIGNATURE_RUST, CLI_ID_SIGNATURE_WEB] {
            let signature = hex(signature);
            assert!(verify_cli_identity(
                &identity_raw,
                &signature,
                CLI_ID_SLUG,
                cli_raw
            ));
            assert!(!verify_cli_identity(
                &identity_raw,
                &signature,
                "desk-02",
                cli_raw
            ));
            assert!(!verify_cli_identity(
                &identity_raw,
                &signature,
                CLI_ID_SLUG,
                vector.browser.public_raw()
            ));
        }
        assert!(!verify_cli_identity(
            &identity_raw,
            &hex(CLI_ID_SIGNATURE_RUST)[1..],
            CLI_ID_SLUG,
            cli_raw
        ));
        assert_eq!(identity_fingerprint(&identity_raw), CLI_ID_FINGERPRINT);
    }

    mod hex {
        pub fn encode_like(bytes: &[u8]) -> String {
            bytes.iter().map(|byte| format!("{byte:02x}")).collect()
        }
    }
}
