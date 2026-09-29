//! Secret masking for file content (plan sections 3.4 and 11, D5 as narrowed
//! by the owner).
//!
//! What is masked, and nothing else:
//!
//! 1. SSH private keys: files named `id_*` (not `*.pub`) are masked whole, and
//!    `*.pem` / `*.key` files have their `PRIVATE KEY` blocks masked.
//! 2. Environment variables: every assignment in dotenv-shaped files
//!    (`.env`, `*.env`, `.env.*`, `.envrc`, `service.env`), and in any file the
//!    secret-named assignments (`NAME=value`, `NAME: value`, `NAME:value`,
//!    minified JSON `"NAME":"value"`, `Environment=NAME=value`, compose
//!    `environment:` entries) whose upper-case name **is** `PASSWORD` or ends in
//!    `_TOKEN`, `_KEY`, `_SECRET` or `PASSWORD`. Lower-case and mixed-case names
//!    (`hf_token=`, `Password=`) are not masked: the issue's name set is upper
//!    case, as the tests pin.
//! 3. The Hugging Face token file (`~/.cache/huggingface/token`,
//!    `~/.huggingface/token`) and the values of `--api-key`, `--hf-token`,
//!    `--token`, `--password`, `--secret`-style command-line flags, including a
//!    value on the following line (`\` continuation or a YAML/JSON list item).
//!
//! A dotenv value whose opening quote never closes on its line masks every
//! following line, up to and including the one holding the closing quote (to end
//! of file if it never closes), so a multi-line value leaks nothing. Masked
//! values are counted in characters; the length itself is not returned.
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

    /// Whether serving a window from the middle of the file needs the whole
    /// prefix fed to the masker first: a quoted value whose opening quote is on
    /// an earlier line (any file), or a `.pem`/`.key` `PRIVATE KEY` block opened
    /// earlier, masks every following line.
    pub fn needs_prefix(self) -> bool {
        !matches!(self, Self::SshPrivateKey | Self::HfToken)
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
    /// `cum[i]`: real-text length minus masked-view length over `spans[..=i]`.
    cum: Vec<isize>,
}

impl MaskedView {
    pub fn redactions(&self) -> usize {
        self.spans.len()
    }

    /// Whether `range` (masked-view bytes) overlaps a masked span. An empty
    /// range overlaps only when strictly inside a span.
    pub fn overlaps_span(&self, range: &Range<usize>) -> bool {
        // Spans are sorted and disjoint: the first one that ends after
        // `range.start` is the only candidate.
        let idx = self
            .spans
            .partition_point(|span| span.view.end <= range.start);
        let Some(span) = self.spans.get(idx) else {
            return false;
        };
        if range.start == range.end {
            range.start > span.view.start && range.start < span.view.end
        } else {
            range.start < span.view.end && span.view.start < range.end
        }
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
        let idx = self.spans.partition_point(|span| span.view.end <= pos);
        let delta = if idx == 0 { 0 } else { self.cum[idx - 1] };
        (pos as isize + delta) as usize
    }

    fn from_parts(text: String, spans: Vec<Span>) -> Self {
        let mut delta: isize = 0;
        let cum = spans
            .iter()
            .map(|span| {
                delta += span.orig.len() as isize - span.view.len() as isize;
                delta
            })
            .collect();
        Self { text, spans, cum }
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

/// A secret-named assignment: `NAME=value`, `NAME: value`, `NAME:value`,
/// `"NAME":"value"`. The name is exactly `PASSWORD` or ends in `_TOKEN`, `_KEY`,
/// `_SECRET` (or `PASSWORD` after at least one character, e.g. `DB_PASSWORD`).
/// Names without an underscore prefix (`TOKEN=`, `KEY=`) stay visible.
static ASSIGN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"([A-Z][A-Z0-9_]*(?:_TOKEN|_KEY|_SECRET)|[A-Z][A-Z0-9_]*PASSWORD|PASSWORD)["']?[ \t]*([=:])[ \t]*"#,
    )
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

/// Byte index of the first unescaped `quote` in `line`, if any.
fn closing_quote_index(line: &str, quote: char) -> Option<usize> {
    let mut escaped = false;
    for (idx, ch) in line.char_indices() {
        if escaped {
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == quote {
            return Some(idx);
        }
    }
    None
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

/// Quote characters a value can be wrapped in.
fn is_quote(ch: char) -> bool {
    ch == '"' || ch == '\''
}

/// Whether `value` is wrapped in `"`/`'` and the quote after the opening one is
/// never closed (`None` when the value is not quoted at all).
fn unclosed_quote(value: &str) -> Option<char> {
    let open = value.chars().next().filter(|c| is_quote(*c))?;
    let mut escaped = false;
    for ch in value.chars().skip(1) {
        if escaped {
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == open {
            return None;
        }
    }
    Some(open)
}

type LineMask = (Range<usize>, String);

/// Mask the secret-named assignment values of `line` (`generic_line_masks`).
///
/// Every candidate the regex finds is masked, so a minified JSON or compose line
/// with several assignments masks all of them. A quoted string that merely
/// mentions `NAME=value` is over-masked too (safe direction): the local shapes
/// `Environment="API_KEY=abc"` (required) and `{"note":"X_KEY=x"}` are
/// indistinguishable without JSON/YAML parsing.
fn assignment_masks(line: &str, out: &mut Vec<LineMask>) -> Option<char> {
    if !(line.contains("TOKEN")
        || line.contains("KEY")
        || line.contains("SECRET")
        || line.contains("PASSWORD"))
    {
        return None;
    }
    // Candidates are visited left to right and each masked value swallows what
    // follows it, so `covered` keeps the scan linear: a candidate that starts
    // inside an earlier value is already masked and is skipped without
    // rescanning its value.
    let mut covered = 0_usize;
    let mut pos = 0_usize;
    let mut open = None;
    while let Some(caps) = ASSIGN.captures_at(line, pos) {
        let (Some(name), Some(sep), Some(whole)) = (caps.get(1), caps.get(2), caps.get(0)) else {
            break;
        };
        // Resume after the match, and after any value it swallowed, so a
        // covered candidate is never even matched.
        pos = whole.end().max(covered);
        if name.start() < covered {
            continue;
        }
        let after = &line[whole.end()..];
        if sep.as_str() == "=" && after.starts_with('=') {
            continue;
        }
        // `NAME::path` is not an assignment (`NAME:value` and `NAME: value` are).
        if sep.as_str() == ":" && after.starts_with(':') {
            continue;
        }
        if name.start() > 0 && is_word_byte(line.as_bytes()[name.start() - 1]) {
            // The `name` alternation can start inside a wider regex match
            // (`DESCRIPTION` out of `DESCRIPTION:...`); anchor it to a word start.
            continue;
        }
        let end = value_end(line, whole.end(), enclosing_quote(line, name.start()));
        covered = end;
        pos = pos.max(end);
        let value = &line[whole.end()..end];
        if value_is_public(value) {
            continue;
        }
        if let Some(quote) = unclosed_quote(value) {
            open = Some(quote);
        }
        out.push((whole.end()..end, token(value.chars().count())));
    }
    open
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Assignment and flag masks of `line`. Returns the quote of a masked value
/// that does not close on this line (it continues on the following lines).
fn generic_line_masks(line: &str, out: &mut Vec<LineMask>) -> Option<char> {
    let mut open = assignment_masks(line, out);
    if line.contains("--") {
        let mut covered = 0_usize;
        let mut pos = 0_usize;
        while let Some(caps) = FLAG.captures_at(line, pos) {
            let (Some(sep), Some(whole)) = (caps.get(1), caps.get(0)) else {
                break;
            };
            let start = whole.end();
            pos = start.max(covered);
            if start < covered {
                continue;
            }
            if sep.as_str() != "=" && line[start..].starts_with('-') {
                continue;
            }
            let flag_start = whole.start();
            let enclosing = enclosing_quote(line, flag_start + 1);
            let end = value_end(line, start, enclosing);
            covered = end;
            pos = pos.max(end);
            let value = &line[start..end];
            if value_is_public(value) {
                continue;
            }
            if let Some(quote) = unclosed_quote(value) {
                open = Some(quote);
            }
            out.push((start..end, token(value.chars().count())));
        }
    }
    open
}

fn merge(mut masks: Vec<LineMask>, line: &str) -> Vec<LineMask> {
    masks.sort_by_key(|(range, _)| (range.start, range.end));
    // (range, token, absorbed another mask): a merged range is re-counted once,
    // after all its members are known, not once per absorbed mask.
    let mut merged: Vec<(Range<usize>, String, bool)> = Vec::with_capacity(masks.len());
    for (range, tok) in masks {
        if let Some((last, _, absorbed)) = merged.last_mut()
            && range.start < last.end
        {
            last.end = last.end.max(range.end);
            *absorbed = true;
            continue;
        }
        merged.push((range, tok, false));
    }
    merged
        .into_iter()
        .map(|(range, tok, absorbed)| {
            let tok = if absorbed {
                token(line[range.clone()].chars().count())
            } else {
                tok
            };
            (range, tok)
        })
        .collect()
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

/// Line-oriented masker. Feed lines (without terminators) in file order. The
/// state carried between lines is: a `PRIVATE KEY` block flag, a "previous line
/// ended with a secret flag" flag, and an open quoted value that consumes every
/// following line until its closing quote. A caller that serves a window from
/// the middle of a file feeds the whole prefix for a class where
/// [`FileClass::needs_prefix`] holds; for the other classes one line of context
/// before the window is enough. Command-output masking (a later phase) reuses
/// this as a streaming scanner.
#[derive(Debug, Clone)]
pub struct LineMasker {
    class: FileClass,
    in_private_block: bool,
    pending_flag_value: bool,
    open_quote: Option<char>,
}

impl LineMasker {
    pub fn new(class: FileClass) -> Self {
        Self {
            class,
            in_private_block: false,
            pending_flag_value: false,
            open_quote: None,
        }
    }

    /// Whether the masker is inside a quoted value that started on an earlier
    /// line: every following line is masked until the closing quote.
    pub fn in_continuation(&self) -> bool {
        self.open_quote.is_some()
    }

    /// Masked ranges of `line` (byte ranges in `line` plus their replacement
    /// text), sorted and non-overlapping. Advances the state.
    pub fn scan(&mut self, line: &str) -> Vec<(Range<usize>, String)> {
        let mut masks: Vec<LineMask> = Vec::new();
        let mut from = 0;
        if let Some(quote) = self.open_quote {
            // Inside a quoted value that opened on an earlier line (any class):
            // this line is part of the value, up to the closing quote.
            self.pending_flag_value = false;
            match closing_quote_index(line, quote) {
                None => return vec![(0..line.len(), token_bare())],
                Some(idx) => {
                    self.open_quote = None;
                    if self.class == FileClass::Dotenv {
                        // Fail closed: nothing after the value is trusted.
                        return vec![(0..line.len(), token_bare())];
                    }
                    from = idx + quote.len_utf8();
                    masks.push((0..from, token_bare()));
                }
            }
        }
        let base = masks.len();
        masks.extend(self.scan_body(&line[from..]));
        for (range, _) in &mut masks[base..] {
            range.start += from;
            range.end += from;
        }
        if masks.is_empty() {
            masks
        } else {
            merge(masks, line)
        }
    }

    /// The class and generic rules over `line` (ranges relative to `line`).
    fn scan_body(&mut self, line: &str) -> Vec<LineMask> {
        let mut masks: Vec<LineMask> = Vec::new();
        let mut open_quote = None;
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
                        let value = &line[m.end()..end];
                        if let Some(quote) = unclosed_quote(value) {
                            open_quote = Some(quote);
                        }
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
            if TRIGGER.is_match(line)
                && let Some(quote) = generic_line_masks(line, &mut masks)
                && !matches!(self.class, FileClass::SshPrivateKey | FileClass::HfToken)
            {
                open_quote = Some(quote);
            }
        }
        self.open_quote = open_quote;
        self.pending_flag_value = line.contains("--") && FLAG_AT_END.is_match(line);
        masks
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
        return MaskedView::from_parts(text.to_string(), Vec::new());
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
    MaskedView::from_parts(out, spans)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(class: FileClass, text: &str) -> String {
        mask(class, text).text
    }

    /// Every row: (class, input, exact masked output). Adversarial rows cover
    /// quoting, whitespace, CRLF, multiple assignments per line, references,
    /// visible near-matches, and continuation lines (flag and quoted value).
    #[test]
    fn masking_table() {
        use FileClass::{Dotenv, HfToken, Plain};
        let aws = aws_style_id();
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
            // bare `PASSWORD` and `PASSWORD`-suffixed names (G1-1); names without
            // an underscore prefix (`TOKEN=`) stay visible
            (Plain, "PASSWORD=hunter2\n", "PASSWORD=⟦redacted:7⟧\n"),
            (Plain, "PASSWORD: hunter2\n", "PASSWORD: ⟦redacted:7⟧\n"),
            (Plain, "PASSWORD:\"a b\"\n", "PASSWORD:⟦redacted:5⟧\n"),
            (Plain, "PASSWORD=\n", "PASSWORD=\n"),
            (Plain, "PASSWORD=${PASSWORD}\n", "PASSWORD=${PASSWORD}\n"),
            (Plain, "MYPASSWORD=x\n", "MYPASSWORD=⟦redacted:1⟧\n"),
            (Plain, "TOKEN=abc\n", "TOKEN=abc\n"),
            (
                Plain,
                "Environment=PASSWORD=abc\n",
                "Environment=PASSWORD=⟦redacted:3⟧\n",
            ),
            // lower-case and mixed-case names are outside the issue's name set
            (Plain, "hf_token=abc123\n", "hf_token=abc123\n"),
            (Plain, "Password=hunter2\n", "Password=hunter2\n"),
            (Plain, "password=hunter2\n", "password=hunter2\n"),
            // `:` with no space is an assignment only when the value is quoted
            // (minified JSON); elsewhere it is a scalar key/value line (G1-2)
            (
                Plain,
                "{\"HF_TOKEN\":\"sk-live-abc\"}\n",
                "{\"HF_TOKEN\":⟦redacted:13⟧}\n",
            ),
            (
                Plain,
                "{\"HF_TOKEN\":\"a\",\"X_KEY\":\"b\"}\n",
                "{\"HF_TOKEN\":⟦redacted:3⟧,\"X_KEY\":⟦redacted:3⟧}\n",
            ),
            (
                Plain,
                "HF_TOKEN:\"sk-live-abc\"\n",
                "HF_TOKEN:⟦redacted:13⟧\n",
            ),
            (
                Plain,
                "[\n{\"A_SECRET\":\"x\"}\n]\n",
                "[\n{\"A_SECRET\":⟦redacted:3⟧}\n]\n",
            ),
            // visible near-matches: comparisons, unquoted scalars, names without
            // an underscore prefix, and numbers that only look like values
            (Plain, "if PASSWORD == 3\n", "if PASSWORD == 3\n"),
            (Plain, "  HF_TOKEN: keep-me\n", "  HF_TOKEN: ⟦redacted:7⟧\n"),
            // over-masking is the accepted direction: `NAME:value` is an assignment
            (
                Plain,
                "URL_KEY:8080/path\n",
                "URL_KEY:\u{27E6}redacted:9\u{27E7}\n",
            ),
            (
                Plain,
                "PASSWORD:abc\n",
                "PASSWORD:\u{27E6}redacted:3\u{27E7}\n",
            ),
            (
                Plain,
                "HF_TOKEN:hunter2\n",
                "HF_TOKEN:\u{27E6}redacted:7\u{27E7}\n",
            ),
            // a quoted value that spans lines masks every line of it, in any class,
            // and text after the closing quote is scanned normally again
            (
                Plain,
                "X_TOKEN=\"first\nsecond\nthird\" tail\nafter\n",
                "X_TOKEN=\u{27E6}redacted:6\u{27E7}\n\u{27E6}redacted\u{27E7}\n\u{27E6}redacted\u{27E7} tail\nafter\n",
            ),
            (
                Plain,
                "X_KEY: 'a\nb'\nY_KEY=z\n",
                "X_KEY: \u{27E6}redacted:2\u{27E7}\n\u{27E6}redacted\u{27E7}\nY_KEY=\u{27E6}redacted:1\u{27E7}\n",
            ),
            (
                Plain,
                "--token \"a\nb\"\nplain\n",
                "--token \u{27E6}redacted:2\u{27E7}\n\u{27E6}redacted\u{27E7}\nplain\n",
            ),
            (
                Plain,
                "DESCRIPTION: \"X_KEY: keep\"\n",
                "DESCRIPTION: \"X_KEY: ⟦redacted:4⟧\"\n",
            ),
            (
                Plain,
                "note: \"A_TOKEN=b stays\"\n",
                "note: \"A_TOKEN=⟦redacted:1⟧ stays\"\n",
            ),
            (
                Plain,
                "{\"note\":\"HF_TOKEN=x\"}\n",
                "{\"note\":\"HF_TOKEN=⟦redacted:1⟧\"}\n",
            ),
            (
                Plain,
                "{\"X_KEY\":\"ok\",\"resp\":{\"note\":\"a,b\"}}\n",
                "{\"X_KEY\":⟦redacted:4⟧,\"resp\":{\"note\":\"a,b\"}}\n",
            ),
            (
                Plain,
                "\"quoted\", X_KEY=abc\n",
                "\"quoted\", X_KEY=⟦redacted:3⟧\n",
            ),
            // the older hidden default: the name is part of a larger word
            (Plain, "MYKEY=1\n", "MYKEY=1\n"),
            (Plain, "reKEY=x\n", "reKEY=x\n"),
            // multi-line quoted values (G1-3)
            (
                Dotenv,
                "A=\"first\nSECOND\"\nB=x\n",
                "A=⟦redacted:6⟧\n⟦redacted⟧\nB=⟦redacted:1⟧\n",
            ),
            (
                Dotenv,
                "A=\"one\ntwo\nthree\n",
                "A=⟦redacted:4⟧\n⟦redacted⟧\n⟦redacted⟧\n",
            ),
            (
                Dotenv,
                "A=\"x\" B=1\nC=\"y\nz\"\n",
                "A=⟦redacted:7⟧\nC=⟦redacted:2⟧\n⟦redacted⟧\n",
            ),
            (
                Dotenv,
                "PATH=\"/usr/bin:/bin\"\nNEXT=2\n",
                "PATH=⟦redacted:15⟧\nNEXT=⟦redacted:1⟧\n",
            ),
            (Dotenv, "A=\nB=\"x\"\n", "A=\nB=⟦redacted:3⟧\n"),
            (
                Dotenv,
                "A='it\\'s fine'\nB=2\n",
                "A=⟦redacted:12⟧\nB=⟦redacted:1⟧\n",
            ),
            // a quote closed on the same line is a one-line value
            (
                Dotenv,
                "A=\"x\" # tail\nB=2\n",
                "A=⟦redacted:10⟧\nB=⟦redacted:1⟧\n",
            ),
            // visible near-matches that must stay as they are (see above)
            (Plain, "max_tokens=4096\n", "max_tokens=4096\n"),
            (Plain, "MAX_TOKENS=4096\n", "MAX_TOKENS=4096\n"),
            (Plain, "TOKEN_LIMIT=5\n", "TOKEN_LIMIT=5\n"),
            (Plain, "KEY=1\n", "KEY=1\n"),
            (Plain, "if X_KEY == 3\n", "if X_KEY == 3\n"),
            (Plain, "X_KEY==3\n", "X_KEY==3\n"),
            (Plain, "URL_KEY::path\n", "URL_KEY::path\n"),
            (
                Plain,
                "X_KEY:nospace\n",
                "X_KEY:\u{27E6}redacted:7\u{27E7}\n",
            ),
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
            (Plain, aws.as_str(), aws.as_str()),
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
        ];
        for (class, input, expected) in rows {
            assert_eq!(
                &masked(*class, input),
                expected,
                "class {class:?} input {input:?}"
            );
        }
    }

    /// A PEM block with a run-time label: the committed source must not contain a
    /// literal `-----BEGIN ... PRIVATE KEY-----` line (the CI secret scan and the
    /// CLI policy checks grep for it).
    fn pem(label: &str, body: &str) -> String {
        format!("-----BEGIN {label}-----\n{body}-----END {label}-----\n")
    }

    /// An AWS-style access-key-id placeholder, built at run time: the committed
    /// source must not contain a 20-character id of that shape (the CLI policy
    /// checks and the CI secret scan grep for it).
    fn aws_style_id() -> String {
        format!("{}{}", "AKIA", "IOSFODNN7EXAMPLE")
    }

    /// A PEM block whose `END` line is missing.
    fn pem_open(label: &str, body: &str) -> String {
        format!("-----BEGIN {label}-----\n{body}")
    }

    /// Whole-file classes (`id_*`) and the by-label rule for `*.pem`/`*.key`
    /// files, including a private key pasted into a plain file (not masked, by
    /// owner narrowing).
    #[test]
    fn key_blocks_are_masked_by_class_and_label() {
        let bare = "\u{27E6}redacted\u{27E7}\n";
        let ssh = pem("OPENSSH PRIVATE KEY", "AAAA\n");
        assert_eq!(masked(FileClass::SshPrivateKey, &ssh), bare.repeat(3));
        assert_eq!(
            masked(FileClass::SshPrivateKey, "anything\n\ngoes"),
            format!("{bare}\n{bare}").trim_end_matches('\n')
        );
        let cert = pem("CERTIFICATE", "MIIB\n");
        let rsa = pem("RSA PRIVATE KEY", "K1\nK2\n");
        assert_eq!(
            masked(FileClass::PemKey, &format!("{cert}{rsa}after\n")),
            format!("{cert}{bare}{bare}{bare}{bare}after\n")
        );
        let unterminated = pem_open("PRIVATE KEY", "unterminated\nrest\n");
        assert_eq!(masked(FileClass::PemKey, &unterminated), bare.repeat(3));
        let public = pem("PUBLIC KEY", "MIIB\n");
        assert_eq!(masked(FileClass::PemKey, &public), public);
        // a private key pasted into a plain file is NOT masked (owner narrowing)
        let pasted = pem("PRIVATE KEY", "K\n");
        assert_eq!(masked(FileClass::Plain, &pasted), pasted);
    }

    #[test]
    fn masked_view_never_changes_line_count() {
        let pem_text = pem("PRIVATE KEY", "A\nB\n");
        for (class, text) in [
            (FileClass::PemKey, pem_text.as_str()),
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
        let ec_key = pem_open("EC PRIVATE KEY", "TOPSECRET\n");
        for (class, text, secret) in [
            (FileClass::Dotenv, "A=zzTOPSECRETzz # tail\n", "TOPSECRET"),
            (
                FileClass::Plain,
                "X_TOKEN=\"a\\\"TOPSECRET\"\n",
                "TOPSECRET",
            ),
            (FileClass::Plain, "--api-key\n  TOPSECRET\n", "TOPSECRET"),
            (FileClass::PemKey, ec_key.as_str(), "TOPSECRET"),
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

    /// One crafted line of many overlapping candidates must not cost more than
    /// a linear scan (each candidate's value used to be rescanned to the end).
    #[test]
    fn adversarial_lines_are_masked_in_linear_time() {
        use std::time::{Duration, Instant};
        let corpora = [
            "X_KEY=,".repeat(60_000),
            ",--token=".repeat(50_000),
            "A_KEY=\"".repeat(40_000),
            "--password ".repeat(40_000),
            "X_KEY:".repeat(60_000),
        ];
        for text in &corpora {
            for class in [FileClass::Plain, FileClass::Dotenv] {
                let started = Instant::now();
                let view = mask(class, text);
                std::hint::black_box(&view);
                let took = started.elapsed();
                // superlinear behaviour measured minutes here; a linear scan is
                // milliseconds (seconds is generous for a loaded debug build)
                assert!(
                    took < Duration::from_secs(8),
                    "{class:?} {:?}: {took:?}",
                    &text[..12]
                );
            }
        }
    }

    #[test]
    fn a_line_masker_carries_an_open_quote_across_lines_for_every_class() {
        let mut masker = LineMasker::new(FileClass::Plain);
        assert_eq!(
            masker.mask_line("K_TOKEN=\"one"),
            "K_TOKEN=\u{27E6}redacted:4\u{27E7}"
        );
        assert!(masker.in_continuation());
        assert_eq!(masker.mask_line("two"), "\u{27E6}redacted\u{27E7}");
        assert_eq!(
            masker.mask_line("three\" ok"),
            "\u{27E6}redacted\u{27E7} ok"
        );
        assert!(!masker.in_continuation());
        assert_eq!(masker.mask_line("visible"), "visible");
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
