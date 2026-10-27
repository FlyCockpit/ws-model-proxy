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
    /// With `path`, for a shell the browser does not quote for itself (Windows): the exact text
    /// to paste, quoted for the terminal's shell, with a trailing space.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paste: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ImageReply {
    pub fn rejected(id: &[u8; 16], error: &str) -> Self {
        Self {
            id: id_text(id),
            received: 0,
            path: None,
            paste: None,
            error: Some(error.to_string()),
        }
    }
}

/// How a terminal's shell takes a pasted image path.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub(crate) enum PasteQuoting {
    /// A POSIX shell (Unix terminals): `sh` quoting, which the browser applies itself.
    #[default]
    Posix,
    /// PowerShell: single quotes, in which nothing expands.
    PowerShell,
    /// Command Prompt: double quotes. A path with `%` is refused: cmd expands it even there.
    Cmd,
    /// A WSL distribution: the Windows path under the distribution's drive mount, `sh` quoted.
    Wsl { distro: String },
}

impl PasteQuoting {
    /// The quoting for a Windows terminal shell id (`crate::shells`).
    pub(crate) fn for_shell(id: &str) -> Option<Self> {
        match id {
            "pwsh" | "powershell" => Some(Self::PowerShell),
            "cmd" => Some(Self::Cmd),
            _ => id.strip_prefix("wsl:").map(|distro| Self::Wsl {
                distro: distro.to_string(),
            }),
        }
    }

    /// Whether the browser gets the text to paste in the reply: it quotes only POSIX paths.
    fn sends_text(&self) -> bool {
        *self != Self::Posix
    }
}

/// Characters no shell here reads specially in a word.
fn plain_word(path: &str) -> bool {
    path.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"_./\\:-".contains(&byte))
}

/// The text a PowerShell prompt takes `path` as (a trailing space).
fn powershell_paste(path: &str) -> String {
    if plain_word(path) {
        format!("{path} ")
    } else {
        format!("'{}' ", path.replace('\'', "''"))
    }
}

/// The text a Command Prompt takes `path` as; `None` for a path with `%` (or a quote, which a
/// Windows path cannot have).
fn cmd_paste(path: &str) -> Option<String> {
    if path.contains(['%', '"']) {
        None
    } else if plain_word(path) {
        Some(format!("{path} "))
    } else {
        Some(format!("\"{path}\" "))
    }
}

/// `C:\dir\image.png` under a WSL drive mount `root` (`/mnt/`): `/mnt/c/dir/image.png`.
fn wsl_path(root: &str, path: &str) -> Option<String> {
    let mut chars = path.chars();
    let drive = chars.next().filter(char::is_ascii_alphabetic)?;
    let rest = chars.as_str().strip_prefix(":\\")?;
    Some(format!(
        "{root}{}/{}",
        drive.to_ascii_lowercase(),
        rest.replace('\\', "/")
    ))
}

/// The drive mount root `[automount] root` sets in a WSL distribution's `/etc/wsl.conf`,
/// with a trailing `/`; `/mnt/` when it sets none (or nothing usable).
#[cfg_attr(not(windows), allow(dead_code))]
fn wsl_mount_root(conf: &str) -> String {
    let mut section = String::new();
    for line in conf.lines() {
        let line = line.trim();
        if let Some(name) = line
            .strip_prefix('[')
            .and_then(|line| line.strip_suffix(']'))
        {
            section = name.trim().to_ascii_lowercase();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if section != "automount" || !key.trim().eq_ignore_ascii_case("root") {
            continue;
        }
        let value = value
            .split('#')
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches('"');
        if value.starts_with('/')
            && value.len() <= 256
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_./-".contains(&byte))
        {
            return if value.ends_with('/') {
                value.to_string()
            } else {
                format!("{value}/")
            };
        }
    }
    "/mnt/".to_string()
}

/// A WSL distribution's drive mount root, read from Windows through its file share. The
/// share starts the distribution if it is not running; that happens on the image worker.
#[cfg(windows)]
fn read_wsl_mount_root(distro: &str) -> String {
    use std::io::Read;
    let conf = std::fs::File::open(format!(r"\\wsl.localhost\{distro}\etc\wsl.conf"))
        .ok()
        .and_then(|file| {
            let mut text = String::new();
            file.take(64 * 1024).read_to_string(&mut text).ok()?;
            Some(text)
        })
        .unwrap_or_default();
    wsl_mount_root(&conf)
}

#[cfg(not(windows))]
fn read_wsl_mount_root(_distro: &str) -> String {
    "/mnt/".to_string()
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
    quoting: PasteQuoting,
    /// A WSL terminal's drive mount root, read on the first upload.
    wsl_root: Option<String>,
}

impl TerminalImages {
    pub(crate) fn with_quoting(quoting: PasteQuoting) -> Self {
        Self {
            quoting,
            ..Self::default()
        }
    }

    /// The text the terminal's shell takes `path` as; `None` when it cannot take it.
    fn paste_for(&mut self, path: &str) -> Option<String> {
        match &self.quoting {
            PasteQuoting::Posix => Some(paste_text(path)),
            PasteQuoting::PowerShell => Some(powershell_paste(path)),
            PasteQuoting::Cmd => cmd_paste(path),
            PasteQuoting::Wsl { distro } => {
                let root = self
                    .wsl_root
                    .get_or_insert_with(|| read_wsl_mount_root(distro));
                wsl_path(root, path).map(|path| paste_text(&path))
            }
        }
    }

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
            let absolute = if cfg!(windows) {
                let bytes = path.as_bytes();
                bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":\\"
            } else {
                path.starts_with('/')
            };
            if !absolute
                || path.len() > 4000
                || !path.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
                || self
                    .paste_for(path)
                    .is_none_or(|text| text.len() > PASTE_MAX_BYTES - 12)
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
            paste: None,
            error: None,
        };
        if received == chunk.total {
            let upload = self.pending.remove(viewer).ok_or("invalid")?;
            let path = upload.file.path().to_str().ok_or("path")?.to_string();
            if self.quoting.sends_text() {
                reply.paste = Some(self.paste_for(&path).ok_or("path")?);
            }
            reply.path = Some(path);
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
        // A Windows node sends the text to paste, quoted for the terminal's shell.
        let windows: ImageReply =
            serde_json::from_value(fixture["windowsReply"].clone()).expect("windows reply");
        assert_eq!(
            serde_json::to_value(&windows).expect("serialize"),
            fixture["windowsReply"]
        );
        assert_eq!(
            windows.paste.as_deref(),
            Some(powershell_paste(windows.path.as_deref().expect("path")).as_str())
        );
    }

    #[test]
    fn each_windows_shell_takes_the_path_quoted_its_own_way() {
        let plain = r"C:\Users\ada\AppData\Local\Temp\wsmp-terminal-a\image-b.png";
        let spaced = r"C:\Users\Ada Lovelace\Temp\it's $HOME %PATH%.png";
        assert_eq!(powershell_paste(plain), format!("{plain} "));
        assert_eq!(
            powershell_paste(spaced),
            r"'C:\Users\Ada Lovelace\Temp\it''s $HOME %PATH%.png' "
        );
        assert_eq!(cmd_paste(plain), Some(format!("{plain} ")));
        assert_eq!(
            cmd_paste(r"C:\Users\Ada Lovelace\image.png").as_deref(),
            Some(r#""C:\Users\Ada Lovelace\image.png" "#)
        );
        // cmd expands `%` even inside quotes: no such path is pasted there.
        assert_eq!(cmd_paste(spaced), None);
        assert_eq!(
            wsl_path("/mnt/", r"D:\Temp\a b\image.png").as_deref(),
            Some("/mnt/d/Temp/a b/image.png")
        );
        assert_eq!(wsl_path("/mnt/", "/tmp/image.png"), None);
        assert_eq!(
            PasteQuoting::for_shell("wsl:Ubuntu"),
            Some(PasteQuoting::Wsl {
                distro: "Ubuntu".into()
            })
        );
        assert_eq!(PasteQuoting::for_shell("nushell"), None);
    }

    #[test]
    fn a_wsl_distribution_mounts_drives_where_its_wsl_conf_says() {
        assert_eq!(wsl_mount_root(""), "/mnt/");
        assert_eq!(
            wsl_mount_root("[boot]\nsystemd=true\n[automount]\nroot = /drives # mine\n"),
            "/drives/"
        );
        assert_eq!(wsl_mount_root("[Automount]\nRoot=\"/\"\n"), "/");
        // Only the automount section, and only a plain absolute path.
        assert_eq!(wsl_mount_root("[network]\nroot = /x/\n"), "/mnt/");
        assert_eq!(wsl_mount_root("[automount]\nroot = $(evil)\n"), "/mnt/");
    }

    /// The pasted text, typed at each shell's prompt, names the file: checked by the real shells.
    #[cfg(windows)]
    #[test]
    fn powershell_and_cmd_read_the_pasted_text_as_the_file() {
        use std::os::windows::process::CommandExt;
        let root = tempfile::tempdir().expect("dir");
        for name in ["plain", "with space", "it's $HOME"] {
            let dir = root.path().join(name);
            std::fs::create_dir(&dir).expect("dir");
            let file = dir.join("image.png");
            std::fs::write(&file, b"png").expect("file");
            let path = file.to_str().expect("path");
            for program in ["powershell", "pwsh"] {
                let Ok(status) = std::process::Command::new(program)
                    .args(["-NoProfile", "-NonInteractive", "-Command"])
                    .arg(format!(
                        "if (Test-Path -LiteralPath {}) {{ exit 0 }} else {{ exit 1 }}",
                        powershell_paste(path)
                    ))
                    .status()
                else {
                    continue;
                };
                assert!(status.success(), "{program}: {path}");
            }
            if let Some(text) = cmd_paste(path) {
                let status = std::process::Command::new("cmd")
                    .raw_arg(format!(
                        "/d /s /c \"if exist {text}(exit 0) else (exit 1)\""
                    ))
                    .status()
                    .expect("cmd");
                assert!(status.success(), "cmd: {path}");
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_upload_returns_the_text_its_shell_pastes() {
        for quoting in [
            PasteQuoting::PowerShell,
            PasteQuoting::Cmd,
            PasteQuoting::Wsl {
                distro: "wsmp-no-such-distribution".into(),
            },
        ] {
            let mut images = TerminalImages::with_quoting(quoting.clone());
            // Not read from `\\wsl.localhost`: a machine without WSL may take long to say so.
            images.wsl_root = Some("/mnt/".into());
            let reply = images.receive(
                "alice",
                ImageChunk {
                    id: [1; 16],
                    offset: 0,
                    total: 8,
                    format: 0,
                    data: b"\x89PNG\r\n\x1a\n".to_vec(),
                },
            );
            assert!(reply.error.is_none(), "{quoting:?}: {reply:?}");
            let path = reply.path.clone().expect("path");
            assert_eq!(std::fs::read(&path).expect("image"), b"\x89PNG\r\n\x1a\n");
            let expected = match &quoting {
                PasteQuoting::PowerShell => Some(powershell_paste(&path)),
                PasteQuoting::Cmd => cmd_paste(&path),
                _ => wsl_path("/mnt/", &path).map(|path| paste_text(&path)),
            };
            assert_eq!(reply.paste, expected, "{quoting:?}");
            drop(images);
            assert!(!std::path::Path::new(&path).exists());
        }
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
