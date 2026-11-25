//! What one line opens or masks, without state: the secret-name word and
//! secret-flag recognizers, the dotenv assignment, the value constructs a
//! masked tail opens, the private-key PEM markers, and the indentation shape
//! that ends a run.

use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use super::token;

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
pub(super) static FLAG_AT_END: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?:^|[^A-Za-z0-9_-])-{{1,2}}[A-Za-z0-9_-]*?(?:{SECRET_FLAG_SUFFIX})["']?,?[ \t]*\\?[ \t\r]*$"#
    ))
    .expect("flag-at-end regex")
});
pub(super) static DOTENV_ASSIGN: LazyLock<Regex> = LazyLock::new(|| {
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
pub(super) fn quote_left_open(text: &str) -> bool {
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
pub(super) enum Construct {
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
pub(super) fn construct_for_tail(
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

pub(super) type LineMask = (Range<usize>, String);

/// Maximal ASCII words are scanned once; suffix checks inspect only their ends.
/// A dash-prefixed word belongs exclusively to the flag recognizer.
pub(super) fn first_secret_name(line: &str) -> Option<Range<usize>> {
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

/// One secret flag candidate: where its masked tail starts and what it opens.
type Candidate = (usize, Construct);

/// The first secret flag of `line` (`--token abc`, `--api-key=abc`).
pub(super) fn first_flag(line: &str) -> Option<Candidate> {
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
pub(super) fn tail_mask(line: &str, start: usize) -> Option<LineMask> {
    let end = line.len();
    (start < end).then(|| (start..end, token(line[start..end].chars().count())))
}

pub(super) fn merge(mut masks: Vec<LineMask>, line: &str) -> Vec<LineMask> {
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
pub(super) fn continuation_value(line: &str) -> Option<(Range<usize>, Construct)> {
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
pub(super) fn pem_events(line: &str) -> Vec<(bool, &str)> {
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

pub(super) fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// Which whitespace kinds (1 space, 2 tab) a line is indented with.
pub(super) fn indent_kinds(line: &str) -> u8 {
    line.bytes()
        .take_while(|b| matches!(b, b' ' | b'\t'))
        .fold(0, |kinds, b| kinds | if b == b' ' { 1 } else { 2 })
}

/// Tabs and spaces compared against each other cannot be ordered: the run stays
/// open (fail closed).
pub(super) fn mixed_indent(a: u8, b: u8) -> bool {
    a | b == 3
}
