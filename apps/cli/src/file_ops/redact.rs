//! Secret masking for file content (plan sections 3.4 and 11, D5 as narrowed
//! by the owner).
//!
//! What is masked, and nothing else:
//!
//! 1. SSH private keys: files named `id_*` (not `*.pub`) are masked whole, and
//!    `*.pem` / `*.key` files have their `PRIVATE KEY` blocks masked.
//! 2. Environment variables: every assignment in dotenv-shaped files
//!    (`.env`, `*.env`, `.env.*`, `.envrc`, `service.env`), and in any file the
//!    secret-named assignments (`NAME=value`, `NAME: value`,
//!    `Environment=NAME=value`, compose `environment:` entries) whose upper-case
//!    name ends in `_TOKEN`, `_KEY`, `_SECRET`, or `PASSWORD`.
//! 3. The Hugging Face token file (`~/.cache/huggingface/token`,
//!    `~/.huggingface/token`) and the values of `--api-key`, `--hf-token`,
//!    `--token`, `--password`, `--secret`-style command-line flags, including a
//!    value on the following line (`\` continuation or a YAML/JSON list item).
//!
//! There is deliberately no vendor-prefix scanner and no cloud-credential list.
//!
//! Masking is applied to the whole text before any windowing, so a cut never
//! shows half a secret. It never adds or removes a line: every replacement stays
//! on its line (a masked block replaces each line), so line numbers in the
//! masked view are line numbers in the real file. The masked view is the only
//! text the edit engine matches against, which means an edit cannot probe a
//! masked value, and an edit whose range touches a masked span is refused.

use std::ops::Range;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

/// Prefix of every mask token. Content carrying it is refused on write.
pub const MASK_OPEN: &str = "\u{27E6}redacted";
const MASK_CLOSE: &str = "\u{27E7}";

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
}

/// Classify by the physical path of the file.
pub fn classify(path: &Path) -> FileClass {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if name.starts_with("id_") && !name.ends_with(".pub") {
        return FileClass::SshPrivateKey;
    }
    if path.ends_with(".cache/huggingface/token") || path.ends_with(".huggingface/token") {
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

/// One masked region: its byte range in the masked view and in the real text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub view: Range<usize>,
    pub orig: Range<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaskedView {
    pub text: String,
    pub spans: Vec<Span>,
}

impl MaskedView {
    pub fn redactions(&self) -> usize {
        self.spans.len()
    }

    /// Whether `range` (masked-view bytes) overlaps a masked span. An empty
    /// range overlaps only when strictly inside a span.
    pub fn overlaps_span(&self, range: &Range<usize>) -> bool {
        self.spans.iter().any(|span| {
            if range.start == range.end {
                range.start > span.view.start && range.start < span.view.end
            } else {
                range.start < span.view.end && span.view.start < range.end
            }
        })
    }

    /// Count of spans whose masked-view range starts inside `range`.
    pub fn spans_in(&self, range: &Range<usize>) -> usize {
        self.spans
            .iter()
            .filter(|s| s.view.start >= range.start && s.view.start < range.end)
            .count()
    }

    /// Map a masked-view position that is not strictly inside a span to the
    /// same position in the real text.
    pub fn to_orig(&self, pos: usize) -> usize {
        let mut delta: isize = 0;
        for span in &self.spans {
            if span.view.end <= pos {
                delta += span.orig.len() as isize - span.view.len() as isize;
            }
        }
        (pos as isize + delta) as usize
    }
}

fn token(chars: usize) -> String {
    format!("{MASK_OPEN}:{chars}{MASK_CLOSE}")
}

fn token_bare() -> String {
    format!("{MASK_OPEN}{MASK_CLOSE}")
}

const SECRET_FLAGS: &str =
    "api[-_]key|hf[-_]token|token|auth[-_]token|access[-_]token|password|secret";

static ASSIGN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"([A-Z][A-Z0-9_]*(?:_TOKEN|_KEY|_SECRET|PASSWORD))["']?[ \t]*([=:])[ \t]*"#)
        .expect("assignment regex")
});
static FLAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?:^|[\s"'\[,=(])--(?:{SECRET_FLAGS})(=|[ \t]+|["']?,[ \t]*)"#
    ))
    .expect("flag regex")
});
static FLAG_AT_END: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?:^|[\s"'\[,=(])--(?:{SECRET_FLAGS})["']?,?[ \t]*\\?[ \t]*$"#
    ))
    .expect("flag-at-end regex")
});
static DOTENV_ASSIGN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_.\-]*[ \t]*=[ \t]*")
        .expect("dotenv regex")
});

fn is_variable_reference(value: &str) -> bool {
    let inner = if let Some(rest) = value.strip_prefix("${") {
        match rest.strip_suffix('}') {
            Some(inner) => inner,
            None => return false,
        }
    } else if let Some(rest) = value.strip_prefix('$') {
        rest
    } else {
        return false;
    };
    let mut chars = inner.chars();
    match chars.next() {
        Some(c) if c.is_ascii_uppercase() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// End (exclusive) of the value that starts at `start` in `line`.
/// `enclosing` is the quote character directly before the name, if any: the
/// assignment sits inside a quoted string that the value must not swallow.
fn value_end(line: &str, start: usize, enclosing: Option<char>) -> usize {
    let rest = &line[start..];
    let mut chars = rest.char_indices();
    match chars.next() {
        None => start,
        Some((_, quote @ ('"' | '\''))) => {
            let mut escaped = false;
            for (idx, ch) in chars {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == quote {
                    return start + idx + ch.len_utf8();
                }
            }
            line.len()
        }
        Some(_) => {
            for (idx, ch) in rest.char_indices() {
                if ch.is_whitespace() || Some(ch) == enclosing {
                    return start + idx;
                }
            }
            line.len()
        }
    }
}

fn enclosing_quote(line: &str, name_start: usize) -> Option<char> {
    line[..name_start]
        .chars()
        .next_back()
        .filter(|c| *c == '"' || *c == '\'')
}

/// Whether the value text is a bare variable reference or empty quotes.
fn value_is_public(value: &str) -> bool {
    // A lone backslash is a shell line continuation, not a value.
    value.is_empty()
        || value == "\\"
        || value == "\"\""
        || value == "''"
        || is_variable_reference(value.trim_matches(|c| c == '"' || c == '\''))
}

type LineMask = (Range<usize>, String);

fn generic_line_masks(line: &str, out: &mut Vec<LineMask>) {
    if line.contains("TOKEN")
        || line.contains("KEY")
        || line.contains("SECRET")
        || line.contains("PASSWORD")
    {
        for caps in ASSIGN.captures_iter(line) {
            let (Some(name), Some(sep), Some(whole)) = (caps.get(1), caps.get(2), caps.get(0))
            else {
                continue;
            };
            let after = &line[whole.end()..];
            if sep.as_str() == "=" && after.starts_with('=') {
                continue;
            }
            if sep.as_str() == ":" && (after.starts_with(':') || whole.end() == sep.end()) {
                // `NAME::x` or `NAME:value` (no space): not a YAML mapping value.
                if whole.end() == sep.end() && !after.is_empty() {
                    continue;
                }
            }
            let end = value_end(line, whole.end(), enclosing_quote(line, name.start()));
            let value = &line[whole.end()..end];
            if value_is_public(value) {
                continue;
            }
            out.push((whole.end()..end, token(value.chars().count())));
        }
    }
    if line.contains("--") {
        for caps in FLAG.captures_iter(line) {
            let (Some(sep), Some(whole)) = (caps.get(1), caps.get(0)) else {
                continue;
            };
            let start = whole.end();
            if sep.as_str() != "=" && line[start..].starts_with('-') {
                continue;
            }
            let flag_start = whole.start();
            let enclosing = enclosing_quote(line, flag_start + 1);
            let end = value_end(line, start, enclosing);
            let value = &line[start..end];
            if value_is_public(value) {
                continue;
            }
            out.push((start..end, token(value.chars().count())));
        }
    }
}

fn merge(mut masks: Vec<LineMask>, line: &str) -> Vec<LineMask> {
    masks.sort_by_key(|(range, _)| (range.start, range.end));
    let mut merged: Vec<LineMask> = Vec::with_capacity(masks.len());
    for (range, tok) in masks {
        if let Some((last, last_tok)) = merged.last_mut()
            && range.start < last.end
        {
            if range.end > last.end {
                last.end = range.end;
            }
            *last_tok = token(line[last.clone()].chars().count());
            continue;
        }
        merged.push((range, tok));
    }
    merged
}

/// First value token on a continuation line (a flag value or a list item).
fn continuation_value(line: &str) -> Option<Range<usize>> {
    let trimmed_start = line.len() - line.trim_start().len();
    let mut start = trimmed_start;
    if line[start..].starts_with("- ") {
        start += 2;
        start += line[start..].len() - line[start..].trim_start().len();
    }
    if start >= line.len() || line[start..].starts_with('-') {
        return None;
    }
    let end = value_end(line, start, None);
    let value = &line[start..end];
    if value_is_public(value) {
        return None;
    }
    Some(start..end)
}

static TRIGGER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("TOKEN|KEY|SECRET|PASSWORD|--").expect("trigger regex"));

/// Line-oriented masker. Feed lines (without terminators) in file order; the
/// only state carried between lines is a `PRIVATE KEY` block flag and a
/// "previous line ended with a secret flag" flag, so a caller that serves a
/// window needs at most one line of context before it (or the whole file for a
/// `.pem`/`.key` file, which is name-classified and small). Command-output
/// masking (a later phase) reuses this as a streaming scanner.
#[derive(Debug, Clone)]
pub struct LineMasker {
    class: FileClass,
    in_private_block: bool,
    pending_flag_value: bool,
}

impl LineMasker {
    pub fn new(class: FileClass) -> Self {
        Self {
            class,
            in_private_block: false,
            pending_flag_value: false,
        }
    }

    /// Masked ranges of `line` (byte ranges in `line` plus their replacement
    /// text), sorted and non-overlapping. Advances the state.
    pub fn scan(&mut self, line: &str) -> Vec<(Range<usize>, String)> {
        let mut masks: Vec<LineMask> = Vec::new();
        match self.class {
            FileClass::SshPrivateKey => {
                if !line.trim().is_empty() {
                    masks.push((0..line.len(), token_bare()));
                }
            }
            FileClass::HfToken => {
                if !line.trim().is_empty() {
                    masks.push((0..line.len(), token(line.chars().count())));
                }
            }
            FileClass::PemKey => {
                if line.contains("-----BEGIN") && line.contains("PRIVATE KEY-----") {
                    self.in_private_block = true;
                }
                if self.in_private_block {
                    masks.push((0..line.len(), token_bare()));
                    if line.contains("-----END") && line.contains("PRIVATE KEY-----") {
                        self.in_private_block = false;
                    }
                }
            }
            FileClass::Dotenv => {
                if let Some(m) = DOTENV_ASSIGN.find(line) {
                    let end = line.trim_end().len();
                    if end > m.end() {
                        masks.push((m.end()..end, token(line[m.end()..end].chars().count())));
                    }
                }
            }
            FileClass::Plain => {}
        }
        if !(self.class == FileClass::PemKey && self.in_private_block) {
            if self.pending_flag_value
                && let Some(range) = continuation_value(line)
            {
                masks.push((range.clone(), token(line[range].chars().count())));
            }
            if TRIGGER.is_match(line) {
                generic_line_masks(line, &mut masks);
            }
        }
        self.pending_flag_value = line.contains("--") && FLAG_AT_END.is_match(line);
        if masks.is_empty() {
            masks
        } else {
            merge(masks, line)
        }
    }

    /// `line` with its secrets replaced; borrowed when nothing was masked.
    pub fn mask_line<'a>(&mut self, line: &'a str) -> std::borrow::Cow<'a, str> {
        self.mask_line_counted(line).0
    }

    /// Like [`Self::mask_line`], also returning how many spans were masked.
    pub fn mask_line_counted<'a>(&mut self, line: &'a str) -> (std::borrow::Cow<'a, str>, usize) {
        let masks = self.scan(line);
        if masks.is_empty() {
            return (std::borrow::Cow::Borrowed(line), 0);
        }
        let count = masks.len();
        let mut out = String::with_capacity(line.len());
        let mut cursor = 0;
        for (range, tok) in masks {
            out.push_str(&line[cursor..range.start]);
            out.push_str(&tok);
            cursor = range.end;
        }
        out.push_str(&line[cursor..]);
        (std::borrow::Cow::Owned(out), count)
    }
}

/// Mask `text` (the real file content) for `class`. Used by the edit engine,
/// which needs the whole masked view; reads mask only the lines they return.
pub fn mask(class: FileClass, text: &str) -> MaskedView {
    if class == FileClass::Plain && !TRIGGER.is_match(text) {
        return MaskedView {
            text: text.to_string(),
            spans: Vec::new(),
        };
    }
    let mut masker = LineMasker::new(class);
    let mut out = String::with_capacity(text.len());
    let mut spans = Vec::new();
    let mut offset = 0;
    for raw in text.split_inclusive('\n') {
        let body_len = raw.trim_end_matches(['\n', '\r']).len();
        let (line, ending) = raw.split_at(body_len);
        let mut cursor = 0;
        for (range, tok) in masker.scan(line) {
            out.push_str(&line[cursor..range.start]);
            let view_start = out.len();
            out.push_str(&tok);
            spans.push(Span {
                view: view_start..out.len(),
                orig: offset + range.start..offset + range.end,
            });
            cursor = range.end;
        }
        out.push_str(&line[cursor..]);
        out.push_str(ending);
        offset += raw.len();
    }
    MaskedView { text: out, spans }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(class: FileClass, text: &str) -> String {
        mask(class, text).text
    }

    /// Every row: (class, input, exact masked output). Adversarial rows cover
    /// quoting, whitespace, CRLF, multiple assignments per line, references,
    /// look-alikes that must stay visible, and continuation lines.
    #[test]
    fn masking_table() {
        use FileClass::{Dotenv, HfToken, PemKey, Plain, SshPrivateKey};
        let rows: &[(FileClass, &str, &str)] = &[
            // dotenv shape: every assignment masked, names and comments visible
            (
                Dotenv,
                "HF_TOKEN=abc123\n",
                "HF_TOKEN=\u{27E6}redacted:6\u{27E7}\n",
            ),
            (Dotenv, "PORT=8080\n", "PORT=\u{27E6}redacted:4\u{27E7}\n"),
            (Dotenv, "# comment\n\n", "# comment\n\n"),
            (
                Dotenv,
                "export A = \"x y z\"\n",
                "export A = \u{27E6}redacted:7\u{27E7}\n",
            ),
            (
                Dotenv,
                "A='multi word value'  \n",
                "A=\u{27E6}redacted:18\u{27E7}  \n",
            ),
            (
                Dotenv,
                "A=\r\nB=x\r\n",
                "A=\r\nB=\u{27E6}redacted:1\u{27E7}\r\n",
            ),
            (Dotenv, "A=b=c=d\n", "A=\u{27E6}redacted:5\u{27E7}\n"),
            (Dotenv, "A=$abc\n", "A=\u{27E6}redacted:4\u{27E7}\n"),
            (
                Dotenv,
                "  KEY.NAME-1=v\n",
                "  KEY.NAME-1=\u{27E6}redacted:1\u{27E7}\n",
            ),
            (
                Dotenv,
                "# OLD_API_KEY=sk-live-xyz\n",
                "# OLD_API_KEY=\u{27E6}redacted:11\u{27E7}\n",
            ),
            (Dotenv, "A=\u{e9}\u{e9}\n", "A=\u{27E6}redacted:2\u{27E7}\n"),
            (
                Dotenv,
                "no_trailing_newline=x",
                "no_trailing_newline=\u{27E6}redacted:1\u{27E7}",
            ),
            // generic env rule in any file
            (
                Plain,
                "export HF_TOKEN=hf_abc\n",
                "export HF_TOKEN=\u{27E6}redacted:6\u{27E7}\n",
            ),
            (
                Plain,
                "DB_PASSWORD: s3cr3t\n",
                "DB_PASSWORD: \u{27E6}redacted:6\u{27E7}\n",
            ),
            (
                Plain,
                "Environment=API_KEY=abc\n",
                "Environment=API_KEY=\u{27E6}redacted:3\u{27E7}\n",
            ),
            (
                Plain,
                "Environment=\"API_KEY=abc\"\n",
                "Environment=\"API_KEY=\u{27E6}redacted:3\u{27E7}\"\n",
            ),
            (
                Plain,
                "  - HF_TOKEN=abc\n",
                "  - HF_TOKEN=\u{27E6}redacted:3\u{27E7}\n",
            ),
            (
                Plain,
                "  HF_TOKEN: \"quoted value\"\n",
                "  HF_TOKEN: \u{27E6}redacted:14\u{27E7}\n",
            ),
            (
                Plain,
                "\"HF_TOKEN\": \"abc\",\n",
                "\"HF_TOKEN\": \u{27E6}redacted:5\u{27E7},\n",
            ),
            (
                Plain,
                "A_SECRET='it\\'s'\n",
                "A_SECRET=\u{27E6}redacted:7\u{27E7}\n",
            ),
            (
                Plain,
                "X_KEY=1 Y_SECRET=2\n",
                "X_KEY=\u{27E6}redacted:1\u{27E7} Y_SECRET=\u{27E6}redacted:1\u{27E7}\n",
            ),
            (Plain, "FOO_TOKEN=\n", "FOO_TOKEN=\n"),
            (Plain, "FOO_TOKEN=\"\"\n", "FOO_TOKEN=\"\"\n"),
            (
                Plain,
                "FOO_TOKEN=${FOO_TOKEN}\n",
                "FOO_TOKEN=${FOO_TOKEN}\n",
            ),
            (Plain, "FOO_TOKEN=$OTHER\n", "FOO_TOKEN=$OTHER\n"),
            (
                Plain,
                "FOO_TOKEN=$abc\n",
                "FOO_TOKEN=\u{27E6}redacted:4\u{27E7}\n",
            ),
            // look-alikes that must stay visible
            (Plain, "max_tokens=4096\n", "max_tokens=4096\n"),
            (Plain, "MAX_TOKENS=4096\n", "MAX_TOKENS=4096\n"),
            (Plain, "TOKEN_LIMIT=5\n", "TOKEN_LIMIT=5\n"),
            (Plain, "KEY=1\n", "KEY=1\n"),
            (Plain, "if X_KEY == 3\n", "if X_KEY == 3\n"),
            (Plain, "X_KEY==3\n", "X_KEY==3\n"),
            (Plain, "URL_KEY::path\n", "URL_KEY::path\n"),
            (Plain, "X_KEY:nospace\n", "X_KEY:nospace\n"),
            (
                Plain,
                "sk-ant-api03-abcdefghijklmnop\n",
                "sk-ant-api03-abcdefghijklmnop\n",
            ),
            (
                Plain,
                "ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
                "ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
            ),
            (Plain, "AKIAIOSFODNN7EXAMPLE\n", "AKIAIOSFODNN7EXAMPLE\n"),
            (
                Plain,
                "Authorization: Bearer abcdefghijklmn\n",
                "Authorization: Bearer abcdefghijklmn\n",
            ),
            // flags
            (
                Plain,
                "llama-server --api-key sk-1 --ctx-size 4096\n",
                "llama-server --api-key \u{27E6}redacted:4\u{27E7} --ctx-size 4096\n",
            ),
            (
                Plain,
                "--hf-token=hf_abc\n",
                "--hf-token=\u{27E6}redacted:6\u{27E7}\n",
            ),
            (
                Plain,
                "cmd: run --api_key 'a b' --x\n",
                "cmd: run --api_key \u{27E6}redacted:5\u{27E7} --x\n",
            ),
            (
                Plain,
                "\"cmd\": \"run --api-key abc\"\n",
                "\"cmd\": \"run --api-key \u{27E6}redacted:4\u{27E7}\n",
            ),
            (
                Plain,
                "\"--api-key=abc\"\n",
                "\"--api-key=\u{27E6}redacted:3\u{27E7}\"\n",
            ),
            (Plain, "--token-limit 5\n", "--token-limit 5\n"),
            (Plain, "--api-key --other\n", "--api-key --other\n"),
            (Plain, "--api-key=$KEY\n", "--api-key=$KEY\n"),
            (Plain, "--api-key-file /run/k\n", "--api-key-file /run/k\n"),
            (
                Plain,
                "run \\\n  --api-key \\\n  s3cret \\\n  --next\n",
                "run \\\n  --api-key \\\n  \u{27E6}redacted:6\u{27E7} \\\n  --next\n",
            ),
            (
                Plain,
                "args:\n  - \"--hf-token\"\n  - hf_abc\n  - --x\n",
                "args:\n  - \"--hf-token\"\n  - \u{27E6}redacted:6\u{27E7}\n  - --x\n",
            ),
            (
                Plain,
                "args: [\"--password\", \"pw\"]\n",
                "args: [\"--password\", \u{27E6}redacted:4\u{27E7}]\n",
            ),
            (
                Plain,
                "  - --secret\n  - --flag\n",
                "  - --secret\n  - --flag\n",
            ),
            // hf token file
            (HfToken, "hf_abcdef\n", "\u{27E6}redacted:9\u{27E7}\n"),
            (HfToken, "\n", "\n"),
            // ssh private key, whole file
            (
                SshPrivateKey,
                "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
                "\u{27E6}redacted\u{27E7}\n\u{27E6}redacted\u{27E7}\n\u{27E6}redacted\u{27E7}\n",
            ),
            (
                SshPrivateKey,
                "anything\n\ngoes",
                "\u{27E6}redacted\u{27E7}\n\n\u{27E6}redacted\u{27E7}",
            ),
            // pem: only private-key blocks
            (
                PemKey,
                "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n-----BEGIN RSA PRIVATE KEY-----\nK1\nK2\n-----END RSA PRIVATE KEY-----\nafter\n",
                "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n\u{27E6}redacted\u{27E7}\n\u{27E6}redacted\u{27E7}\n\u{27E6}redacted\u{27E7}\n\u{27E6}redacted\u{27E7}\nafter\n",
            ),
            (
                PemKey,
                "-----BEGIN PRIVATE KEY-----\nunterminated\nrest\n",
                "\u{27E6}redacted\u{27E7}\n\u{27E6}redacted\u{27E7}\n\u{27E6}redacted\u{27E7}\n",
            ),
            (
                PemKey,
                "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n",
                "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n",
            ),
            // a private key pasted into a plain file is NOT masked (owner narrowing)
            (
                Plain,
                "-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n",
                "-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n",
            ),
        ];
        for (class, input, expected) in rows {
            assert_eq!(
                &masked(*class, input),
                expected,
                "class {class:?} input {input:?}"
            );
        }
    }

    #[test]
    fn masked_view_never_changes_line_count() {
        for (class, text) in [
            (
                FileClass::PemKey,
                "-----BEGIN PRIVATE KEY-----\nA\nB\n-----END PRIVATE KEY-----\nz",
            ),
            (FileClass::Plain, "run \\\n --api-key \\\n s\\\n x\n"),
            (FileClass::Dotenv, "A=1\r\nB=2\r\n\r\n"),
            (FileClass::SshPrivateKey, "a\nb\n\nc"),
        ] {
            let view = mask(class, text);
            assert_eq!(
                view.text.matches('\n').count(),
                text.matches('\n').count(),
                "{text:?}"
            );
        }
    }

    #[test]
    fn secret_values_never_survive_in_view() {
        for (class, text, secret) in [
            (FileClass::Dotenv, "A=zzTOPSECRETzz # tail\n", "TOPSECRET"),
            (
                FileClass::Plain,
                "X_TOKEN=\"a\\\"TOPSECRET\"\n",
                "TOPSECRET",
            ),
            (FileClass::Plain, "--api-key\n  TOPSECRET\n", "TOPSECRET"),
            (
                FileClass::PemKey,
                "-----BEGIN EC PRIVATE KEY-----\nTOPSECRET\n",
                "TOPSECRET",
            ),
        ] {
            assert!(!mask(class, text).text.contains(secret), "{text:?}");
        }
    }

    #[test]
    fn classification_by_physical_path() {
        use FileClass::{Dotenv, HfToken, PemKey, Plain, SshPrivateKey};
        for (path, expected) in [
            ("/h/.ssh/id_ed25519", SshPrivateKey),
            ("/h/.ssh/id_rsa.pub", Plain),
            ("/h/.ssh/id_x.bak", SshPrivateKey),
            ("/h/.cache/huggingface/token", HfToken),
            ("/h/.huggingface/token", HfToken),
            ("/h/other/token", Plain),
            ("/x/server.pem", PemKey),
            ("/x/server.key", PemKey),
            ("/x/.env", Dotenv),
            ("/x/.env.local", Dotenv),
            ("/x/prod.env", Dotenv),
            ("/x/.envrc", Dotenv),
            ("/c/service.env", Dotenv),
            ("/x/environment", Plain),
            ("/x/config.yaml", Plain),
        ] {
            assert_eq!(classify(Path::new(path)), expected, "{path}");
        }
    }

    #[test]
    fn span_mapping_round_trips_positions() {
        let text = "a=1\nB_TOKEN=hunter22\nz=9\n";
        let view = mask(FileClass::Plain, text);
        assert_eq!(view.text, "a=1\nB_TOKEN=\u{27E6}redacted:8\u{27E7}\nz=9\n");
        assert_eq!(view.redactions(), 1);
        let z_view = view.text.find("z=9").unwrap();
        let z_orig = text.find("z=9").unwrap();
        assert_eq!(view.to_orig(z_view), z_orig);
        let span = &view.spans[0];
        assert!(view.overlaps_span(&(span.view.start - 1..span.view.start + 1)));
        assert!(!view.overlaps_span(&(0..span.view.start)));
        assert!(!view.overlaps_span(&(span.view.end..view.text.len())));
        assert!(view.overlaps_span(&(span.view.start + 2..span.view.start + 2)));
        assert!(!view.overlaps_span(&(span.view.start..span.view.start)));
    }

    // ---- streaming API and speed (owner requirement: masking must not slow the CLI) ----

    #[test]
    fn line_masker_matches_whole_text_masking() {
        let corpus = mixed_corpus(200);
        for class in [
            FileClass::Plain,
            FileClass::Dotenv,
            FileClass::PemKey,
            FileClass::HfToken,
            FileClass::SshPrivateKey,
        ] {
            let whole = mask(class, &corpus).text;
            let mut masker = LineMasker::new(class);
            let streamed: String = corpus
                .split_inclusive('\n')
                .map(|raw| {
                    let body = raw.trim_end_matches(['\n', '\r']);
                    format!("{}{}", masker.mask_line(body), &raw[body.len()..])
                })
                .collect();
            assert_eq!(streamed, whole, "{class:?}");
        }
    }

    /// About 1 MiB of mixed text: config lines, prose, env assignments, flags,
    /// and a few secrets, so both the trigger fast path and the regex path run.
    fn mixed_corpus(repeat: usize) -> String {
        let block = "# deployment notes for the model node\n\
            exec llama-server --ctx-size 32768 --port 8080 --threads 16 \\\n\
            model: /models/qwen3/qwen3-27b-q4_k_m.gguf\n\
            MAX_TOKENS=4096\n\
            the quick brown fox jumps over the lazy dog, again and again and again\n\
            export HF_TOKEN=hf_abcdefghijklmnopqrstuvwxyz0123456789\n\
            run --api-key sk-live-abcdef0123456789 --verbose\n\
            [Service]\nEnvironment=\"DB_PASSWORD=correct horse\"\nLimitNOFILE=65535\n\
            timeout: 30s\nretries: 3\nlog_level: debug\nlisten: 0.0.0.0:8000\n\
            just a plain line of documentation text without anything special in it at all\n";
        let mut out = String::new();
        while out.len() < 1024 * repeat * 5 {
            out.push_str(block);
        }
        out
    }

    fn plain_corpus() -> String {
        let block = "the quick brown fox jumps over the lazy dog, again and again and again\n\
            timeout: 30s\nretries: 3\nlog_level: debug\nlisten: 0.0.0.0:8000\n\
            exec llama-server --ctx-size 32768 --port 8080 --threads 16\n\
            just a plain line of documentation text without anything special in it at all\n";
        let mut out = String::new();
        while out.len() < 1024 * 1024 {
            out.push_str(block);
        }
        out
    }

    #[test]
    fn masking_one_mebibyte_is_fast_and_a_clean_file_is_nearly_free() {
        use std::time::Instant;
        let mixed = {
            let mut s = mixed_corpus(200);
            s.truncate(s.len().min(1024 * 1024));
            s
        };
        let plain = plain_corpus();
        // warm the lazily compiled regex set once (built once per process, not per call)
        let _ = mask(FileClass::Plain, "X_TOKEN=warm\n");
        let best = |text: &str, class| {
            (0..5)
                .map(|_| {
                    let started = Instant::now();
                    let view = mask(class, text);
                    std::hint::black_box(&view);
                    started.elapsed()
                })
                .min()
                .expect("samples")
        };
        let mixed_time = best(&mixed, FileClass::Plain);
        let dotenv_time = best(&mixed, FileClass::Dotenv);
        let clean_time = best(&plain, FileClass::Plain);
        let baseline = {
            let started = Instant::now();
            let copy = plain.clone();
            std::hint::black_box(&copy);
            started.elapsed()
        };
        #[allow(clippy::print_stderr)]
        {
            eprintln!(
                "masking 1 MiB (debug_assertions={}): mixed {:?}, dotenv {:?}, clean {:?} (a plain copy: {:?})",
                cfg!(debug_assertions),
                mixed_time,
                dotenv_time,
                clean_time,
                baseline
            );
        }
        // Generous bounds so a loaded machine does not flake: release measures
        // low single-digit milliseconds, debug an order of magnitude more.
        let (mixed_bound, clean_bound) = if cfg!(debug_assertions) {
            (
                std::time::Duration::from_millis(2500),
                std::time::Duration::from_millis(800),
            )
        } else {
            (
                std::time::Duration::from_millis(50),
                std::time::Duration::from_millis(20),
            )
        };
        assert!(mixed_time < mixed_bound, "mixed {mixed_time:?}");
        assert!(dotenv_time < mixed_bound, "dotenv {dotenv_time:?}");
        assert!(clean_time < clean_bound, "clean {clean_time:?}");
        assert!(mask(FileClass::Plain, &plain).spans.is_empty());
    }
}
