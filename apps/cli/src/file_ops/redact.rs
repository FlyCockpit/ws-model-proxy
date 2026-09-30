//! Bounded secret masking for accidental disclosure (`design-r3.md`).
//!
//! In ordinary files, a case-insensitive secret-name word masks its WHOLE line
//! as `⟦redacted line⟧`, and the following non-blank line as
//! `⟦redacted line⟧`. Words are maximal `[A-Za-z0-9_-]+` runs that do not start
//! with `-`: they end in `_TOKEN`, `_KEY`, `_SECRET`, `_PASSWORD`, `apikey`,
//! `api-key`, `api_key`, `hf-token` or `hf_token`, or equal `PASSWORD`.
//! The suffix must end the word; `MAX_TOKENS`, `TOKENS` and `KEYBOARD` stay
//! visible. Words starting with `-` use the separate secret-flag rule, which
//! masks the value tail of `--api-key VALUE` and its continuations.
//!
//! Dotenv files retain their own rule: only blanks, comments and the KEY of a
//! simple `KEY=` / `export KEY=` line are shown; unknown lines are masked whole.
//! Comments containing a secret-name word use the whole-line rule. Hugging Face
//! token files and non-public `.ssh` files are masked by class. Private-key PEM
//! blocks are masked by content in every file through the matching END label;
//! an END closes only the innermost opener of its own label. Public keys and
//! certificates stay visible. There is no vendor-prefix credential scanner.
//!
//! A token line can open a quote, trailing backslash or YAML-like block. These
//! constructs end only at a structural boundary: a blank line, or a dedent for
//! a YAML block, never at a closing quote. Openers are scanned even inside masked
//! runs, and all open constructs contribute masks (restartable union semantics).
//! Reads feed the bounded [`LOOKBACK_BYTES`] context plus its preceding line;
//! constructs beyond that lookback are a documented residual. [`mask`]
//! records every replacement as a span without changing line counts. Edits
//! cannot touch spans or expose surviving masked bytes, and cannot create a
//! construct longer than the lookback. Mask markers are refused on write-back.
//!
//! Path classification is Unicode-folded, ignores trailing dots/spaces and
//! never searches other files. Secret-class paths and directories are read-only
//! through [`is_secret_scope`] and `Policy::check_path`.

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
    // trailing dots and spaces from every component (`.` and `..` stay).
    lowered
        .split('/')
        .map(|part| match part {
            "." | ".." => part,
            _ => part.trim_end_matches(['.', ' ']),
        })
        .collect::<Vec<_>>()
        .join("/")
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
    /// A masked multi-line run reaches further past its opening line than
    /// [`LOOKBACK_BYTES`]: a windowed read would not see the opener. An edit that
    /// creates such a run is refused (an agent could otherwise build one).
    pub long_construct: bool,
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

    fn from_parts(text: String, spans: Vec<Span>, long_construct: bool) -> Self {
        let mut delta: isize = 0;
        let cum = spans
            .iter()
            .map(|span| {
                delta += span.orig.len() as isize - span.view.len() as isize;
                delta
            })
            .collect();
        Self {
            text,
            spans,
            cum,
            long_construct,
        }
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

/// The end of a secret flag's name (`--api-key`, `--openai-api-key`, `-token`,
/// `--auth-token`, `--password`): the name must END with one of these, so
/// `--max-tokens`, `--tokenizer` and `--token-limit` stay visible.
const SECRET_FLAG_SUFFIX: &str = "api[-_]?key|token|secret|password";

static FLAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?:^|[^A-Za-z0-9_-])-{{1,2}}[A-Za-z0-9_-]*?(?:{SECRET_FLAG_SUFFIX})(=|[ \t]+|\\[nrt]|["']?,[ \t]*)"#
    ))
    .expect("flag regex")
});
static FLAG_AT_END: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?:^|[^A-Za-z0-9_-])-{{1,2}}[A-Za-z0-9_-]*?(?:{SECRET_FLAG_SUFFIX})["']?,?[ \t]*\\?[ \t\r]*$"#
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

/// `value` without a trailing shell line continuation that follows a blank
/// (`"$KEY" \`): the backslash continues the COMMAND, not the value.
fn without_continuation(value: &str) -> &str {
    match value.strip_suffix('\\') {
        Some(rest) if rest.ends_with([' ', '\t']) => rest.trim_end(),
        _ => value,
    }
}

/// Whether the value text is a bare variable reference or empty quotes. Quotes
/// count only as a MATCHED pair (`"$X"`): a lone leading or trailing quote is
/// part of a longer value.
fn value_is_public(value: &str) -> bool {
    // A lone backslash is a shell line continuation, not a value.
    if value.is_empty() || value == "\\" || value == "\"\"" || value == "''" {
        return true;
    }
    let inner = match (value.chars().next(), value.chars().next_back()) {
        (Some(open @ ('"' | '\'')), Some(close)) if open == close && value.len() >= 2 => {
            &value[1..value.len() - 1]
        }
        _ => value,
    };
    is_variable_reference(inner)
}

/// Whether a quote is still open at the end of `text` (scanned from outside any
/// quote, backslash escapes skipped). This only decides whether a masked value
/// CONTINUES on the next line; it never decides where masking ends (that is a
/// blank line or a dedent, see [`Construct`]). Any `"` or `'` counts, so
/// `abc'def`, `'a'"b` and doubled `''` all fail closed: an odd shape is a
/// continuation.
fn quote_left_open(text: &str) -> bool {
    let mut open: Option<char> = None;
    let mut escaped = false;
    for ch in text.chars() {
        if escaped {
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else {
            match open {
                Some(quote) if ch == quote => open = None,
                Some(_) => {}
                None if ch == '"' || ch == '\'' => open = Some(ch),
                None => {}
            }
        }
    }
    open.is_some()
}

/// A multi-line value that the masked tail of a line opened. Masking ends only
/// at a structural boundary that needs no quote parsing: never at a closing
/// quote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Construct {
    None,
    /// A quote left open, a trailing `\`, shell concatenation: every following
    /// line is masked until the first BLANK line (or the end of the region).
    UntilBlank,
    /// A YAML-like value (`key: ...`): masked while lines are blank or indented
    /// deeper than the KEY LINE (its own leading-whitespace width, so a quoted
    /// key or a `- ` item does not shift the threshold); the first non-blank line
    /// at or below that indentation ends it.
    Block {
        line_indent: usize,
    },
}

/// The construct that the value text `tail` opens. `colon` marks a YAML-like
/// `key: value`: whatever its value, a deeper-indented line after it is a
/// continuation of the scalar (or invalid YAML), so it ends only at a dedent to
/// the key line's indentation. `line_quote_open` is whether a quote is still open
/// at the end of the WHOLE line (a string opened before the name and closed in
/// the tail, as in `echo "K_TOKEN=$X" > f`, does not count).
fn construct_for_tail(
    tail: &str,
    colon: bool,
    line_indent: usize,
    line_quote_open: bool,
) -> Construct {
    let trimmed = tail.trim();
    if colon && BLOCK_SCALAR.is_match(trimmed) {
        return Construct::Block { line_indent };
    }
    if trimmed.ends_with('\\') || line_quote_open {
        // Stricter than a YAML dedent: a quoted or continued value may sit at any
        // indentation in the many YAML-like files that are not valid YAML.
        return Construct::UntilBlank;
    }
    if colon {
        return Construct::Block { line_indent };
    }
    Construct::None
}

type LineMask = (Range<usize>, String);

/// Maximal ASCII words are scanned once; suffix checks inspect only their ends.
/// A dash-prefixed word belongs exclusively to the flag recognizer.
fn first_secret_name(line: &str) -> Option<Range<usize>> {
    let bytes = line.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if !(bytes[at].is_ascii_alphanumeric() || matches!(bytes[at], b'_' | b'-')) {
            at += 1;
            continue;
        }
        let start = at;
        while at < bytes.len()
            && (bytes[at].is_ascii_alphanumeric() || matches!(bytes[at], b'_' | b'-'))
        {
            at += 1;
        }
        let word = &bytes[start..at];
        if word[0] != b'-'
            && (word.eq_ignore_ascii_case(b"PASSWORD")
                || [
                    &b"_TOKEN"[..],
                    b"_KEY",
                    b"_SECRET",
                    b"_PASSWORD",
                    b"apikey",
                    b"api-key",
                    b"api_key",
                    b"hf-token",
                    b"hf_token",
                ]
                .iter()
                .any(|suffix| {
                    word.len() >= suffix.len()
                        && word[word.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
                }))
        {
            return Some(start..at);
        }
    }
    None
}

/// The constructs after a token, without parsing assignments or file formats.
/// A quoted YAML key may end just before its colon. Quote parity is always
/// computed over the entire line, including text before the token.
fn construct_after_name(line: &str, end: usize) -> Construct {
    let tail = line[end..].trim_start_matches([' ', '\t', '\'', '"']);
    let (tail, colon) = match tail.strip_prefix(':') {
        Some(tail) => (tail, true),
        None => (tail, false),
    };
    construct_for_tail(tail, colon, indent_of(line), quote_left_open(line))
}

/// The multi-line value the line after a token line opens (`value: |`, `value: >-`,
/// an open quote, a trailing backslash): a `key:` whose key is identifier-like
/// opens a YAML block; any other colon (`for x in y:`) is code, not a header.
fn value_line_construct(line: &str) -> Construct {
    match line.find(':') {
        Some(colon) if key_like(&line[..colon]) => construct_for_tail(
            &line[colon + 1..],
            true,
            indent_of(line),
            quote_left_open(line),
        ),
        _ => construct_for_tail(line, false, indent_of(line), quote_left_open(line)),
    }
}

/// Whether `before` (the text before a colon) is a YAML/JSON-style key: an optional
/// list dash, then an identifier-like word, possibly quoted.
fn key_like(before: &str) -> bool {
    let word = before.trim();
    let word = word.strip_prefix("- ").unwrap_or(word).trim();
    let word = word.trim_matches(['"', '\'']);
    !word.is_empty()
        && word
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// One secret flag candidate: where its masked tail starts and what it opens.
type Candidate = (usize, Construct);

/// The first secret flag of `line` (`--token abc`, `--api-key=abc`).
fn first_flag(line: &str) -> Option<Candidate> {
    if !line.contains('-')
        || !["token", "key", "secret", "password"]
            .iter()
            .any(|word| line.contains(word))
    {
        return None;
    }
    let mut pos = 0_usize;
    while let Some(caps) = FLAG.captures_at(line, pos) {
        let Some(whole) = caps.get(0) else {
            break;
        };
        let start = whole.end();
        pos = start;
        // The next token is the value whatever its first character: a secret can
        // start with `-`, and over-masking a following public option is fine.
        let tail = &line[start..];
        let trimmed = tail.trim_end();
        if trimmed == "\\" {
            return Some((line.len(), Construct::UntilBlank));
        }
        if value_is_public(without_continuation(trimmed)) {
            continue;
        }
        return Some((
            start,
            construct_for_tail(tail, false, indent_of(line), quote_left_open(line)),
        ));
    }
    None
}

/// The mask for the tail of `line` starting at `start` (none when empty), to the
/// very end of the physical line: the caller has already removed the line
/// terminator, and trailing whitespace can be part of a secret.
fn tail_mask(line: &str, start: usize) -> Option<LineMask> {
    let end = line.len();
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
    if start >= line.len() {
        return None;
    }
    let end = line.len();
    let value = line[start..end].trim_end();
    if value == "\\" {
        return Some((line.len()..line.len(), Construct::UntilBlank));
    }
    if value_is_public(without_continuation(value)) {
        return None;
    }
    // a list item that is a block-scalar header (`- >-`) continues on the next lines
    let block_item = BLOCK_SCALAR.is_match(value);
    Some((
        start..end.max(start),
        construct_for_tail(
            &line[start..],
            block_item,
            if block_item {
                trimmed_start
            } else {
                indent_of(line)
            },
            quote_left_open(line),
        ),
    ))
}

/// The private-key BEGIN/END markers of `line` in order, with their labels
/// (`true` for a BEGIN). A marker is `-----BEGIN <label>-----` /
/// `-----END <label>-----`; it is a private key marker when the label ends in
/// `PRIVATE KEY` (plain, RSA, EC, DSA, OPENSSH, ENCRYPTED). Public keys and
/// certificates are not. Several markers may share a line.
fn pem_events(line: &str) -> Vec<(bool, &str)> {
    let mut events = Vec::new();
    let mut at = 0;
    while let Some(found) = line[at..].find("-----") {
        let start = at + found;
        let rest = &line[start + 5..];
        let (is_begin, label_start) = if let Some(r) = rest.strip_prefix("BEGIN ") {
            (Some(true), r)
        } else if let Some(r) = rest.strip_prefix("END ") {
            (Some(false), r)
        } else {
            (None, rest)
        };
        if let Some(begin) = is_begin
            && let Some(label_end) = label_start.find("-----")
        {
            let label = &label_start[..label_end];
            if label.ends_with("PRIVATE KEY") {
                events.push((begin, label));
            }
            // the closing dashes may be the opening dashes of the next marker
            at = start + 5 + (rest.len() - label_start.len()) + label_end;
            continue;
        }
        at = start + 5;
    }
    events
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// One open YAML-like block: it masks lines indented deeper than `indent` until
/// a non-blank line at or below it.
#[derive(Debug, Clone, Copy)]
struct OpenBlock {
    indent: usize,
    opener: usize,
}

/// Line-oriented masker. Feed lines (without terminators) in file order.
///
/// The state is RESTARTABLE: opener detection runs on every line, also lines that
/// an earlier value already masks, and constructs are kept side by side (union
/// semantics: a line is masked when ANY open construct masks it). So a masker
/// started at any line masks at least what a masker started at the top masks,
/// except for values that were opened before its start line. The lines within
/// [`LOOKBACK_BYTES`] before a window are fed first; a masked run reaching past
/// the lookback from its (latest) opener is flagged ([`Self::long_run`]) and edits
/// refuse to create one.
///
/// State: per-label PEM opener lists, previous-line secret token/flag flags,
/// an until-blank run and open YAML blocks. Command output reuses this scanner.
#[derive(Debug, Clone)]
pub struct LineMasker {
    class: FileClass,
    lookback: usize,
    /// Open `-----BEGIN <label>-----` private-key blocks per label: the offsets of
    /// their BEGIN lines. An END closes the innermost block of the SAME label. No
    /// cap: a dropped BEGIN would leave its body visible.
    pem_open: std::collections::BTreeMap<String, Vec<usize>>,
    /// Offsets of every open BEGIN with their counts: the latest one is an O(log n)
    /// lookup, so a file with thousands of distinct labels stays linear.
    pem_latest: std::collections::BTreeMap<usize, usize>,
    pending_flag_value: bool,
    /// Offset of the latest opener of the run that masks lines until a blank line.
    until_blank: Option<usize>,
    blocks: Vec<OpenBlock>,
    /// The previous line contained a secret-name token (one line of scope).
    pending_token_line: bool,
    /// Offset of the next line when the caller does not supply one.
    next_at: usize,
    long_run: bool,
}

impl LineMasker {
    pub fn new(class: FileClass) -> Self {
        Self::with_lookback(class, LOOKBACK_BYTES)
    }

    pub(crate) fn with_lookback(class: FileClass, lookback: usize) -> Self {
        Self {
            class,
            lookback,
            pem_open: std::collections::BTreeMap::new(),
            pem_latest: std::collections::BTreeMap::new(),
            pending_flag_value: false,
            until_blank: None,
            blocks: Vec::new(),
            pending_token_line: false,
            next_at: 0,
            long_run: false,
        }
    }

    pub fn class(&self) -> FileClass {
        self.class
    }

    /// Whether a masked multi-line run reached further than the lookback past
    /// its opener on any line so far: a windowed read could not see the opener.
    pub fn long_run(&self) -> bool {
        self.long_run
    }

    /// Whether a multi-line value that started on an earlier line is still open:
    /// the following lines are masked until it ends.
    pub fn in_continuation(&self) -> bool {
        self.until_blank.is_some() || !self.blocks.is_empty() || !self.pem_open.is_empty()
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
        let at = self.next_at;
        self.scan_at(line, at)
    }

    /// [`Self::scan`] for a line that starts at byte `at` of the text (the caller
    /// knows the exact offsets: this only feeds [`Self::long_run`]).
    pub(crate) fn scan_at(&mut self, line: &str, at: usize) -> Vec<(Range<usize>, String)> {
        self.next_at = at + line.len() + 1;
        let blank = line.trim().is_empty();
        // 1. which open constructs mask this line (the latest opener decides how far
        //    back a reader would have to look)
        let mut masked_by: Option<usize> = None;
        if blank {
            // a blank line ends the until-blank run; blocks pass through it
            self.until_blank = None;
        } else {
            let indent = indent_of(line);
            self.blocks.retain(|block| block.indent < indent);
            masked_by = self
                .blocks
                .iter()
                .map(|block| block.opener)
                .chain(self.until_blank)
                .max();
        }
        // private-key blocks (any file): from a BEGIN line through the END line of the
        // same label. The markers of a line apply in byte order (`END CERT-----BEGIN
        // KEY` opens one); a mismatched END closes nothing (fail closed); several
        // blocks may be open at once, and the latest opener charges the lookback.
        let pem_open_at_start = self.pem_latest.keys().next_back().copied();
        let mut pem_touched = pem_open_at_start.is_some();
        for (begin, label) in pem_events(line) {
            pem_touched = true;
            if begin {
                self.pem_open.entry(label.to_string()).or_default().push(at);
                *self.pem_latest.entry(at).or_insert(0) += 1;
            } else if let Some(openers) = self.pem_open.get_mut(label) {
                if let Some(opener) = openers.pop()
                    && let Some(count) = self.pem_latest.get_mut(&opener)
                {
                    *count -= 1;
                    if *count == 0 {
                        self.pem_latest.remove(&opener);
                    }
                }
                if openers.is_empty() {
                    self.pem_open.remove(label);
                }
            }
        }
        let pem_opener = pem_open_at_start.or(pem_touched.then_some(at));
        masked_by = masked_by.max(pem_opener);
        // 2. the line's own rules and openers, always (union semantics)
        let (masks, opened) = self.scan_body(line);
        if let Some(opener) = masked_by
            && at.saturating_sub(opener) > self.lookback
        {
            self.long_run = true;
        }
        // 3. register what this line opened or closed
        for construct in opened {
            match construct {
                Construct::None => {}
                Construct::UntilBlank => self.until_blank = Some(at),
                Construct::Block { line_indent } => {
                    self.blocks.retain(|block| block.indent != line_indent);
                    self.blocks.push(OpenBlock {
                        indent: line_indent,
                        opener: at,
                    });
                }
            }
        }
        // PEM content stays opaque even when its body happens to contain a name.
        if pem_touched {
            return vec![(0..line.len(), token_bare())];
        }
        if masked_by.is_some() {
            if masks.len() == 1
                && masks
                    .first()
                    .is_some_and(|(range, _)| range.start == 0 && range.end == line.len())
            {
                return masks;
            }
            return vec![(0..line.len(), token_bare())];
        }
        if masks.is_empty() {
            masks
        } else {
            merge(masks, line)
        }
    }

    /// The class and generic rules over `line` (ranges relative to `line`).
    fn scan_body(&mut self, line: &str) -> (Vec<LineMask>, Vec<Construct>) {
        let mut masks: Vec<LineMask> = Vec::new();
        // every recognizer that fires contributes its opener: none replaces another
        let mut constructs: Vec<Construct> = Vec::new();
        let mut generic = true;
        match self.class {
            FileClass::SshPrivateKey => {
                generic = false;
                if !line.trim().is_empty() {
                    masks.push((0..line.len(), token_bare()));
                }
            }
            FileClass::HfToken => {
                generic = false;
                if !line.trim().is_empty() {
                    masks.push((0..line.len(), token(line.chars().count())));
                }
            }
            FileClass::PemKey | FileClass::Plain => {}
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
                    constructs.push(construct_for_tail(
                        &line[m.end()..],
                        false,
                        indent_of(line),
                        quote_left_open(line),
                    ));
                } else {
                    masks.push((0..line.len(), token_bare()));
                    constructs.push(construct_for_tail(
                        line,
                        false,
                        indent_of(line),
                        quote_left_open(line),
                    ));
                }
            }
        }
        if generic {
            if self.pending_flag_value
                && let Some((range, opened)) = continuation_value(line)
            {
                masks.extend(tail_mask(line, range.start));
                constructs.push(opened);
            }
            if let Some(name) = first_secret_name(line) {
                constructs.push(construct_after_name(line, name.end));
                if self.pending_token_line {
                    // this is also the value's line after a token line (`value: | # API_KEY
                    // is injected`): its own multi-line opener is kept next to the token's
                    constructs.push(value_line_construct(line));
                }
                // the marker never copies text of the line (a word that looks like a
                // secret name can itself be the secret value: `--password admin_password`)
                masks = vec![(0..line.len(), format!("{MASK_OPEN} line{MASK_CLOSE}"))];
                self.pending_token_line = true;
            } else {
                if let Some((start, opened)) = first_flag(line) {
                    masks.extend(tail_mask(line, start));
                    constructs.push(opened);
                }
                if self.pending_token_line && !line.trim().is_empty() {
                    masks = vec![(0..line.len(), format!("{MASK_OPEN} line{MASK_CLOSE}"))];
                    // the line after a token line is the value's line (`value: |` after
                    // `name: API_KEY`): a multi-line value that it opens goes on to a
                    // structural end (blank line, dedent), like a value on the token line
                    constructs.push(value_line_construct(line));
                }
                self.pending_token_line = false;
            }
        } else {
            self.pending_token_line = false;
        }
        self.pending_flag_value = line.contains('-') && FLAG_AT_END.is_match(line);
        (masks, constructs)
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
    mask_with_lookback(class, text, LOOKBACK_BYTES)
}

/// [`mask`] with an explicit lookback (tests use a tiny one).
pub(crate) fn mask_with_lookback(class: FileClass, text: &str, lookback: usize) -> MaskedView {
    let mut masker = LineMasker::with_lookback(class, lookback);
    let mut out = String::with_capacity(text.len());
    let mut spans = Vec::new();
    let mut offset = 0;
    for raw in text.split_inclusive('\n') {
        let body_len = raw.trim_end_matches(['\n', '\r']).len();
        let (line, ending) = raw.split_at(body_len);
        let mut cursor = 0;
        let masks = masker.scan_at(line, offset);
        for (range, tok) in masks {
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
    MaskedView::from_parts(out, spans, masker.long_run())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(class: FileClass, text: &str) -> String {
        mask(class, text).text
    }

    /// Real configuration samples go through one format-agnostic token rule.
    #[test]
    fn real_world_samples_mask_values_without_format_grammars() {
        // Values are ordinary fixture text, not vendor credential patterns.
        let rows = [
            (
                "dotenv",
                FileClass::Dotenv,
                "# service\nAPI_KEY=value-one\nPORT=8080\n",
                "value-one",
            ),
            (
                "compose list",
                FileClass::Plain,
                "services:\n  app:\n    environment:\n      - api_key=value-one\n      - PORT=8080\n",
                "value-one",
            ),
            (
                "compose map",
                FileClass::Plain,
                "services:\n  app:\n    environment:\n      Db_Password: value-one\n      PORT: 8080\n",
                "value-one",
            ),
            (
                "Kubernetes",
                FileClass::Plain,
                "env:\n  - name: openai_api_key\n    value: value-one\n",
                "value-one",
            ),
            (
                "Kubernetes inline reversed",
                FileClass::Plain,
                "env:\n  - {value: value-one, name: API_KEY}\n",
                "value-one",
            ),
            (
                "Kubernetes reference",
                FileClass::Plain,
                "env:\n  - name: API_KEY\n    valueFrom: {secretKeyRef: {name: value-one, key: credential}}\n",
                "value-one",
            ),
            (
                "JSON",
                FileClass::Plain,
                "{\"apiKey\": \"value-one\", \"public\": true}\n",
                "value-one",
            ),
            (
                "JSON separate value",
                FileClass::Plain,
                "{\"api-key\":\n  \"value-one\"}\n",
                "value-one",
            ),
            (
                "Dockerfile ENV",
                FileClass::Plain,
                "FROM scratch\nENV api_key value-one\n",
                "value-one",
            ),
            (
                "Dockerfile ARG",
                FileClass::Plain,
                "FROM scratch\nARG db_password=value-one\n",
                "value-one",
            ),
            (
                "shell export",
                FileClass::Plain,
                "export Hf_Token='value-one'\n",
                "value-one",
            ),
            (
                "Python",
                FileClass::Plain,
                "os.environ[\"api_key\"] = \"value-one\"\n",
                "value-one",
            ),
            (
                "Node",
                FileClass::Plain,
                "const config = { apiKey: 'value-one' };\n",
                "value-one",
            ),
            (
                "Actions env",
                FileClass::Plain,
                "env:\n  API_KEY: value-one\n",
                "value-one",
            ),
            (
                "Actions with",
                FileClass::Plain,
                "with:\n  api-key: value-one\n",
                "value-one",
            ),
            (
                "Actions run",
                FileClass::Plain,
                "run: echo \"API_KEY=$X\" >> $GITHUB_ENV\n",
                "$X",
            ),
        ];
        for (sample, class, input, value) in rows {
            let view = mask(class, input);
            assert!(!view.text.contains(value), "{sample}: {:?}", view.text);
            assert!(!view.spans.is_empty(), "{sample}");
            if class == FileClass::Plain {
                assert!(
                    view.text.contains("⟦redacted line⟧"),
                    "{sample}: {:?}",
                    view.text
                );
            }
            assert_eq!(
                view.text.matches('\n').count(),
                input.matches('\n').count(),
                "{sample}"
            );
        }
    }

    /// The line after a token line is the value's line; a multi-line value that it
    /// opens keeps masking to a structural end (Kubernetes `value: |`, folded, quoted).
    #[test]
    fn a_token_line_followed_by_a_multi_line_value_masks_the_whole_value() {
        for (sample, input, secrets, visible) in [
            (
                "literal block",
                "env:\n  - name: API_KEY\n    value: |\n      value-one\n      value-two\n  - name: PORT\n    value: \"8080\"\n",
                &["value-one", "value-two"][..],
                "PORT",
            ),
            (
                "folded block",
                "env:\n  - name: DB_PASSWORD\n    value: >-\n      value-one\n      value-two\nnext: 1\n",
                &["value-one", "value-two"][..],
                "next: 1",
            ),
            (
                "quoted multi-line",
                "- name: X_TOKEN\n  value: \"value-one\n    value-two\"\n\nnext: 1\n",
                &["value-one", "value-two"][..],
                "next: 1",
            ),
            (
                "JSON separate lines",
                "{\"name\": \"HF_TOKEN\",\n \"value\": \"value-one\"}\n",
                &["value-one"][..],
                "",
            ),
        ] {
            let view = mask(FileClass::Plain, input).text;
            for secret in secrets {
                assert!(!view.contains(secret), "{sample}: {view:?}");
            }
            assert!(view.contains(visible), "{sample}: {view:?}");
        }
    }

    /// A colon that is not a `key:` header on the line after a token line (Python
    /// `for`/`def`, prose `Usage:`) does not open a block: only the next line is masked.
    #[test]
    fn code_after_a_token_line_is_not_swallowed_by_a_value_block() {
        for input in [
            "headers = {\"Authorization\": f\"Bearer {API_KEY}\"}\nfor attempt in range(3):\n    time.sleep(2 ** attempt)\n",
            "OPENAI_API_KEY = os.environ[\"OPENAI_API_KEY\"]\ndef main():\n    run_public_code()\n",
        ] {
            let view = mask(FileClass::Plain, input).text;
            assert!(
                view.contains("time.sleep") || view.contains("run_public_code"),
                "{view:?}"
            );
        }
        // a secret flag whose value is a block-scalar list item keeps the value masked
        let view = mask(
            FileClass::Plain,
            "args:\n  - --api-key\n  - >-\n    flag-value-one\nnext: 1\n",
        )
        .text;
        assert!(
            !view.contains("flag-value-one") && view.contains("next: 1"),
            "{view:?}"
        );
    }

    /// A comment on the value header that itself holds a secret-name word must not
    /// suppress the header's block, and a value that is itself a secret-name word is
    /// never copied into the marker.
    #[test]
    fn token_words_in_headers_and_values_do_not_break_masking_or_echo_the_value() {
        for (input, hidden) in [
            (
                "- name: API_KEY\n  value: | # API_KEY is injected by deployment\n    line-one\n    line-two\nnext: 1\n",
                &["line-one", "line-two"][..],
            ),
            (
                "- name: DB_PASSWORD\n  value: >- # loaded from DATABASE_PASSWORD\n    line-one\n    line-two\nnext: 1\n",
                &["line-one", "line-two"][..],
            ),
            (
                "run --password admin_password --verbose\n",
                &["admin_password"][..],
            ),
            (
                "run --password\nadmin_password\nnext\n",
                &["admin_password"][..],
            ),
            (
                "- name: DB_PASSWORD\n  value: admin_password\nnext: 1\n",
                &["admin_password"][..],
            ),
        ] {
            let view = mask(FileClass::Plain, input).text;
            for value in hidden {
                assert!(!view.contains(value), "{input:?} -> {view:?}");
            }
            assert!(
                view.contains("next") || input.contains("admin_password"),
                "{view:?}"
            );
        }
        let dotenv = mask(
            FileClass::Dotenv,
            "A=\"first\n# admin_password\nlast\"\nB=x\n",
        )
        .text;
        assert!(!dotenv.contains("admin_password"), "{dotenv:?}");
    }

    /// Every recognizer that fires on a line contributes its opener (none replaces
    /// another): a value header whose comment holds an apostrophe AND a token word,
    /// and a flag's block-scalar item with a token comment.
    #[test]
    fn openers_from_several_recognizers_on_one_line_are_all_kept() {
        for (sample, input, hidden) in [
            (
                "apostrophe comment with a token word, blank line inside the block",
                "env:\n  - name: API_KEY\n    value: | # the API_KEY's value\n      line-one\n\n      probe-line-two\nnext: 1\n",
                "probe-line-two",
            ),
            (
                "password flag, literal block item with a token comment",
                "args:\n  - --password\n  - | # DB_PASSWORD comes from deployment\n    line-one\n    probe-line-two\nnext: 1\n",
                "probe-line-two",
            ),
            (
                "flag block item with a token comment",
                "args:\n  - --api-key\n  - >- # API_KEY from vault\n    line-one\n    probe-line-two\nnext: 1\n",
                "probe-line-two",
            ),
        ] {
            let view = mask(FileClass::Plain, input).text;
            assert!(!view.contains(hidden), "{sample}: {view:?}");
            assert!(view.contains("next: 1"), "{sample}: {view:?}");
        }
    }

    #[test]
    fn token_words_mask_whole_lines_and_exactly_one_following_nonblank_line() {
        for name in [
            "_TOKEN",
            "_KEY",
            "_SECRET",
            "_PASSWORD",
            "Password",
            "9_api_key",
            "openaiApiKey",
            "api-key",
            "hf-token",
            "Hf_Token",
            "aPi_kEy",
            "my-PASSWORD_KEY",
        ] {
            let text = format!("prefix {name} suffix\r\nnext value\r\nvisible\r\n");
            let view = mask(FileClass::Plain, &text);
            assert_eq!(
                view.text,
                "⟦redacted line⟧\r\n⟦redacted line⟧\r\nvisible\r\n".to_string()
            );
            assert_eq!(view.spans.len(), 2);
            assert_eq!(
                &text[view.spans[0].orig.clone()],
                format!("prefix {name} suffix")
            );
            assert_eq!(&text[view.spans[1].orig.clone()], "next value");
            assert!(view.overlaps_span(&view.spans[0].view));
            assert!(view.overlaps_span(&view.spans[1].view));
        }
        for blank in ["", "  \t"] {
            let text = format!("API_KEY anything\n{blank}\nvisible\n");
            assert_eq!(
                masked(FileClass::Plain, &text),
                format!("⟦redacted line⟧\n{blank}\nvisible\n")
            );
        }
        assert_eq!(
            masked(FileClass::Plain, "x API_KEY\ny HF_TOKEN\nz\nvisible\n"),
            "⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted line⟧\nvisible\n"
        );
        assert_eq!(
            masked(FileClass::Plain, "é API_KEY=é\n"),
            "⟦redacted line⟧\n"
        );
    }

    #[test]
    fn nonsecret_words_and_public_content_stay_visible() {
        let public = pem("PUBLIC KEY", "PUBLICBODY\n");
        let cert = pem("CERTIFICATE", "CERTBODY\n");
        let aws = aws_style_id();
        for text in [
            "max_tokens=4096\n",
            "MAX_TOKENS=4096\n",
            "--max-tokens 4096\n",
            "TOKENS\n",
            "KEYBOARD\n",
            "TOKEN=example\n",
            "KEY=example\n",
            "MYPASSWORD=example\n",
            "PASSWORDPASSWORD\n",
            "A_TOKENB\n",
            "API_KEYS\n",
            "api-key-file\n",
            "hf-tokenizer\n",
            "plain prose about a token and a key\n",
            "--api-key-file path\n",
            "--tokenizer gpt2 --token-limit 5\n",
            public.as_str(),
            cert.as_str(),
            aws.as_str(),
        ] {
            assert_eq!(masked(FileClass::Plain, text), text, "{text:?}");
        }
    }

    #[test]
    fn dotenv_and_secret_flags_keep_their_class_and_tail_rules() {
        let private_block = pem("PRIVATE KEY", "API_KEY\n");
        for (class, text, expected) in [
            (
                FileClass::Dotenv,
                "HF_TOKEN=value-one\nPORT=8080\n",
                "HF_TOKEN=⟦redacted:9⟧\nPORT=⟦redacted:4⟧\n",
            ),
            (
                FileClass::Dotenv,
                "# apiKey=value-one\n# next\n# shown\n",
                "⟦redacted line⟧\n⟦redacted line⟧\n# shown\n",
            ),
            (
                FileClass::Dotenv,
                "A=\nB=\"x\"\nunknown line\n",
                "A=\nB=⟦redacted:3⟧\n⟦redacted⟧\n",
            ),
            (FileClass::Dotenv, "# comment\n\n", "# comment\n\n"),
            (
                FileClass::Plain,
                "run --api-key value-one --ctx 4\nvisible\n",
                "run --api-key ⟦redacted:17⟧\nvisible\n",
            ),
            (
                FileClass::Plain,
                "--hf-token=value-one\n",
                "--hf-token=⟦redacted:9⟧\n",
            ),
            (
                FileClass::Plain,
                "run --token\n-value\nvisible\n",
                "run --token\n⟦redacted:6⟧\nvisible\n",
            ),
            (
                FileClass::Plain,
                "--api-key=$KEY\nvisible\n",
                "--api-key=$KEY\nvisible\n",
            ),
            (
                FileClass::Plain,
                "args:\n  - \"--hf-token\"\n  - value-one\n  - --x\n",
                "args:\n  - \"--hf-token\"\n  - ⟦redacted:9⟧\n  - --x\n",
            ),
            (
                FileClass::Plain,
                "--api-key \\\nvalue-one \\\nnext\n\nvisible\n",
                "--api-key \\\n⟦redacted:11⟧\n⟦redacted⟧\n\nvisible\n",
            ),
            (FileClass::HfToken, "value-one\n\n", "⟦redacted:9⟧\n\n"),
            (FileClass::HfToken, "apiKey\n", "⟦redacted:6⟧\n"),
            (FileClass::SshPrivateKey, "API_KEY\n", "⟦redacted⟧\n"),
            (
                FileClass::Plain,
                private_block.as_str(),
                "⟦redacted⟧\n⟦redacted⟧\n⟦redacted⟧\n",
            ),
        ] {
            assert_eq!(masked(class, text), expected, "{class:?}: {text:?}");
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
    /// files, plus private-key blocks in ANY file (owner decision).
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
        // a private key pasted into a plain file IS masked (owner decision: content-based)
        let pasted = pem("PRIVATE KEY", "K\n");
        assert_eq!(masked(FileClass::Plain, &pasted), bare.repeat(3));
    }

    /// Owner decision: whenever a `BEGIN ... PRIVATE KEY` line appears in any file,
    /// everything through the matching `END` line is masked; no END masks to the end
    /// of what is scanned; public keys and certificates stay visible.
    #[test]
    fn private_key_blocks_are_masked_in_any_file_by_content() {
        let kinds = [
            "PRIVATE KEY",
            "RSA PRIVATE KEY",
            "EC PRIVATE KEY",
            "DSA PRIVATE KEY",
            "OPENSSH PRIVATE KEY",
            "ENCRYPTED PRIVATE KEY",
        ];
        for kind in kinds {
            let (begin, end) = (
                format!("-----BEGIN {kind}-----"),
                format!("-----END {kind}-----"),
            );
            for class in [FileClass::Plain, FileClass::Dotenv, FileClass::PemKey] {
                let text = format!("before\n{begin}\nBODYLINEONE\nBODYLINETWO\n{end}\nafter\n");
                let view = masked(class, &text);
                assert!(!view.contains("BODYLINE"), "{kind} {class:?}: {view:?}");
                assert!(
                    !view.contains("BEGIN") && !view.contains("END"),
                    "{kind} {class:?}: {view:?}"
                );
                if class == FileClass::Plain {
                    assert!(
                        view.starts_with("before\n") && view.ends_with("after\n"),
                        "{view:?}"
                    );
                }
            }
            // embedded in YAML (indented block scalar), JSON (one line), and a doc
            let yaml = format!("key: |\n  {begin}\n  BODYLINEONE\n  {end}\nnext: 1\n");
            let view = masked(FileClass::Plain, &yaml);
            assert!(
                !view.contains("BODYLINE") && view.ends_with("next: 1\n"),
                "{view:?}"
            );
            let json = format!("{{\"k\": \"{begin}\\nBODYLINEONE\\n{end}\\n\", \"n\": 1}}\n");
            assert!(!masked(FileClass::Plain, &json).contains("BODYLINE"));
            // no END: masked to the end of what is scanned
            let open = format!("head\n{begin}\nBODYLINEONE\nBODYLINETWO\n");
            let view = masked(FileClass::Plain, &open);
            assert_eq!(view.matches("BODYLINE").count(), 0, "{view:?}");
            assert!(view.starts_with("head\n"));
        }
        // an END binds to its own label; a mismatched END closes nothing (fail closed);
        // nested and same-line transitions keep every open block masked
        let marker = |kind: &str, label: &str| format!("-----{kind} {label}-----");
        let (ec_open, rsa_open) = (
            marker("BEGIN", "EC PRIVATE KEY"),
            marker("BEGIN", "RSA PRIVATE KEY"),
        );
        let (ec_end, rsa_end) = (
            marker("END", "EC PRIVATE KEY"),
            marker("END", "RSA PRIVATE KEY"),
        );
        for (text, must_end_visible) in [
            (format!("{ec_open}\nBODYA\n{rsa_end}\nBODYB\n"), false),
            (
                format!("{rsa_open}\n{ec_open}\nBODYA\n{ec_end}\nBODYB\n{rsa_end}\ntail\n"),
                true,
            ),
            (
                format!("{ec_end}{rsa_open}\nBODYA\nBODYB\n{rsa_end}\ntail\n"),
                true,
            ),
            (
                format!("{rsa_end}{ec_open}\nBODYA\n{ec_end}{rsa_open}\nBODYB\n{rsa_end}\ntail\n"),
                true,
            ),
        ] {
            let view = masked(FileClass::Plain, &format!("head\n{text}"));
            assert!(!view.contains("BODY"), "{text:?} -> {view:?}");
            assert!(view.starts_with("head\n"), "{view:?}");
            assert!(!must_end_visible || view.ends_with("tail\n"), "{view:?}");
        }
        // no cap on open blocks: 20 BEGINs, closed one END at a time, keep the rest masked
        let begin = marker("BEGIN", "RSA PRIVATE KEY");
        let end = marker("END", "RSA PRIVATE KEY");
        let deep = format!(
            "{}BODYDEEP\n{}tail\n",
            format!("{begin}\n").repeat(20),
            format!("{end}\n").repeat(19)
        );
        let view = masked(FileClass::Plain, &deep);
        assert!(
            !view.contains("BODYDEEP") && !view.ends_with("tail\n"),
            "{view:?}"
        );
        // markers that share their hyphens: `END CERT-----BEGIN KEY`
        let shared = format!("head\n-----END CERTIFICATE{begin}\nSHAREDBODY\n{end}\ntail\n");
        let view = masked(FileClass::Plain, &shared);
        assert!(
            !view.contains("SHAREDBODY") && view.ends_with("tail\n"),
            "{view:?}"
        );
        // public keys and certificates stay visible
        for label in [
            "PUBLIC KEY",
            "CERTIFICATE",
            "RSA PUBLIC KEY",
            "CERTIFICATE REQUEST",
        ] {
            let text = pem(label, "PUBLICBODY\n");
            assert_eq!(masked(FileClass::Plain, &text), text, "{label}");
        }
        // a private key that follows a certificate in the same file
        let both = format!(
            "{}{}tail\n",
            pem("CERTIFICATE", "CERTBODY\n"),
            pem("PRIVATE KEY", "KEYBODY\n")
        );
        let view = masked(FileClass::Plain, &both);
        assert!(
            view.contains("CERTBODY") && !view.contains("KEYBODY") && view.ends_with("tail\n"),
            "{view:?}"
        );
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
        let text = "a=1\nB_TOKEN=hunter22\nz=9\n\nend\n";
        let view = mask(FileClass::Plain, text);
        assert_eq!(view.text, "a=1\n⟦redacted line⟧\n⟦redacted line⟧\n\nend\n");
        assert_eq!(view.redactions(), 2);
        let z_view = view.text.find("end").unwrap();
        let z_orig = text.find("end").unwrap();
        assert_eq!(view.to_orig(z_view), z_orig);
        let span = &view.spans[0];
        assert!(view.overlaps_span(&(span.view.start - 1..span.view.start + 1)));
        assert!(!view.overlaps_span(&(0..span.view.start)));
        assert!(!view.overlaps_span(&(span.view.end..span.view.end + 1)));
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
    /// and a few secret names, exercising tokenization and flag recognition.
    fn mixed_corpus(repeat: usize) -> String {
        let block = "# deployment notes for the model node\n\
            exec llama-server --ctx-size 32768 --port 8080 --threads 16 \\\n\
            model: /models/qwen3/qwen3-27b-q4_k_m.gguf\n\
            MAX_TOKENS=4096\n\
            the quick brown fox jumps over the lazy dog, again and again and again\n\
            export HF_TOKEN=fake-value-one-two-three\n\
            run --api-key fake-value-four --verbose\n\
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

    /// Token lines open the retained multi-line constructs without format parsers.
    #[test]
    fn token_line_constructs_mask_through_structural_ends() {
        let rows = [
            "api_key: |\n  first-value\n\n  second-value\nvisible: yes\n",
            "api-key: >-\n  first-value\n  second-value\nvisible: yes\n",
            "'Hf_Token': !tag |+2 # note\n  first-value\n  second-value\nvisible: yes\n",
            "apiKey = \"\"\"\nfirst-value\n\"\"\"second-value\n\nvisible\n",
            "Password='first-value'\"open\nsecond-value\"\nthird-value\n\nvisible\n",
            "foo_secret=first-value\\\nsecond-value\nthird-value\n\nvisible\n",
        ];
        for text in rows {
            let view = masked(FileClass::Plain, text);
            for value in ["first-value", "second-value", "third-value"] {
                assert!(!view.contains(value), "{text:?}: {view:?}");
            }
            assert!(view.contains("visible"), "{text:?}: {view:?}");
        }
    }

    #[test]
    fn a_yaml_block_scalar_ends_at_the_first_dedent_and_blank_lines_do_not_end_it() {
        let text = "a:\n  TLS_KEY: |\n    line1\n\n    line2\n  other: shown\nb: shown\n";
        assert_eq!(
            masked(FileClass::Plain, text),
            "a:\n⟦redacted line⟧\n⟦redacted line⟧\n\n\u{27E6}redacted\u{27E7}\n  other: shown\nb: shown\n"
        );
    }

    #[test]
    fn whole_line_quote_parity_does_not_open_a_spurious_continuation() {
        assert_eq!(
            masked(
                FileClass::Plain,
                "run: echo \"HF_TOKEN=$X\" >> $GITHUB_ENV\nnext: 1\nvisible: yes\n"
            ),
            "⟦redacted line⟧\n⟦redacted line⟧\nvisible: yes\n"
        );
        // A name/value reference occupies only the one line covered by the rule.
        assert_eq!(
            masked(
                FileClass::Plain,
                "  name: API_KEY\n  valueFrom: {secretKeyRef: {name: service, key: credential}}\nvisible: yes\n"
            ),
            "⟦redacted line⟧\n⟦redacted line⟧\nvisible: yes\n"
        );
    }

    #[test]
    fn structural_ends_show_public_text_again_and_only_there() {
        use FileClass::Plain;
        // a YAML block scalar ends at the first non-blank line at or below the KEY LINE's
        // indentation (the line's own, so a quoted key or a `- ` item does not shift it;
        // a deeper sibling of a list item is over-masked, never leaked)
        assert_eq!(
            masked(Plain, "\"K_TOKEN\": |\n one\n\n two\nvisible: 1\n"),
            "⟦redacted line⟧\n⟦redacted line⟧\n\n\u{27E6}redacted\u{27E7}\nvisible: 1\n"
        );
        assert_eq!(
            masked(Plain, "- K_KEY: >-\n    body\n  sibling: 1\ntop: 1\n"),
            "⟦redacted line⟧\n⟦redacted line⟧\n\u{27E6}redacted\u{27E7}\ntop: 1\n"
        );
        // every other multi-line form ends at the first blank line, not at a quote
        assert_eq!(
            masked(Plain, "K_TOKEN=\"a\nb\" tail\nc\n\nvisible\n"),
            "⟦redacted line⟧\n⟦redacted line⟧\n\u{27E6}redacted\u{27E7}\n\nvisible\n"
        );
        // a region that never reaches a blank line is masked to its end
        assert_eq!(
            masked(Plain, "K_TOKEN=\"a\nb\nc\n"),
            "⟦redacted line⟧\n⟦redacted line⟧\n\u{27E6}redacted\u{27E7}\n"
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
            // Unicode folds a case-insensitive / normalization-insensitive volume applies
            ("/p/server.\u{212A}ey", FileClass::PemKey),
            ("/h/.cache/huggingface/to\u{212A}en", FileClass::HfToken),
            ("/h/.ssh/\u{212A}id_x", FileClass::SshPrivateKey),
            ("/h/.ssh/github_ed25519", FileClass::SshPrivateKey),
            ("/h/.ssh/keys/deploy_key", FileClass::SshPrivateKey),
            ("/h/.ssh/id_rsa.pub", FileClass::Plain),
            ("/h/.ssh/github_ed25519.pub", FileClass::Plain),
            ("/h/.ssh/config", FileClass::Plain),
            ("/h/.ssh/known_hosts", FileClass::Plain),
            ("/h/.ssh/authorized_keys", FileClass::Plain),
            ("/h/ssh/github_ed25519", FileClass::Plain),
            ("/h/.cache/huggingface/stored_tokens", FileClass::HfToken),
            ("/h/.huggingface/stored_tokens", FileClass::HfToken),
            ("/mnt/usb/prod.env.", FileClass::Dotenv),
            ("/mnt/usb/prod.env. ", FileClass::Dotenv),
            ("/h/.cache/huggingface/token.", FileClass::HfToken),
            ("/mnt/usb/server.pem.", FileClass::PemKey),
            (
                "/h/.cache/huggingface/\u{FB05}ored_tokens",
                FileClass::HfToken,
            ),
            (
                "/h/.cache/huggingface/\u{FB06}ored_tokens",
                FileClass::HfToken,
            ),
            ("/h/.cache/huggingface/\u{FB01}le", FileClass::Plain),
            ("/h/.ssh/id_\u{212A}", FileClass::SshPrivateKey),
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
            "/h/.\u{DF}h",
            "/h/.\u{17F}sh/config",
            "/h/.\u{1E9E}h",
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
            // suffix-heavy names: every suffix end is followed by a name byte
            "_KEY".repeat(200_000),
            "PASSWORD".repeat(100_000),
            "A_TOKENB".repeat(100_000),
            "_KEY_TOKEN_SECRET".repeat(50_000),
            "_key".repeat(200_000),
            "password".repeat(100_000),
            "a_tokenb".repeat(100_000),
            // thousands of distinct private-key labels on one line, then many short lines
            {
                let markers: String = (0..18_000)
                    .map(|i| format!("-----BEGIN {i}PRIVATE KEY-----"))
                    .collect();
                format!("{markers}\n{}", "x\n".repeat(250_000))
            },
        ];
        for text in &corpora {
            for class in [FileClass::Plain, FileClass::Dotenv] {
                let started = Instant::now();
                let view = mask(class, text);
                std::hint::black_box(&view);
                let took = started.elapsed();
                if class == FileClass::Plain {
                    let has_name = !text.starts_with("PASSWORD")
                        && !text.starts_with("password")
                        && !text.starts_with("A_TOKENB")
                        && !text.starts_with("a_tokenb");
                    if text.starts_with('_') {
                        assert!(view.text.starts_with("⟦redacted line⟧"));
                    } else if !has_name {
                        assert_eq!(view.text, *text);
                    }
                }
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
    fn a_line_masker_masks_a_multi_line_value_until_a_blank_line_for_every_class() {
        for class in [FileClass::Plain, FileClass::PemKey] {
            let mut masker = LineMasker::new(class);
            assert_eq!(masker.mask_line("K_TOKEN=\"one"), "⟦redacted line⟧");
            assert!(masker.in_continuation());
            assert_eq!(masker.mask_line("two"), "⟦redacted line⟧");
            // a closing quote does not end masking; only the blank line does
            assert_eq!(masker.mask_line("three\" ok"), "\u{27E6}redacted\u{27E7}");
            assert_eq!(masker.mask_line("still masked"), "\u{27E6}redacted\u{27E7}");
            assert_eq!(masker.mask_line(""), "");
            assert!(!masker.in_continuation());
            assert_eq!(masker.mask_line("visible"), "visible");
        }
    }

    /// The reader/full-view contract behind the lookback: a read that starts its
    /// masker at the lookback line must mask at least what the whole-file view
    /// masks, for every window start, whenever the file has no masked run longer
    /// than the lookback (`long_construct`, the case edits refuse to create).
    /// Random documents from a small hostile line pool, tiny lookback.
    #[test]
    fn a_windowed_read_masks_at_least_what_the_full_view_masks() {
        use crate::file_ops::read::lookback_start_with;
        let pool = [
            "K_TOKEN=\"open",
            "close\"",
            "K_KEY: |",
            "  body-secret",
            "    deeper",
            "x: 1",
            "",
            "",
            "plain text",
            "run --token",
            "-flag-secret",
            "A_KEY='a",
            "b'\"c",
            "M_SECRET=v \\",
            "cont-secret",
            "\"K_SECRET\": >-",
            " folded",
            "- Z_KEY: |",
            "  - item",
            "P_PASSWORD:ab",
            "//",
            "K_TOKEN=\"\"\"",
            "triple-body",
            "\"\"\"",
            "it's fine",
        ];
        let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut checked = 0;
        // hand-written shapes first (a reader that starts INSIDE a run whose body holds
        // an opener), then random documents from the pool
        let fixed: [&[&str]; 6] = [
            // interleaved private-key blocks of three labels: an END closes only its own
            // block, so a reader that starts after `BEGIN X` still masks the RSA body
            &[
                concat!("-----BEGIN ", "X PRIVATE KEY-----"),
                "P1",
                concat!("-----BEGIN ", "A PRIVATE KEY-----"),
                "ppppp",
                "ppppp",
                "ppppp",
                concat!("-----END ", "X PRIVATE KEY-----"),
                concat!("-----BEGIN ", "RSA PRIVATE KEY-----"),
                concat!("-----END ", "A PRIVATE KEY-----"),
                "BODY-secret-line",
                concat!("-----END ", "RSA PRIVATE KEY-----"),
                "outro",
            ],
            &[
                concat!("-----BEGIN ", "RSA PRIVATE KEY-----"),
                concat!("-----BEGIN ", "EC PRIVATE KEY-----"),
                "BODY-secret-line",
                concat!("-----END ", "EC PRIVATE KEY-----"),
                "more-secret-body",
                concat!("-----END ", "RSA PRIVATE KEY-----"),
                "after",
            ],
            &[
                "E_KEY: |",
                "  eeeeeeee",
                "  eeeeeeee",
                "  eeeeeeee",
                "  Y_TOKEN=\"open",
                "  more",
                "end-of-e",
                "gapgapgapgap",
                "gapgapgapgap",
                "DEPLOY_KEY: |",
                "  line-one",
                "",
                "  hunter2-block-secret",
                "done: yes",
            ],
            &[
                "echo start",
                "E_TOKEN=\"open",
                "    Y_KEY: |",
                "      deeper-one",
                "      deeper-two",
                "",
                "      gap",
                "      gap",
                "      API_TOKEN=\"first",
                "second-line-secret\"",
                "",
                "echo end",
            ],
            &[
                "-flag-secret",
                "close\"",
                "x: 1",
                "triple-body",
                "M_SECRET=v \\",
                "cont",
                "",
                "after",
            ],
            &[
                "  - name: N_TOKEN",
                "    value: pair-secret",
                "  - name: M_KEY",
                "    ",
                "    value: two-secret",
                "next: 1",
            ],
        ];
        let mut docs: Vec<Vec<&str>> = fixed.iter().map(|d| d.to_vec()).collect();
        // sweep the alignment: a reader that starts inside a block whose body holds an
        // opener, at every distance from the window
        let pads: Vec<String> = (0..40).map(|n| "p".repeat(n)).collect();
        let y_lines: Vec<String> = (0..40)
            .map(|n| format!("  Y_TOKEN=\"open{}", "x".repeat(n)))
            .collect();
        for (pad, y_line) in pads.iter().zip(&y_lines) {
            docs.push(vec![
                "E_KEY: |",
                "  ee",
                y_line,
                "  more",
                "DEPLOY_KEY: |",
                "",
                "  hunter2-block-secret",
                "done: yes",
            ]);
            docs.push(vec![
                "E_KEY: |",
                "  ee",
                y_line,
                "  more",
                "end-of-e",
                pad,
                "DEPLOY_KEY: |",
                "",
                "  hunter2-block-secret",
                "done: yes",
            ]);
            docs.push(vec![
                "E_TOKEN=\"open",
                "    Y_KEY: |",
                "      deeper",
                "",
                pad,
                "      API_TOKEN=\"first",
                "second-line-secret\"",
                "",
                "echo end",
            ]);
        }
        for _ in 0..2500 {
            let len = 3 + (next() % 38) as usize;
            docs.push(
                (0..len)
                    .map(|_| pool[(next() % pool.len() as u64) as usize])
                    .collect(),
            );
        }
        for lines in docs {
            let text = lines.join("\n") + "\n";
            for (class, lookback) in [FileClass::Plain, FileClass::Dotenv]
                .into_iter()
                .flat_map(|class| [30_usize, 130].map(|lookback| (class, lookback)))
            {
                let full = mask_with_lookback(class, &text, lookback);
                if full.long_construct {
                    continue;
                }
                // per-line masked byte sets of the whole-file scan
                let mut whole = LineMasker::new(class);
                let full_masks: Vec<Vec<std::ops::Range<usize>>> = lines
                    .iter()
                    .map(|l| whole.scan(l).into_iter().map(|(r, _)| r).collect())
                    .collect();
                let offsets: Vec<usize> = lines
                    .iter()
                    .scan(0, |at, l| {
                        let start = *at;
                        *at += l.len() + 1;
                        Some(start)
                    })
                    .collect();
                for w in 0..lines.len() {
                    let start = lookback_start_with(text.as_bytes(), offsets[w], lookback);
                    let first = offsets.iter().position(|o| *o == start).unwrap_or(0);
                    let mut reader = LineMasker::new(class);
                    for l in &lines[first..w] {
                        let _ = reader.scan(l);
                    }
                    // the window itself: every line from w on
                    for (i, l) in lines.iter().enumerate().skip(w) {
                        let got: Vec<std::ops::Range<usize>> =
                            reader.scan(l).into_iter().map(|(r, _)| r).collect();
                        let covered = |ranges: &[std::ops::Range<usize>], b: usize| {
                            ranges.iter().any(|r| r.start <= b && b < r.end)
                        };
                        for b in 0..l.len() {
                            assert!(
                                !covered(&full_masks[i], b) || covered(&got, b),
                                "{class:?} window {w} line {i} byte {b}: masked in the full view but visible to the reader\n{text:?}"
                            );
                        }
                        checked += 1;
                    }
                }
            }
        }
        assert!(checked > 10_000, "{checked}");
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
