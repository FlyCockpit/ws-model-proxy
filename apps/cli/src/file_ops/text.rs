//! Byte-level text helpers shared by the file tools: the binary sniff, line
//! counting, and end-of-line detection. Invalid UTF-8 is never decoded lossily
//! (a lossy decode followed by a write would corrupt the file).

use serde::Serialize;

/// Bytes inspected for the binary sniff.
pub const SNIFF_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
    Mixed,
    None,
}

/// `Some(kind)` when `head` (the first bytes of a file) is not text: a NUL, a
/// UTF-16/32 BOM, or a well-known binary magic. `kind` is one of
/// `gguf|safetensors|elf|gzip|zip|utf16|unknown`.
pub fn sniff_binary(head: &[u8]) -> Option<&'static str> {
    let head = &head[..head.len().min(SNIFF_BYTES)];
    if head.starts_with(b"GGUF") {
        return Some("gguf");
    }
    if head.starts_with(b"\x7fELF") {
        return Some("elf");
    }
    if head.starts_with(&[0x1f, 0x8b]) {
        return Some("gzip");
    }
    if head.starts_with(b"PK\x03\x04") {
        return Some("zip");
    }
    if head.starts_with(&[0xff, 0xfe]) || head.starts_with(&[0xfe, 0xff]) {
        // UTF-16 LE/BE, and UTF-32 LE (FF FE 00 00) which starts the same way.
        return Some("utf16");
    }
    if head.starts_with(&[0x00, 0x00, 0xfe, 0xff]) {
        return Some("utf16");
    }
    if head.len() >= 9 && head[8] == b'{' && head[6..8] == [0, 0] {
        return Some("safetensors");
    }
    if head.contains(&0) {
        return Some("unknown");
    }
    None
}

/// Number of lines: newline count, plus one for an unterminated last line.
pub fn count_lines(bytes: &[u8]) -> usize {
    let newlines = bytes.iter().filter(|b| **b == b'\n').count();
    newlines + usize::from(!bytes.is_empty() && bytes.last() != Some(&b'\n'))
}

pub fn detect_eol(bytes: &[u8]) -> Eol {
    let mut crlf = 0_usize;
    let mut lf = 0_usize;
    let mut prev = 0_u8;
    for &b in bytes {
        if b == b'\n' {
            if prev == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
        prev = b;
    }
    match (lf, crlf) {
        (0, 0) => Eol::None,
        (_, 0) => Eol::Lf,
        (0, _) => Eol::Crlf,
        _ => Eol::Mixed,
    }
}

/// Line body without its terminator (`\n` or `\r\n`).
pub fn strip_eol(line: &[u8]) -> &[u8] {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line)
}

/// Largest index `<= idx` that is a char boundary of `s`.
pub fn floor_boundary(s: &str, mut idx: usize) -> usize {
    idx = idx.min(s.len());
    while !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

/// A file name or relative path as one line of a `path:line|text` / `dir_list`
/// record. Characters the shared [`crate::display_escape`] list hides (NUL, tabs,
/// bidi controls, invisible characters) are shown as `\u{<hex>}`, and so are line
/// breaks, which that list keeps but a record separator cannot: a name holding
/// `\n` must not look like two results. The separators `:` `|` and the `--` group
/// marker stay ambiguous, which the tool descriptions document.
pub fn name_for_display(name: &str) -> String {
    crate::display_escape::escape_for_display(name)
        .replace('\n', "\\u{a}")
        .replace('\r', "\\u{d}")
        .replace('\u{2028}', "\\u{2028}")
        .replace('\u{2029}', "\\u{2029}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_table() {
        let mut safetensors = vec![0x10, 0, 0, 0, 0, 0, 0, 0, b'{'];
        safetensors.extend_from_slice(b"\"a\":1}");
        let rows: &[(&[u8], Option<&str>)] = &[
            (b"hello\nworld\n", None),
            (b"", None),
            (b"GGUF\x03\0\0\0", Some("gguf")),
            (b"\x7fELF\x02\x01", Some("elf")),
            (&[0x1f, 0x8b, 8, 0], Some("gzip")),
            (b"PK\x03\x04rest", Some("zip")),
            (&[0xff, 0xfe, b'h', 0, b'i', 0], Some("utf16")),
            (&[0xfe, 0xff, 0, b'h'], Some("utf16")),
            (&[0xff, 0xfe, 0, 0, b'h', 0, 0, 0], Some("utf16")),
            (b"text\0more", Some("unknown")),
            (&safetensors, Some("safetensors")),
            (b"na\xc3\xafve c\xc3\xa9 ok\n", None),
        ];
        for (bytes, expected) in rows {
            assert_eq!(sniff_binary(bytes), *expected, "{bytes:?}");
        }
    }

    #[test]
    fn nul_past_the_sniff_window_is_not_sniffed() {
        let mut bytes = vec![b'a'; SNIFF_BYTES];
        bytes.push(0);
        assert_eq!(sniff_binary(&bytes), None);
        bytes[SNIFF_BYTES - 1] = 0;
        assert_eq!(sniff_binary(&bytes), Some("unknown"));
    }

    #[test]
    fn lines_and_eol() {
        assert_eq!(count_lines(b""), 0);
        assert_eq!(count_lines(b"a"), 1);
        assert_eq!(count_lines(b"a\n"), 1);
        assert_eq!(count_lines(b"a\n\n"), 2);
        assert_eq!(count_lines(b"a\nb"), 2);
        assert_eq!(detect_eol(b"a"), Eol::None);
        assert_eq!(detect_eol(b"a\nb\n"), Eol::Lf);
        assert_eq!(detect_eol(b"a\r\nb\r\n"), Eol::Crlf);
        assert_eq!(detect_eol(b"a\r\nb\n"), Eol::Mixed);
        assert_eq!(strip_eol(b"abc\r\n"), b"abc");
        assert_eq!(strip_eol(b"abc\r"), b"abc");
        assert_eq!(strip_eol(b"abc"), b"abc");
    }

    #[test]
    fn floor_boundary_never_splits_a_char() {
        let s = "a\u{e9}b";
        assert_eq!(floor_boundary(s, 2), 1);
        assert_eq!(floor_boundary(s, 3), 3);
        assert_eq!(floor_boundary(s, 99), 4);
    }
}
