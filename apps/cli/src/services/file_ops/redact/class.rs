//! Classification by path: the [`FileClass`] of a file from its folded
//! physical name, and the secret scopes (`.ssh`, the Hugging Face token
//! directories) whose every mutation is refused.

use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileClass {
    Plain,
    Dotenv,
    SshPrivateKey,
    PemKey,
    HfToken,
}

impl FileClass {
    /// Whether the file is secret by name (replacing it blindly would destroy
    /// values the caller cannot see).
    pub fn is_secret(self) -> bool {
        self != Self::Plain
    }

    /// Classes whose masking needs the whole file to be scanned, so they cannot
    /// be served from a windowed read of a file above the scan cap.
    pub fn needs_full_scan(self) -> bool {
        matches!(self, Self::SshPrivateKey | Self::PemKey | Self::Dotenv)
    }

    /// Whether serving a window from the middle of the file needs the lookback
    /// before it fed to the masker first: a multi-line value opened on an earlier
    /// line (any file), or a `.pem`/`.key` `PRIVATE KEY` block opened earlier,
    /// masks the following lines.
    pub fn needs_prefix(self) -> bool {
        !matches!(self, Self::SshPrivateKey | Self::HfToken)
    }
}

/// Fold a path for classification: Unicode lower-casing (the Kelvin sign
/// U+212A becomes `k`), then the ligature-style folds that case-insensitive
/// filesystems apply (`ſ` -> `s`, `ß`/`ẞ` -> `ss`), and no trailing dots or spaces. Everything is compared folded,
/// so a spelling that a casefold or normalization-insensitive volume resolves to
/// the secret file is classified as the secret file.
pub(crate) fn fold(name: &str) -> String {
    let lowered =
        name.to_lowercase()
            .chars()
            .fold(String::with_capacity(name.len()), |mut out, ch| {
                match ch {
                    'ſ' => out.push('s'),
                    'ß' | 'ẞ' => out.push_str("ss"),
                    // the Latin ligatures FB00-FB06 fold to their letters
                    '\u{FB00}' => out.push_str("ff"),
                    '\u{FB01}' => out.push_str("fi"),
                    '\u{FB02}' => out.push_str("fl"),
                    '\u{FB03}' => out.push_str("ffi"),
                    '\u{FB04}' => out.push_str("ffl"),
                    '\u{FB05}' | '\u{FB06}' => out.push_str("st"),
                    other => out.push(other),
                }
                out
            });
    // vfat and SMB shares resolve `prod.env.` and `prod.env ` to `prod.env`: drop
    // trailing dots and spaces from every component (`.` and `..` stay). Windows
    // paths separate components with `\` too.
    let separator = |ch: char| ch == '/' || (cfg!(windows) && ch == '\\');
    let mut out = String::with_capacity(lowered.len());
    let mut part = String::new();
    let flush = |part: &mut String, out: &mut String| {
        match part.as_str() {
            "." | ".." => out.push_str(part),
            _ => out.push_str(part.trim_end_matches(['.', ' '])),
        }
        part.clear();
    };
    for ch in lowered.chars() {
        if separator(ch) {
            flush(&mut part, &mut out);
            out.push(ch);
        } else {
            part.push(ch);
        }
    }
    flush(&mut part, &mut out);
    out
}

/// Classify by the physical path of the file. Names are compared folded
/// ([`fold`]) on every OS: a case-insensitive volume (macOS default, casefold
/// ext4, vfat) opens `ID_ED25519` or `.ENV` as the secret file, so the spelling
/// the caller typed must not decide the class. Over-masking a genuinely distinct
/// `.ENV` on a case-sensitive volume is the safe direction.
pub fn classify(path: &Path) -> FileClass {
    let lower = fold(&path.to_string_lossy());
    let lower = Path::new(&lower);
    let name = lower
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if name.starts_with("id_") && !name.ends_with(".pub") {
        return FileClass::SshPrivateKey;
    }
    // Any other file directly or transitively under `.ssh` is a private key unless
    // it is one of the known public/config files: keys are named at will
    // (`github_ed25519`, `deploy_key`).
    let in_ssh_dir = lower
        .parent()
        .is_some_and(|dir| dir.components().any(|c| c.as_os_str() == ".ssh"));
    if in_ssh_dir
        && !name.ends_with(".pub")
        && !name.starts_with("known_hosts")
        && !name.starts_with("authorized_keys")
        && name != "config"
    {
        return FileClass::SshPrivateKey;
    }
    // `token` and the `stored_tokens` INI that huggingface_hub writes next to it
    if [
        ".cache/huggingface/token",
        ".cache/huggingface/stored_tokens",
        ".huggingface/token",
        ".huggingface/stored_tokens",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix))
    {
        return FileClass::HfToken;
    }
    if name.ends_with(".pem") || name.ends_with(".key") {
        return FileClass::PemKey;
    }
    if name == ".env"
        || name == ".envrc"
        || name.ends_with(".env")
        || name.starts_with(".env.")
        || name == "service.env"
    {
        return FileClass::Dotenv;
    }
    FileClass::Plain
}

/// Whether `path` is a secret-class file, or a directory whose contents are
/// (`.ssh`, `.huggingface`, `.cache/huggingface`), or the `.cache` directory
/// that gives the Hugging Face token file its class. Secret files are read-only
/// through the file tools (masked view), so every mutation of such a path is
/// refused; decided from the path alone, never from the directory's contents.
pub fn is_secret_scope(path: &Path) -> bool {
    if classify(path).is_secret() {
        return true;
    }
    let lower = fold(&path.to_string_lossy());
    let names: Vec<&str> = Path::new(&lower)
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(n) => n.to_str(),
            _ => None,
        })
        .collect();
    if names.iter().any(|n| matches!(*n, ".ssh" | ".huggingface")) {
        return true;
    }
    if names
        .windows(2)
        .any(|w| w[0] == ".cache" && w[1] == "huggingface")
    {
        return true;
    }
    names.last() == Some(&".cache")
}
