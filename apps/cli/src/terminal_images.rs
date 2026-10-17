//! Encrypted image uploads. Files belong to the terminal, not the viewer: a path
//! paste does not acknowledge that an agent has opened the file yet.

use std::collections::BTreeMap;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use tempfile::{NamedTempFile, TempDir};

mod worker;
pub(crate) use worker::{ImagePending, ImageSession, ImageWorker};

pub const CAPABILITIES: u8 = 0x10;
pub const CHUNK: u8 = 0x11;
pub const REPLY: u8 = 0x12;
pub const PASTE: u8 = 0x13;
pub const CANCEL: u8 = 0x14;
pub const PASTE_MAX_BYTES: usize = 16 * 1024;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct ImagePaste {
    pub id: [u8; 16],
    pub data: Vec<u8>,
}

impl ImagePaste {
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.first() != Some(&PASTE) || bytes.len() <= 17 || bytes.len() > 17 + PASTE_MAX_BYTES
        {
            bail!("invalid image paste");
        }
        Ok(Self {
            id: bytes[1..17].try_into()?,
            data: bytes[17..].to_vec(),
        })
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        if self.data.is_empty() || self.data.len() > PASTE_MAX_BYTES {
            bail!("invalid image paste");
        }
        let mut bytes = vec![PASTE];
        bytes.extend(self.id);
        bytes.extend(&self.data);
        Ok(bytes)
    }
}

pub(crate) fn paste_text(path: &str) -> String {
    if path
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"_./-".contains(&byte))
    {
        format!("{path} ")
    } else {
        format!("'{}' ", path.replace('\'', "'\\''"))
    }
}
const SESSION_MAX_BYTES: usize = 32 * 1024 * 1024;
const SESSION_MAX_FILES: usize = 32;
const UPLOAD_IDLE: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq, Eq)]
pub struct ImageChunk {
    pub id: [u8; 16],
    pub total: u32,
    pub offset: u32,
    pub format: u8,
    pub data: Vec<u8>,
}

impl ImageChunk {
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() <= 26 || bytes.len() > 26 + CHUNK_BYTES || bytes[0] != CHUNK {
            bail!("invalid image chunk");
        }
        let chunk = Self {
            id: bytes[1..17].try_into()?,
            total: u32::from_be_bytes(bytes[17..21].try_into()?),
            offset: u32::from_be_bytes(bytes[21..25].try_into()?),
            format: bytes[25],
            data: bytes[26..].to_vec(),
        };
        chunk.validate()?;
        Ok(chunk)
    }

    fn validate(&self) -> Result<()> {
        if self.total == 0
            || self.total as usize > MAX_BYTES
            || self.offset as u64 + self.data.len() as u64 > u64::from(self.total)
            || self.data.is_empty()
            || self.data.len() > CHUNK_BYTES
            || self.format > 2
        {
            bail!("invalid image chunk");
        }
        Ok(())
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut bytes = Vec::with_capacity(26 + self.data.len());
        bytes.push(CHUNK);
        bytes.extend(self.id);
        bytes.extend(self.total.to_be_bytes());
        bytes.extend(self.offset.to_be_bytes());
        bytes.push(self.format);
        bytes.extend(&self.data);
        Ok(bytes)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageReply {
    pub id: String,
    pub received: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ImageReply {
    pub fn rejected(id: &[u8; 16], error: &str) -> Self {
        Self {
            id: id_text(id),
            received: 0,
            path: None,
            error: Some(error.to_string()),
        }
    }
}

fn id_text(id: &[u8; 16]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(32);
    for byte in id {
        text.push(char::from(HEX[usize::from(byte >> 4)]));
        text.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    text
}

struct Upload {
    id: [u8; 16],
    total: u32,
    received: u32,
    format: u8,
    file: NamedTempFile,
    touched: Instant,
}

/// Worker-owned files. Dropping this storage removes its files and directory;
/// the relay only retires the corresponding session/viewer cancellation flags.
#[derive(Default)]
pub(crate) struct TerminalImages {
    // Drop files before the directory (fields drop in declaration order).
    pending: BTreeMap<String, Upload>,
    saved: Vec<(NamedTempFile, usize)>,
    directory: Option<TempDir>,
    saved_bytes: usize,
}

impl TerminalImages {
    pub(crate) fn detach(&mut self, viewer: &str) {
        self.pending.remove(viewer);
    }

    pub(crate) fn expire(&mut self, now: Instant) {
        self.pending
            .retain(|_, upload| now.saturating_duration_since(upload.touched) < UPLOAD_IDLE);
    }

    pub(crate) fn receive(&mut self, viewer: &str, chunk: ImageChunk) -> ImageReply {
        // Called only by the image worker: all file creation, writes, expiry,
        // and destructors stay off the relay loop.
        self.expire(Instant::now());
        let id = chunk.id;
        match self.receive_inner(viewer, chunk) {
            Ok(reply) => reply,
            Err(reason) => {
                self.pending.remove(viewer);
                ImageReply::rejected(&id, reason)
            }
        }
    }

    fn receive_inner(
        &mut self,
        viewer: &str,
        chunk: ImageChunk,
    ) -> Result<ImageReply, &'static str> {
        chunk.validate().map_err(|_| "invalid")?;
        if chunk.offset == 0 {
            // A retry replaces only this viewer's incomplete upload. A lost
            // acknowledgement must not force them to wait for expiry first.
            self.pending.remove(viewer);
            let reserved: usize = self
                .pending
                .values()
                .map(|upload| upload.total as usize)
                .sum();
            if self.saved.len() + self.pending.len() >= SESSION_MAX_FILES
                || self.saved_bytes + reserved + chunk.total as usize > SESSION_MAX_BYTES
            {
                return Err("limit");
            }
            let valid_header = match chunk.format {
                0 => chunk.data.starts_with(b"\x89PNG\r\n\x1a\n"),
                1 => chunk.data.starts_with(b"\xff\xd8\xff"),
                2 => chunk.data.starts_with(b"RIFF") && chunk.data.get(8..12) == Some(b"WEBP"),
                _ => false,
            };
            if !valid_header {
                return Err("unsupported");
            }
            if self.directory.is_none() {
                let mut builder = tempfile::Builder::new();
                builder.prefix("wsmp-terminal-");
                #[cfg(unix)]
                builder.permissions(std::fs::Permissions::from_mode(0o700));
                self.directory = Some(builder.tempdir().map_err(|_| "io")?);
            }
            let directory = self.directory.as_ref().ok_or("io")?;
            let suffix = match chunk.format {
                0 => ".png",
                1 => ".jpg",
                _ => ".webp",
            };
            let file = tempfile::Builder::new()
                .prefix("image-")
                .suffix(suffix)
                .tempfile_in(directory.path())
                .map_err(|_| "io")?;
            // Reject paths that could inject terminal controls or locale-dependent bytes.
            let path = file.path().to_str().ok_or("path")?;
            if !path.starts_with('/')
                || path.len() > 4000
                || !path.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
            {
                return Err("path");
            }
            self.pending.insert(
                viewer.to_string(),
                Upload {
                    id: chunk.id,
                    total: chunk.total,
                    received: 0,
                    format: chunk.format,
                    file,
                    touched: Instant::now(),
                },
            );
        }
        let upload = self.pending.get_mut(viewer).ok_or("invalid")?;
        if upload.id != chunk.id
            || upload.total != chunk.total
            || upload.format != chunk.format
            || upload.received != chunk.offset
        {
            return Err("invalid");
        }
        upload.file.write_all(&chunk.data).map_err(|_| "io")?;
        upload.received += chunk.data.len() as u32;
        upload.touched = Instant::now();
        let received = upload.received;
        let mut reply = ImageReply {
            id: id_text(&chunk.id),
            received,
            path: None,
            error: None,
        };
        if received == chunk.total {
            let upload = self.pending.remove(viewer).ok_or("invalid")?;
            reply.path = Some(upload.file.path().to_str().ok_or("path")?.to_string());
            self.saved_bytes += chunk.total as usize;
            self.saved.push((upload.file, chunk.total as usize));
        }
        Ok(reply)
    }

    fn reserved_bytes(&self) -> usize {
        self.saved_bytes
            + self
                .pending
                .values()
                .map(|upload| upload.total as usize)
                .sum::<usize>()
    }

    fn file_count(&self) -> usize {
        self.saved.len() + self.pending.len()
    }

    /// The requester disappeared while its file operation was running.
    /// Only remove the file created by this reply, never a previously pasted image.
    fn cancel_reply(&mut self, viewer: &str, reply: &ImageReply) {
        self.detach(viewer);
        if let Some(path) = &reply.path
            && let Some(index) = self
                .saved
                .iter()
                .position(|(file, _)| file.path().to_str() == Some(path.as_str()))
        {
            let (file, size) = self.saved.swap_remove(index);
            self.saved_bytes -= size;
            drop(file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from_hex(value: &str) -> Vec<u8> {
        (0..value.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&value[at..at + 2], 16).expect("hex fixture"))
            .collect()
    }

    #[test]
    fn shared_browser_wire_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/config/src/terminal-image-vectors.json"
        ))
        .expect("fixture");
        let bytes = from_hex(fixture["chunk"]["plaintextHex"].as_str().expect("hex"));
        let chunk = ImageChunk::decode(&bytes).expect("chunk");
        assert_eq!(chunk.encode().expect("encode"), bytes);
        assert_eq!(chunk.total, 8);
        assert_eq!(chunk.offset, 0);
        assert_eq!(
            id_text(&chunk.id),
            fixture["chunk"]["id"].as_str().expect("id")
        );
        assert_eq!(
            chunk.data,
            from_hex(fixture["chunk"]["dataHex"].as_str().expect("data"))
        );
        let reply: ImageReply = serde_json::from_value(fixture["reply"].clone()).expect("reply");
        assert_eq!(
            serde_json::to_value(reply).expect("serialize"),
            fixture["reply"]
        );
        let paste_bytes = from_hex(fixture["paste"]["plaintextHex"].as_str().expect("paste"));
        let paste = ImagePaste::decode(&paste_bytes).expect("paste");
        assert_eq!(paste.encode().expect("encode paste"), paste_bytes);
        assert_eq!(
            paste.data,
            fixture["paste"]["text"].as_str().expect("text").as_bytes()
        );
        assert!(matches!(
            crate::terminal_crypto::decode_plaintext_v2(&from_hex(
                fixture["cancelHex"].as_str().expect("cancel")
            )),
            Ok(crate::terminal_crypto::TermPlaintextV2::ImageCancel(_))
        ));
    }

    #[cfg(unix)]
    fn chunk(id: u8, offset: u32, total: u32, bytes: &[u8]) -> ImageChunk {
        ImageChunk {
            id: [id; 16],
            offset,
            total,
            format: 0,
            data: bytes.to_vec(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn completed_file_survives_detach_and_is_removed_when_terminal_ends() {
        let mut images = TerminalImages::default();
        let reply = images.receive("alice", chunk(1, 0, 8, b"\x89PNG\r\n\x1a\n"));
        assert!(reply.error.is_none());
        let path = std::path::PathBuf::from(reply.path.expect("saved path"));
        let parent = path.parent().expect("parent").to_path_buf();
        assert_eq!(std::fs::read(&path).expect("image"), b"\x89PNG\r\n\x1a\n");
        assert_eq!(
            std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&parent)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        images.detach("alice");
        images.expire(Instant::now() + UPLOAD_IDLE);
        assert!(path.exists());
        drop(images);
        assert!(!path.exists());
        assert!(!parent.exists());
    }

    #[cfg(unix)]
    #[test]
    fn unfinished_uploads_are_isolated_and_expire() {
        let mut images = TerminalImages::default();
        let first = images.receive("alice", chunk(1, 0, 12, b"\x89PNG\r\n\x1a\n"));
        assert_eq!(first.received, 8);
        assert!(first.path.is_none());
        // Another viewer cannot append to Alice's upload even knowing its ID.
        assert_eq!(
            images
                .receive("bob", chunk(1, 8, 12, b"tail"))
                .error
                .as_deref(),
            Some("invalid")
        );
        let path = images
            .pending
            .get("alice")
            .expect("upload")
            .file
            .path()
            .to_path_buf();
        images.expire(Instant::now() + UPLOAD_IDLE);
        assert!(!path.exists());
        assert!(images.pending.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn missing_chunk_rejects_and_deletes_partial_file() {
        let mut images = TerminalImages::default();
        images.receive("alice", chunk(1, 0, 16, b"\x89PNG\r\n\x1a\n"));
        let path = images
            .pending
            .get("alice")
            .expect("upload")
            .file
            .path()
            .to_path_buf();
        assert_eq!(
            images
                .receive("alice", chunk(1, 12, 16, b"tail"))
                .error
                .as_deref(),
            Some("invalid")
        );
        assert!(!path.exists());
    }
}
