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
//! form (a quote left open, a trailing `\`, a YAML `|`/`>` block scalar) keeps the
//! following lines masked until a STRUCTURAL end: the first blank line, or for a
//! block scalar the first line at or below the key line's indentation, or the end
//! of the scanned region. It never ends at a closing quote. Masked values are
//! counted in characters; the length itself is not returned.
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
//! The class of a path is decided from the path only (Unicode-folded, no
//! trailing dots or spaces, on every OS; no filesystem search). Secret-class files and directories are
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
fn fold(name: &str) -> String {
    let lowered =
        name.to_lowercase()
            .chars()
            .fold(String::with_capacity(name.len()), |mut out, ch| {
                match ch {
                    'ſ' => out.push('s'),
                    'ß' | 'ẞ' => out.push_str("ss"),
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

/// A secret name: exactly `PASSWORD`, or an upper-case name (it may start with
/// `_`) that ends in `_TOKEN`, `_KEY`, `_SECRET` or `PASSWORD`. Names without a
/// prefix (`TOKEN=`, `KEY=`) stay visible.
const SECRET_NAME: &str =
    r"[A-Z_][A-Z0-9_]*(?:_TOKEN|_KEY|_SECRET)|[A-Z_][A-Z0-9_]*PASSWORD|PASSWORD";

/// Space-separated environment forms: Dockerfile `ENV NAME value`, `ARG`,
/// csh `setenv NAME value`.
static ENV_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^[ \t]*(?:ENV|ARG|setenv|SetEnv)[ \t]+({SECRET_NAME})[ \t]+"
    ))
    .expect("env word regex")
});
/// Inline Kubernetes/ECS name/value pair: `{"name": "DB_PASSWORD", "value": "..."}`.
static INLINE_PAIR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"["']?name["']?[ \t]*:[ \t]*["']?(?:{SECRET_NAME})["']?[ \t]*,[ \t]*["']?value["']?[ \t]*:[ \t]*"#
    ))
    .expect("inline pair regex")
});
/// `name: SECRET_NAME` alone on a line (Kubernetes `env:` items, JSON objects):
/// its `value:` sibling follows.
static NAME_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"^[ \t]*-?[ \t]*["']?name["']?[ \t]*:[ \t]*["']?(?:{SECRET_NAME})["']?[ \t]*,?[ \t\r]*$"#
    ))
    .expect("name line regex")
});
static VALUE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^[ \t]*-?[ \t]*["']?value["']?[ \t]*:[ \t]*"#).expect("value key regex")
});
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
/// A cheap pre-filter: lines without any of these words cannot hold a secret name
/// or flag (names are upper case, flags any case), so clean text costs one scan.
fn has_trigger(text: &str) -> bool {
    [
        "TOKEN", "KEY", "SECRET", "PASSWORD", "token", "key", "secret", "password", "Token", "Key",
        "Secret", "Password",
    ]
    .iter()
    .any(|word| text.contains(word))
}

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

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// One secret candidate: where its masked tail starts and what it opens.
type Candidate = (usize, Construct);

/// The assignment separators, longest first.
const SEPARATORS: [&str; 6] = ["::=", "?=", "+=", ":=", "=", ":"];

/// The end offset of every secret-name suffix (`_TOKEN`, `_KEY`, `_SECRET`,
/// `PASSWORD`) in `line`, in order.
fn secret_suffix_ends(line: &str) -> Vec<usize> {
    let mut ends: Vec<usize> = ["_TOKEN", "_KEY", "_SECRET", "PASSWORD"]
        .into_iter()
        .flat_map(|suffix| {
            line.match_indices(suffix)
                .map(move |(at, _)| at + suffix.len())
        })
        .collect();
    ends.sort_unstable();
    ends
}

/// The first secret-named assignment of `line`. Its value is the whole rest of
/// the line (never "up to the next space or quote"). The name is exactly
/// `PASSWORD`, or upper case (it may start with `_`) and ends in `_TOKEN`, `_KEY`,
/// `_SECRET` or `PASSWORD`; it is followed by an optional (escaped) quote, an
/// optional `]`, blanks and a separator (`=`, `:`, `?=`, `+=`, `:=`, `::=`).
/// Parsed by hand: this runs on every line that mentions a trigger word, and a
/// regex with captures is an order of magnitude slower in a debug build.
fn first_assignment(line: &str) -> Option<Candidate> {
    let bytes = line.as_bytes();
    let is_name = |b: u8| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_';
    for end in secret_suffix_ends(line) {
        // the name: the run of name bytes that ends at `end`
        let mut start = end;
        while start > 0 && is_name(bytes[start - 1]) {
            start -= 1;
        }
        // `_TOKEN`, `_KEY`, `_SECRET` and `PASSWORD` are names by themselves;
        // `TOKEN=` and `KEY=` (no underscore) stay visible
        let first_ok = bytes
            .get(start)
            .is_some_and(|b| b.is_ascii_uppercase() || *b == b'_');
        if !first_ok {
            continue;
        }
        // a name that continues past the suffix (`X_KEYS`) is not this suffix
        if bytes.get(end).is_some_and(|b| is_name(*b)) {
            continue;
        }
        // the word-start rule: not glued to a preceding lower-case word (`fooBAR_KEY`)
        if start > 0 && is_word_byte(bytes[start - 1]) {
            continue;
        }
        // optional escaped quote, optional `]`, blanks, then the separator
        let mut at = end;
        if bytes.get(at) == Some(&b'\\') && matches!(bytes.get(at + 1), Some(b'"' | b'\'')) {
            at += 2;
        } else if matches!(bytes.get(at), Some(b'"' | b'\'')) {
            at += 1;
        }
        if bytes.get(at) == Some(&b']') {
            at += 1;
        }
        while matches!(bytes.get(at), Some(b' ' | b'\t')) {
            at += 1;
        }
        let Some(sep) = SEPARATORS.iter().find(|sep| line[at..].starts_with(**sep)) else {
            continue;
        };
        let mut value_at = at + sep.len();
        while matches!(bytes.get(value_at), Some(b' ' | b'\t')) {
            value_at += 1;
        }
        let after = &line[value_at..];
        // `NAME == x` is a comparison
        if sep.ends_with('=') && line[at + sep.len()..].starts_with('=') {
            continue;
        }
        // `NAME::path` is not an assignment (`NAME:value` and `NAME: value` are)
        if *sep == ":" && line[at + 1..].starts_with(':') {
            continue;
        }
        let tail = after;
        let trimmed = tail.trim_end();
        if trimmed == "\\" {
            // a lone backslash hides nothing, but the value is on the next line
            return Some((line.len(), Construct::UntilBlank));
        }
        let colon = *sep == ":";
        if colon && trimmed.is_empty() {
            // `KEY:` with the value on the following, deeper lines (YAML)
            return Some((
                line.len(),
                Construct::Block {
                    line_indent: indent_of(line),
                },
            ));
        }
        if value_is_public(without_continuation(trimmed)) {
            continue;
        }
        let construct = construct_for_tail(tail, colon, indent_of(line), quote_left_open(line));
        return Some((value_at, construct));
    }
    None
}

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

/// `ENV NAME value` / `setenv NAME value`.
fn first_env_word(line: &str) -> Option<Candidate> {
    let head = line.trim_start();
    if !(head.starts_with("ENV")
        || head.starts_with("ARG")
        || head.starts_with("setenv")
        || head.starts_with("SetEnv"))
    {
        return None;
    }
    let caps = ENV_WORD.captures(line)?;
    let start = caps.get(0)?.end();
    let tail = &line[start..];
    let trimmed = tail.trim_end();
    if trimmed.is_empty() || value_is_public(without_continuation(trimmed)) {
        return None;
    }
    Some((
        start,
        construct_for_tail(tail, false, indent_of(line), quote_left_open(line)),
    ))
}

/// Inline `{"name": "DB_PASSWORD", "value": "..."}` pair.
fn first_inline_pair(line: &str) -> Option<Candidate> {
    if !(line.contains("name") && line.contains("value")) {
        return None;
    }
    let m = INLINE_PAIR.find(line)?;
    let tail = &line[m.end()..];
    let trimmed = tail.trim_end();
    if trimmed.is_empty() || value_is_public(without_continuation(trimmed)) {
        return None;
    }
    Some((
        m.end(),
        construct_for_tail(tail, false, indent_of(line), quote_left_open(line)),
    ))
}

/// The earliest secret candidate of a line (assignment, flag, `ENV` word form or
/// inline name/value pair).
fn first_secret(line: &str) -> Option<Candidate> {
    [
        first_assignment(line),
        first_flag(line),
        first_env_word(line),
        first_inline_pair(line),
    ]
    .into_iter()
    .flatten()
    .min_by_key(|candidate| candidate.0)
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
    Some((
        start..end.max(start),
        construct_for_tail(
            &line[start..],
            false,
            indent_of(line),
            quote_left_open(line),
        ),
    ))
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
/// State: a `PRIVATE KEY` block flag, "the previous line ended with a secret
/// flag", a few lines of Kubernetes name/value pairing, an until-blank run and
/// the open YAML blocks. Command-output masking (a later phase) reuses this as a
/// streaming scanner.
#[derive(Debug, Clone)]
pub struct LineMasker {
    class: FileClass,
    lookback: usize,
    in_private_block: bool,
    pending_flag_value: bool,
    /// Offset of the latest opener of the run that masks lines until a blank line.
    until_blank: Option<usize>,
    blocks: Vec<OpenBlock>,
    /// Lines left in which a `value:` line belongs to a `name: SECRET_NAME` line.
    pair_lines: u8,
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
            in_private_block: false,
            pending_flag_value: false,
            until_blank: None,
            blocks: Vec::new(),
            pair_lines: 0,
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
        self.until_blank.is_some() || !self.blocks.is_empty()
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
        // 2. the line's own rules and openers, always (union semantics)
        let (masks, opened) = self.scan_body(line);
        if let Some(opener) = masked_by
            && at.saturating_sub(opener) > self.lookback
        {
            self.long_run = true;
        }
        // 3. register what this line opened
        match opened {
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
        if masked_by.is_some() {
            return vec![(0..line.len(), token_bare())];
        }
        if masks.is_empty() {
            masks
        } else {
            merge(masks, line)
        }
    }

    /// The class and generic rules over `line` (ranges relative to `line`).
    fn scan_body(&mut self, line: &str) -> (Vec<LineMask>, Construct) {
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
                    construct = construct_for_tail(
                        &line[m.end()..],
                        false,
                        indent_of(line),
                        quote_left_open(line),
                    );
                } else {
                    masks.push((0..line.len(), token_bare()));
                    construct =
                        construct_for_tail(line, false, indent_of(line), quote_left_open(line));
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
            // Kubernetes/ECS style: `name: SECRET_NAME` then `value: ...`
            let mut next_pair = self.pair_lines.saturating_sub(1);
            if self.pair_lines > 0 {
                if let Some(m) = VALUE_KEY.find(line) {
                    masks.extend(tail_mask(line, m.end()));
                    construct = construct_for_tail(
                        &line[m.end()..],
                        true,
                        indent_of(line),
                        quote_left_open(line),
                    );
                    next_pair = 0;
                } else if line.trim().is_empty() {
                    next_pair = 0;
                }
            }
            if line.contains("name") && NAME_LINE.is_match(line) {
                next_pair = 3;
            }
            self.pair_lines = next_pair;
            if has_trigger(line)
                && let Some((start, opened)) = first_secret(line)
            {
                masks.extend(tail_mask(line, start));
                construct = opened;
            }
        }
        self.pending_flag_value = line.contains('-') && FLAG_AT_END.is_match(line);
        (masks, construct)
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
    if class == FileClass::Plain && !has_trigger(text) {
        return MaskedView::from_parts(text.to_string(), Vec::new(), false);
    }
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
            (Dotenv, "A='multi word value'  \n", "A=⟦redacted:20⟧\n"),
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
            // a quoted value that spans lines masks every following line until a blank
            // line (never at the closing quote), in any class
            (
                Plain,
                "X_TOKEN=\"first\nsecond\nthird\" tail\nafter\n",
                "X_TOKEN=⟦redacted:6⟧\n⟦redacted⟧\n⟦redacted⟧\n⟦redacted⟧\n",
            ),
            (
                Plain,
                "X_KEY: 'a\nb'\nY_KEY=z\n",
                "X_KEY: ⟦redacted:2⟧\n⟦redacted⟧\n⟦redacted⟧\n",
            ),
            (
                Plain,
                "--token \"a\nb\"\nplain\n",
                "--token ⟦redacted:2⟧\n⟦redacted⟧\n⟦redacted⟧\n",
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
                "A=⟦redacted:6⟧\n⟦redacted⟧\n⟦redacted⟧\n",
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
            (Plain, "--api-key --other\n", "--api-key ⟦redacted:7⟧\n"),
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
                "  - --secret\n  - ⟦redacted:6⟧\n",
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
                "  export DB_URL = value-one two  # note\n",
                &["value-one", "two", "note"],
            ),
            (PemKey, "# note\nK_TOKEN=\"a\nb\"\n", &["b\""]),
            // stage-3 round 3 (C3a-1..6): masking ends only at a blank line or a dedent,
            // never at a closing quote
            (
                Plain,
                "API_KEY: 'first1\n  second1''tail-secret1\n  third1'\nvisible: 1\n",
                &["second1", "tail-secret1", "third1"],
            ),
            (
                Plain,
                "K_TOKEN='a1'\"b1\nc1\"\n\nvisible\n",
                &["a1", "b1", "c1"],
            ),
            (
                Plain,
                "K_TOKEN=\"x1\\\nc1\"\\\nd1\ne1\n\nvisible\n",
                &["x1", "c1", "d1", "e1"],
            ),
            (
                Plain,
                "export K_TOKEN=abc1\\\n\"open1\nmore1\n\nvisible\n",
                &["abc1", "open1", "more1"],
            ),
            (
                Plain,
                "K_TOKEN=\"\"\"x1\"\"\" ; A_KEY=\"open2\nmore2\n\nv\n",
                &["x1", "open2", "more2"],
            ),
            (
                Plain,
                "K_TOKEN=abc1'def1\nghi1'\n\nvisible\n",
                &["abc1", "def1", "ghi1"],
            ),
            (
                Dotenv,
                "K_TOKEN=abc1'def1\nNEXT_KEY=ghi1'\n\nB=1\n",
                &["abc1", "def1", "NEXT_KEY", "ghi1"],
            ),
            (
                Plain,
                "\"K_TOKEN\": |\n one1\n two1\nvisible: 1\n",
                &["one1", "two1"],
            ),
            (Plain, "run --token -secret1 --x\n", &["secret1"]),
            (Plain, "run --api-key\n-secret2\n", &["secret2"]),
            (Plain, "run --password=-secret3\n", &["secret3"]),
            (
                Plain,
                "K_TOKEN=abc1\u{a0}\u{2002}\n",
                &["\u{a0}", "\u{2002}"],
            ),
            (Plain, "K_TOKEN=abc1   \n", &["   "]),
            (Plain, "_DEPLOY_TOKEN=lead-secret\n", &["lead-secret"]),
            (
                Plain,
                "_TOKEN=short-secret\n_KEY: short-key-secret\n_SECRET=x-secret\n",
                &["short-secret", "short-key-secret", "x-secret"],
            ),
            (Plain, "  export __A_KEY: under-secret\n", &["under-secret"]),
            // stage-3 round 3 (Opus C3b-4/5): quote escapes, glued text, other flag prefixes
            (
                Plain,
                "X_TOKEN: 'first-secret\nsec''ret-tail-part'\n\nvisible\n",
                &["first-secret", "ret-tail-part"],
            ),
            (
                Plain,
                "export X_TOKEN=\"first-secret\nsecond\"glued-tail-part\n\nvisible\n",
                &["first-secret", "glued-tail-part"],
            ),
            (Plain, "cmd {--token brace-secret}\n", &["brace-secret"]),
            (Plain, "a;--token semi-secret\n", &["semi-secret"]),
            (Plain, "a|--api-key pipe-secret\n", &["pipe-secret"]),
            (Plain, "a&&--password=and-secret\n", &["and-secret"]),
            // stage-3 round 4 (Opus C4a-2/6/8): YAML values on following lines, prefixed
            // flags, other assignment and environment shapes
            (
                Plain,
                "environment:\n  API_KEY:\n        SECRETXA1\n  HF_TOKEN: !!str\n        SECRETXB2\n  DB_PASSWORD: &pw\n        SECRETXC3\n  OPENAI_API_KEY: SECRETXD4-first\n        SECRETXE5-second\nnext: 1\n",
                &[
                    "SECRETXA1",
                    "SECRETXB2",
                    "SECRETXC3",
                    "SECRETXD4",
                    "SECRETXE5",
                ],
            ),
            (Plain, "aider --openai-api-key SECRETX1\n", &["SECRETX1"]),
            (Plain, "aider --anthropic-api-key=SECRETX2\n", &["SECRETX2"]),
            (Plain, "server -token SECRETX3\n", &["SECRETX3"]),
            (Plain, "llm --apikey SECRETX4\n", &["SECRETX4"]),
            (
                Plain,
                "{\"args\": \"--api-key\\nSECRETXJ2\"}\n",
                &["SECRETXJ2"],
            ),
            (
                Plain,
                "env:\n  - name: OPENAI_API_KEY\n    value: SECRETXK8S\n",
                &["SECRETXK8S"],
            ),
            (
                Plain,
                "{\"name\": \"DB_PASSWORD\", \"value\": \"SECRETXECS\"}\n",
                &["SECRETXECS"],
            ),
            (
                Plain,
                "{\"cfg\": \"{\\\"API_KEY\\\":\\\"SECRETXJ1\\\"}\"}\n",
                &["SECRETXJ1"],
            ),
            (
                Plain,
                "os.environ[\"API_KEY\"] = \"SECRETX5\"\n",
                &["SECRETX5"],
            ),
            (
                Plain,
                "API_KEY ?= SECRETX6\nAPI_KEY ::= SECRETX7\nAPI_KEY += SECRETX8\nAPI_KEY := SECRETX9\n",
                &["SECRETX6", "SECRETX7", "SECRETX8", "SECRETX9"],
            ),
            (
                Plain,
                "ENV API_KEY SECRETXL1\nsetenv DB_PASSWORD SECRETXL2\nARG X_TOKEN SECRETXL3\n",
                &["SECRETXL1", "SECRETXL2", "SECRETXL3"],
            ),
            (Plain, "API_KEY='$FOO\nSECRETXL4'\n\nv\n", &["SECRETXL4"]),
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
    fn public_names_stay_visible_and_a_string_opened_before_the_name_is_not_a_continuation() {
        use FileClass::Plain;
        for line in [
            "run --max-tokens 4096\n",
            "run --tokenizer gpt2 --token-limit 5\n",
            "if PASSWORD == 3\n",
            "kube-token is a name\n",
            "max_tokens=4096\n",
            "  name: API_KEY\n  valueFrom:\n    secretKeyRef: shown\n",
        ] {
            let view = masked(Plain, line);
            if line.contains("valueFrom") {
                assert!(view.contains("secretKeyRef: shown"), "{view:?}");
            } else {
                assert_eq!(view, line, "{line:?}");
            }
        }
        // the closing quote of a string opened BEFORE the name is not a value quote
        assert_eq!(
            masked(
                Plain,
                "run: echo \"HF_TOKEN=$X\" >> $ENV\nnext: 1\n- run: make\n"
            ),
            "run: echo \"HF_TOKEN=\u{27E6}redacted:11\u{27E7}\nnext: 1\n- run: make\n"
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
            "\"K_TOKEN\": \u{27E6}redacted:1\u{27E7}\n\u{27E6}redacted\u{27E7}\n\n\u{27E6}redacted\u{27E7}\nvisible: 1\n"
        );
        assert_eq!(
            masked(Plain, "- K_KEY: >-\n    body\n  sibling: 1\ntop: 1\n"),
            "- K_KEY: \u{27E6}redacted:2\u{27E7}\n\u{27E6}redacted\u{27E7}\n\u{27E6}redacted\u{27E7}\ntop: 1\n"
        );
        // every other multi-line form ends at the first blank line, not at a quote
        assert_eq!(
            masked(Plain, "K_TOKEN=\"a\nb\" tail\nc\n\nvisible\n"),
            "K_TOKEN=\u{27E6}redacted:2\u{27E7}\n\u{27E6}redacted\u{27E7}\n\u{27E6}redacted\u{27E7}\n\nvisible\n"
        );
        // a region that never reaches a blank line is masked to its end
        assert_eq!(
            masked(Plain, "K_TOKEN=\"a\nb\nc\n"),
            "K_TOKEN=\u{27E6}redacted:2\u{27E7}\n\u{27E6}redacted\u{27E7}\n\u{27E6}redacted\u{27E7}\n"
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
    fn a_line_masker_masks_a_multi_line_value_until_a_blank_line_for_every_class() {
        for class in [FileClass::Plain, FileClass::PemKey] {
            let mut masker = LineMasker::new(class);
            assert_eq!(
                masker.mask_line("K_TOKEN=\"one"),
                "K_TOKEN=\u{27E6}redacted:4\u{27E7}"
            );
            assert!(masker.in_continuation());
            assert_eq!(masker.mask_line("two"), "\u{27E6}redacted\u{27E7}");
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
        let lookback = 30;
        let mut checked = 0;
        // hand-written shapes first (a reader that starts INSIDE a run whose body holds
        // an opener), then random documents from the pool
        let fixed: [&[&str]; 4] = [
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
        for _ in 0..8000 {
            let len = 3 + (next() % 38) as usize;
            docs.push(
                (0..len)
                    .map(|_| pool[(next() % pool.len() as u64) as usize])
                    .collect(),
            );
        }
        for lines in docs {
            let text = lines.join("\n") + "\n";
            for class in [FileClass::Plain, FileClass::Dotenv] {
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
