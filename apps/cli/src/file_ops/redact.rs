//! Secret masking for file content (plan sections 3.4 and 11, D5 as narrowed
//! by the owner). The design is `design-r2.md`: masking is fail-closed.
//!
//! What is masked, and nothing else:
//!
//! 1. SSH private keys: files named `id_*` (not `*.pub`) are masked whole, and
//!    `*.pem` / `*.key` files have their `PRIVATE KEY` blocks masked.
//! 2. Environment variables. In dotenv-shaped files (`.env`, `*.env`, `.env.*`,
//!    `.envrc`, `service.env`) only blank lines, comments and the `KEY` of a
//!    simple `KEY=` / `export KEY=` line are shown; every other line is masked
//!    whole. In any other file, from the first secret-named assignment
//!    (`NAME=value`, `NAME: value`, `NAME:value`, `"NAME":"value"`,
//!    `Environment=NAME=value`, compose `environment:` entries) whose upper-case
//!    name **is** `PASSWORD` or ends in `_TOKEN`, `_KEY`, `_SECRET` or
//!    `PASSWORD`, the whole rest of the physical line is masked. Lower-case and
//!    mixed-case names (`hf_token=`, `Password=`) are not secret names: the
//!    issue's name set is upper case, as the tests pin.
//! 3. The Hugging Face token file (`~/.cache/huggingface/token`,
//!    `~/.huggingface/token`) and the values of `--api-key`, `--hf-token`,
//!    `--token`, `--password`, `--secret`-style command-line flags (again to the
//!    end of the line), including a value on the following line (`\`
//!    continuation or a YAML/JSON list item).
//!
//! The scanner never decides where a value ENDS. A value that opens a multi-line
//! form (an unclosed quote, `"""`/`'''`, a YAML `|`/`>` block scalar, a trailing
//! `\`) keeps the following lines masked until the form provably closes; if it
//! never closes, the rest of what is scanned is masked. Masked values are counted
//! in characters; the length itself is not returned.
//!
//! There is deliberately no vendor-prefix scanner and no cloud-credential list.
//!
//! Masking is applied before any windowing, so a cut never shows half a secret.
//! A window is masked with the state of the [`LOOKBACK_BYTES`] before it. It never
//! adds or removes a line: every replacement stays on its line (a masked block
//! replaces each line), so line numbers in the masked view are line numbers in the
//! real file. The masked view is the only text the edit engine matches against,
//! which means an edit cannot probe a masked value, and an edit that would move a
//! masked byte out of the masked view is refused.
//!
//! The class of a path is decided from the path only (ASCII case-insensitive on
//! every OS, no filesystem search). Secret-class files and directories are
//! read-only through the tools: [`is_secret_scope`] is what `Policy::check_path`
//! refuses for every mutation.

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

/// Classify by the physical path of the file. Names are compared ASCII
/// lower-cased on every OS: a case-insensitive volume (macOS default, casefold
/// ext4, vfat) opens `ID_ED25519` or `.ENV` as the secret file, so the spelling
/// the caller typed must not decide the class. Over-masking a genuinely distinct
/// `.ENV` on a case-sensitive volume is the safe direction.
pub fn classify(path: &Path) -> FileClass {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    let lower = Path::new(&lower);
    let name = lower
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if name.starts_with("id_") && !name.ends_with(".pub") {
        return FileClass::SshPrivateKey;
    }
    if lower.ends_with(".cache/huggingface/token") || lower.ends_with(".huggingface/token") {
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
    let lower = path.to_string_lossy().to_ascii_lowercase();
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

/// How far before a window a read looks for masking context (an open multi-line
/// value or `PRIVATE KEY` block). The masker is fed only the lines in this many
/// bytes before the window, never the whole prefix. Real PEM keys are a few KiB
/// and a secret value that spans lines is small, so 1 MiB covers them by a wide
/// margin; a construct opened further back than this is not seen (documented
/// residual in `design-r2.md` and the PR body).
pub const LOOKBACK_BYTES: usize = 1024 * 1024;

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
/// A YAML block scalar header after `key:`: `|`, `>`, `|-`, `>+2`, with an
/// optional tag and trailing comment.
static BLOCK_SCALAR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:![^\s]*[ \t]+)?[|>][+\-0-9]*[ \t]*(?:#.*)?$").expect("block scalar regex")
});
static TRIGGER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("TOKEN|KEY|SECRET|PASSWORD|--").expect("trigger regex"));

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

/// Byte index just past the first `quote quote quote` in `line`.
fn closing_triple_end(line: &str, quote: char) -> Option<usize> {
    let triple: String = std::iter::repeat_n(quote, 3).collect();
    line.find(&triple).map(|idx| idx + triple.len())
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

/// The quote that is still open at the end of `text` (scanned from outside any
/// quote). `"` opens anywhere; `'` only at the start of a word, so an
/// apostrophe in prose (`it's`) does not swallow the following lines.
fn open_quote_after(text: &str) -> Option<char> {
    let mut open: Option<char> = None;
    let mut escaped = false;
    let mut prev: Option<char> = None;
    for ch in text.chars() {
        if escaped {
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else {
            match open {
                Some(quote) if ch == quote => open = None,
                Some(_) => {}
                None => {
                    let word_start = prev.is_none_or(|p| !(p.is_alphanumeric() || p == '_'));
                    if ch == '"' || (ch == '\'' && word_start) {
                        open = Some(ch);
                    }
                }
            }
        }
        prev = Some(ch);
    }
    open
}

/// A multi-line value that the masked tail of a line opened. The following
/// lines stay masked until it provably closes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Construct {
    None,
    /// An unclosed `"` or `'`: masked until the closing quote.
    Quote(char),
    /// An unclosed `"""` or `'''`.
    Triple(char),
    /// A YAML `|`/`>` block scalar of a key at column `key_col`: masked while
    /// lines are blank or indented deeper.
    Block {
        key_col: usize,
    },
    /// A trailing `\`: the next line is part of the value.
    Backslash,
}

/// The construct that the value text `tail` (rest of the line, after the
/// separator) opens.
fn construct_for_tail(tail: &str, colon: bool, key_col: usize) -> Construct {
    let trimmed = tail.trim();
    if colon && BLOCK_SCALAR.is_match(trimmed) {
        return Construct::Block { key_col };
    }
    for quote in ['"', '\''] {
        let triple: String = std::iter::repeat_n(quote, 3).collect();
        if trimmed.starts_with(&triple) {
            return if trimmed[3..].contains(&triple) {
                Construct::None
            } else {
                Construct::Triple(quote)
            };
        }
    }
    if let Some(quote) = open_quote_after(tail) {
        return Construct::Quote(quote);
    }
    if trimmed.ends_with('\\') {
        return Construct::Backslash;
    }
    Construct::None
}

type LineMask = (Range<usize>, String);

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// One secret candidate: where its masked tail starts and what it opens.
type Candidate = (usize, Construct);

/// The first secret-named assignment of `line`. Its value is the whole rest of
/// the line (never "up to the next space or quote").
fn first_assignment(line: &str) -> Option<Candidate> {
    if !(line.contains("TOKEN")
        || line.contains("KEY")
        || line.contains("SECRET")
        || line.contains("PASSWORD"))
    {
        return None;
    }
    let mut pos = 0_usize;
    while let Some(caps) = ASSIGN.captures_at(line, pos) {
        let (Some(name), Some(sep), Some(whole)) = (caps.get(1), caps.get(2), caps.get(0)) else {
            break;
        };
        pos = whole.end();
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
        let tail = &line[whole.end()..];
        let trimmed = tail.trim_end();
        if trimmed == "\\" {
            // a lone backslash hides nothing, but the value is on the next line
            return Some((line.len(), Construct::Backslash));
        }
        if value_is_public(trimmed) {
            continue;
        }
        let construct = construct_for_tail(tail, sep.as_str() == ":", name.start());
        return Some((whole.end(), construct));
    }
    None
}

/// The first secret flag of `line` (`--token abc`, `--api-key=abc`).
fn first_flag(line: &str) -> Option<Candidate> {
    if !line.contains("--") {
        return None;
    }
    let mut pos = 0_usize;
    while let Some(caps) = FLAG.captures_at(line, pos) {
        let (Some(sep), Some(whole)) = (caps.get(1), caps.get(0)) else {
            break;
        };
        let start = whole.end();
        pos = start;
        if sep.as_str() != "=" && line[start..].starts_with('-') {
            continue;
        }
        let tail = &line[start..];
        let trimmed = tail.trim_end();
        if trimmed == "\\" {
            return Some((line.len(), Construct::Backslash));
        }
        if value_is_public(trimmed) {
            continue;
        }
        return Some((start, construct_for_tail(tail, false, 0)));
    }
    None
}

/// The earliest secret candidate of a line (assignment or flag).
fn first_secret(line: &str) -> Option<Candidate> {
    match (first_assignment(line), first_flag(line)) {
        (Some(a), Some(f)) => Some(if a.0 <= f.0 { a } else { f }),
        (a, None) => a,
        (None, f) => f,
    }
}

/// The mask for the tail of `line` starting at `start` (none when empty).
fn tail_mask(line: &str, start: usize) -> Option<LineMask> {
    let end = line.trim_end().len();
    (start < end).then(|| (start..end, token(line[start..end].chars().count())))
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

/// First value token on a continuation line (a flag value or a list item):
/// from the value to the end of the line, and the construct it opens.
fn continuation_value(line: &str) -> Option<(Range<usize>, Construct)> {
    let trimmed_start = line.len() - line.trim_start().len();
    let mut start = trimmed_start;
    if line[start..].starts_with("- ") {
        start += 2;
        start += line[start..].len() - line[start..].trim_start().len();
    }
    if start >= line.len() || line[start..].starts_with('-') {
        return None;
    }
    let end = line.trim_end().len();
    let value = &line[start..end];
    if value == "\\" {
        return Some((line.len()..line.len(), Construct::Backslash));
    }
    if value_is_public(value) {
        return None;
    }
    Some((
        start..end.max(start),
        construct_for_tail(&line[start..], false, 0),
    ))
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// Line-oriented masker. Feed lines (without terminators) in file order. The
/// state carried between lines is: a `PRIVATE KEY` block flag, a "previous line
/// ended with a secret flag" flag, and an open multi-line [`Construct`] that
/// keeps every following line masked until it provably closes. A caller that
/// serves a window from the middle of a file feeds the lines in
/// [`LOOKBACK_BYTES`] before it (state only) for a class where
/// [`FileClass::needs_prefix`] holds. Command-output masking (a later phase)
/// reuses this as a streaming scanner.
#[derive(Debug, Clone)]
pub struct LineMasker {
    class: FileClass,
    in_private_block: bool,
    pending_flag_value: bool,
    construct: Construct,
}

impl LineMasker {
    pub fn new(class: FileClass) -> Self {
        Self {
            class,
            in_private_block: false,
            pending_flag_value: false,
            construct: Construct::None,
        }
    }

    pub fn class(&self) -> FileClass {
        self.class
    }

    /// Whether the masker is inside a multi-line value that started on an
    /// earlier line: the following lines are masked until it closes.
    pub fn in_continuation(&self) -> bool {
        self.construct != Construct::None
    }

    /// Advance the state over a line that is not valid UTF-8 (context before a
    /// window). The state depends only on ASCII delimiters, which a lossy
    /// conversion keeps.
    pub fn advance_bytes(&mut self, line: &[u8]) {
        let _ = self.scan(&String::from_utf8_lossy(line));
    }

    /// A window line that is not valid UTF-8 in a secret-class file: masked
    /// whole (unknown means masked), and the state advances as for context.
    pub fn mask_invalid(&mut self, line: &[u8]) -> (String, usize) {
        self.advance_bytes(line);
        (token_bare(), 1)
    }

    /// Masked ranges of `line` (byte ranges in `line` plus their replacement
    /// text), sorted and non-overlapping. Advances the state.
    pub fn scan(&mut self, line: &str) -> Vec<(Range<usize>, String)> {
        let whole = |line: &str| vec![(0..line.len(), token_bare())];
        match self.construct {
            Construct::None => {}
            Construct::Backslash => {
                self.pending_flag_value = false;
                if !line.trim_end().ends_with('\\') {
                    self.construct = Construct::None;
                }
                return whole(line);
            }
            Construct::Block { key_col } => {
                if line.trim().is_empty() {
                    return Vec::new();
                }
                if indent_of(line) > key_col {
                    self.pending_flag_value = false;
                    return whole(line);
                }
                // dedent: the block is over and this line is a normal line
                self.construct = Construct::None;
            }
            Construct::Quote(quote) => {
                self.pending_flag_value = false;
                return match closing_quote_index(line, quote) {
                    None => whole(line),
                    Some(idx) => self.after_close(line, idx + quote.len_utf8()),
                };
            }
            Construct::Triple(quote) => {
                self.pending_flag_value = false;
                return match closing_triple_end(line, quote) {
                    None => whole(line),
                    Some(end) => self.after_close(line, end),
                };
            }
        }
        let masks = self.scan_body(line);
        if masks.is_empty() {
            masks
        } else {
            merge(masks, line)
        }
    }

    /// A multi-line value closed at byte `end` of `line`.
    fn after_close(&mut self, line: &str, end: usize) -> Vec<LineMask> {
        self.construct = Construct::None;
        let rest = &line[end..];
        if self.class == FileClass::Dotenv {
            // Nothing after a value is trusted; it may still open another value.
            self.construct = construct_for_tail(rest, false, 0);
            return vec![(0..line.len(), token_bare())];
        }
        let mut masks = vec![(0..end, token_bare())];
        for (range, tok) in self.scan_body(rest) {
            masks.push((range.start + end..range.end + end, tok));
        }
        merge(masks, line)
    }

    /// The class and generic rules over `line` (ranges relative to `line`).
    fn scan_body(&mut self, line: &str) -> Vec<LineMask> {
        let mut masks: Vec<LineMask> = Vec::new();
        let mut construct = Construct::None;
        let mut generic = true;
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
                    generic = false;
                }
            }
            FileClass::Dotenv => {
                // Unknown means masked: only blank lines, comments and the KEY of
                // a simple `KEY=` line are shown.
                generic = false;
                let trimmed = line.trim_start();
                if trimmed.is_empty() {
                    // shown
                } else if trimmed.starts_with('#') {
                    // a comment is shown, unless it holds a commented-out secret
                    generic = true;
                } else if let Some(m) = DOTENV_ASSIGN.find(line) {
                    masks.extend(tail_mask(line, m.end()));
                    construct = construct_for_tail(&line[m.end()..], false, 0);
                } else {
                    masks.push((0..line.len(), token_bare()));
                    construct = construct_for_tail(line, false, 0);
                }
            }
            FileClass::Plain => {}
        }
        if generic {
            if self.pending_flag_value
                && let Some((range, opened)) = continuation_value(line)
            {
                masks.extend(tail_mask(line, range.start));
                construct = opened;
            }
            if TRIGGER.is_match(line)
                && let Some((start, opened)) = first_secret(line)
            {
                masks.extend(tail_mask(line, start));
                construct = opened;
            }
        }
        self.construct = construct;
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
                "Environment=\"API_KEY=⟦redacted:4⟧\n",
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
                "\"HF_TOKEN\": ⟦redacted:6⟧\n",
            ),
            (
                Plain,
                "A_SECRET='it\\'s'\n",
                "A_SECRET=\u{27E6}redacted:7\u{27E7}\n",
            ),
            (Plain, "X_KEY=1 Y_SECRET=2\n", "X_KEY=⟦redacted:12⟧\n"),
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
                "{\"HF_TOKEN\":⟦redacted:14⟧\n",
            ),
            (
                Plain,
                "{\"HF_TOKEN\":\"a\",\"X_KEY\":\"b\"}\n",
                "{\"HF_TOKEN\":⟦redacted:16⟧\n",
            ),
            (
                Plain,
                "HF_TOKEN:\"sk-live-abc\"\n",
                "HF_TOKEN:⟦redacted:13⟧\n",
            ),
            (
                Plain,
                "[\n{\"A_SECRET\":\"x\"}\n]\n",
                "[\n{\"A_SECRET\":⟦redacted:4⟧\n]\n",
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
                "DESCRIPTION: \"X_KEY: ⟦redacted:5⟧\n",
            ),
            (
                Plain,
                "note: \"A_TOKEN=b stays\"\n",
                "note: \"A_TOKEN=⟦redacted:8⟧\n",
            ),
            (
                Plain,
                "{\"note\":\"HF_TOKEN=x\"}\n",
                "{\"note\":\"HF_TOKEN=⟦redacted:3⟧\n",
            ),
            (
                Plain,
                "{\"X_KEY\":\"ok\",\"resp\":{\"note\":\"a,b\"}}\n",
                "{\"X_KEY\":⟦redacted:27⟧\n",
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
                "llama-server --api-key ⟦redacted:20⟧\n",
            ),
            (
                Plain,
                "--hf-token=hf_abc\n",
                "--hf-token=\u{27E6}redacted:6\u{27E7}\n",
            ),
            (
                Plain,
                "cmd: run --api_key 'a b' --x\n",
                "cmd: run --api_key ⟦redacted:9⟧\n",
            ),
            (
                Plain,
                "\"cmd\": \"run --api-key abc\"\n",
                "\"cmd\": \"run --api-key \u{27E6}redacted:4\u{27E7}\n",
            ),
            (Plain, "\"--api-key=abc\"\n", "\"--api-key=⟦redacted:4⟧\n"),
            (Plain, "--token-limit 5\n", "--token-limit 5\n"),
            (Plain, "--api-key --other\n", "--api-key --other\n"),
            (Plain, "--api-key=$KEY\n", "--api-key=$KEY\n"),
            (Plain, "--api-key-file /run/k\n", "--api-key-file /run/k\n"),
            (
                Plain,
                "run \\\n  --api-key \\\n  s3cret \\\n  --next\n",
                "run \\\n  --api-key \\\n⟦redacted⟧\n⟦redacted⟧\n",
            ),
            (
                Plain,
                "args:\n  - \"--hf-token\"\n  - hf_abc\n  - --x\n",
                "args:\n  - \"--hf-token\"\n  - \u{27E6}redacted:6\u{27E7}\n  - --x\n",
            ),
            (
                Plain,
                "args: [\"--password\", \"pw\"]\n",
                "args: [\"--password\", ⟦redacted:5⟧\n",
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
        let mut bad = Vec::new();
        for (class, input, expected) in rows {
            let got = masked(*class, input);
            if &got != expected {
                bad.push(format!(
                    "class {class:?} input {input:?}\n   want {expected:?}\n   got  {got:?}"
                ));
            }
        }
        assert!(bad.is_empty(), "{}", bad.join("\n"));
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

    /// The fail-closed contract (design-r2): for each input, none of the listed
    /// secret substrings may survive in the masked view, whatever shape the value
    /// takes. One row per shape; a shape that leaks is a bug in the rules, not a
    /// reason to add a parser for that shape.
    #[test]
    fn no_byte_of_a_secret_value_survives_in_any_shape() {
        use FileClass::{Dotenv, PemKey, Plain};
        let rows: &[(FileClass, &str, &[&str])] = &[
            // value extent: spaces, quotes, bearer tokens, YAML '' , shell concatenation
            (
                Plain,
                "  - DB_PASSWORD=correct horse battery staple\n",
                &["horse", "battery", "staple"],
            ),
            (
                Plain,
                "Environment=\"DB_PASSWORD=correct horse\"\n",
                &["correct", "horse"],
            ),
            (
                Plain,
                "AUTH_TOKEN: Bearer eyJhbGciOi.payload.sig\n",
                &["Bearer", "eyJhbGciOi", "payload"],
            ),
            (
                Plain,
                "API_KEY: 'pa''ssword-tail'\n",
                &["ssword-tail", "pa'"],
            ),
            (Plain, "API_KEY='abc'\"defsecret\"\n", &["abc", "defsecret"]),
            (
                Plain,
                "export API_KEY=abc\\ defsecret\n",
                &["abc", "defsecret"],
            ),
            (
                Plain,
                "{\"a\":1,\"X_KEY\":\"s1\",\"b\":\"s2\"}\n",
                &["s1", "s2"],
            ),
            (Plain, "run --token a b c\n", &["a b c"]),
            // multi-line forms
            (
                Plain,
                "TLS_KEY: |\n  MIIEvQIBADAN\n  AQEFAASCBKcw\nother: 1\n",
                &["MIIEvQ", "AQEFAA"],
            ),
            (
                Plain,
                "API_KEY: >-\n  sk-live-folded\n",
                &["sk-live-folded"],
            ),
            (
                Plain,
                "TLS_KEY = \"\"\"\nMIIEtriple\n\"\"\"\n",
                &["MIIEtriple"],
            ),
            (
                Plain,
                "API_KEY = '''\nsk-live-triple\n'''\n",
                &["sk-live-triple"],
            ),
            (
                Plain,
                "export API_KEY=abc\\\ndefsecret\n",
                &["abc", "defsecret"],
            ),
            (Plain, "export API_KEY=\\\ndefsecret\n", &["defsecret"]),
            (
                Plain,
                "K_TOKEN=\"line1\nline2-secret\nline3-secret\"\n",
                &["line1", "line2-secret", "line3-secret"],
            ),
            (
                Plain,
                "K_TOKEN=\"a1\nb1\" X_KEY=\"c1\nd1\"\n",
                &["c1", "d1"],
            ),
            // env files: unknown means masked
            (
                Dotenv,
                "A=\"x\nMIIEbase64body=\n-----\"\n",
                &["MIIEbase64body"],
            ),
            (
                Dotenv,
                "not an assignment secret words\n",
                &["secret", "words"],
            ),
            (Dotenv, "A=\"x1\ny1\" B=\"s1\ns2\"\n", &["s1", "s2"]),
            (Dotenv, "# OLD_API_KEY=sk-live-old\n", &["sk-live-old"]),
            (Dotenv, "KEY: value with colon\n", &["value with colon"]),
            (
                Dotenv,
                "  export DB_URL = postgres://u:pw@h/db  # note\n",
                &["postgres", "pw"],
            ),
            (PemKey, "# note\nK_TOKEN=\"a\nb\"\n", &["b\""]),
        ];
        let mut leaks = Vec::new();
        for (class, input, secrets) in rows {
            let view = masked(*class, input);
            for secret in *secrets {
                if view.contains(secret) {
                    leaks.push(format!(
                        "{class:?} {input:?}: `{secret}` survives in {view:?}"
                    ));
                }
            }
        }
        assert!(leaks.is_empty(), "{}", leaks.join("\n"));
    }

    #[test]
    fn a_yaml_block_scalar_ends_at_the_first_dedent_and_blank_lines_do_not_end_it() {
        let text = "a:\n  TLS_KEY: |\n    line1\n\n    line2\n  other: shown\nb: shown\n";
        assert_eq!(
            masked(FileClass::Plain, text),
            "a:\n  TLS_KEY: \u{27E6}redacted:1\u{27E7}\n\u{27E6}redacted\u{27E7}\n\n\u{27E6}redacted\u{27E7}\n  other: shown\nb: shown\n"
        );
    }

    #[test]
    fn classification_ignores_case_and_secret_scopes_cover_their_directories() {
        use std::path::Path;
        for (path, class) in [
            ("/h/.ssh/ID_ED25519", FileClass::SshPrivateKey),
            ("/h/.ssh/ID_ED25519.PUB", FileClass::Plain),
            ("/p/.ENV", FileClass::Dotenv),
            ("/p/Prod.Env", FileClass::Dotenv),
            ("/p/.Env.Local", FileClass::Dotenv),
            ("/h/.Cache/HuggingFace/Token", FileClass::HfToken),
            ("/p/Server.PEM", FileClass::PemKey),
        ] {
            assert_eq!(classify(Path::new(path)), class, "{path}");
        }
        for path in [
            "/h/.ssh",
            "/h/.SSH/config",
            "/h/.ssh/keys/new",
            "/h/.huggingface",
            "/h/.cache/huggingface",
            "/h/.cache/HuggingFace/hub/x",
            "/h/.cache",
            "/p/.env",
        ] {
            assert!(is_secret_scope(Path::new(path)), "{path}");
        }
        for path in [
            "/h/.cache/pip/x",
            "/h/notes.txt",
            "/h/ssh/config",
            "/h/.sshd/x",
        ] {
            assert!(!is_secret_scope(Path::new(path)), "{path}");
        }
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
    fn merged_masks_are_counted_once_over_the_merged_range() {
        let line = "abcdef";
        let merged = merge(
            vec![
                (0..3, token(3)),
                (2..5, token(3)),
                (4..6, token(2)),
                (9..9, token(0)),
            ],
            "abcdef",
        );
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0], (0..6, token(line.chars().count())));
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
