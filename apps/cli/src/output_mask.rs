//! Secret masking for command output (owner decision D5b, issue #107).
//!
//! Command output that leaves the node for the server and MCP (`exec.start`
//! stdout/stderr, and the shared copy of a supervised command's output) goes
//! through a [`StreamMasker`] first. It applies exactly the rules of the file
//! tools' `LineMasker` in `file_ops::redact`: `PRIVATE KEY` blocks, secret-named
//! `NAME=value` / `Environment=NAME=value` / compose assignments, and the values
//! of `--api-key` / `--hf-token`-style flags, shown as `⟦redacted:N⟧`. Nothing
//! else is masked: no vendor-prefix scanner, no cloud-credential patterns.
//!
//! Cost and boundaries:
//! - The masker never touches the filesystem. The Hugging Face token file is
//!   recognised only by the command text that names it, not by looking for it.
//! - Output is buffered up to the next newline (at most [`MAX_LINE`] bytes) and
//!   each line is scanned once, so a secret split across read chunks (or across
//!   the supervised head/tail boundary, which sits after masking) is masked whole.
//!   Memory is bounded by [`MAX_LINE`] per stream and work is linear in the bytes.
//! - A line longer than [`MAX_LINE`] is scanned in pieces cut at whitespace.
//!   When an unbroken piece ends inside a masked value, the rest of that token
//!   is dropped until the next whitespace, so its tail is not half-emitted.
//! - Bytes that are not UTF-8 pass through unchanged unless a secret is found on
//!   the line, in which case that line is emitted lossily decoded.
//! - A partial last line is held until the stream ends ([`StreamMasker::finish`]).

use std::borrow::Cow;

#[cfg(unix)]
use crate::file_ops::redact::{FileClass, LineMasker};
#[cfg(not(unix))]
#[allow(dead_code)]
#[path = "file_ops/redact.rs"]
mod redact;
#[cfg(not(unix))]
use redact::{FileClass, LineMasker};

/// Longest line held in memory before it is scanned in pieces.
pub const MAX_LINE: usize = 64 * 1024;

/// Command-text fragments that mean the command may print the Hugging Face
/// token file (the file itself is never opened here).
const HF_TOKEN_PATHS: [&str; 2] = [".cache/huggingface/token", ".huggingface/token"];

/// Streaming, line-oriented masker for one output stream.
pub struct StreamMasker {
    masker: LineMasker,
    /// Set when the command names the Hugging Face token file: a line that is a
    /// single bare word is then masked as the token.
    hf: Option<LineMasker>,
    pending: Vec<u8>,
    /// Drop bytes up to the next whitespace (the tail of an over-long masked token).
    swallow: bool,
}

impl StreamMasker {
    /// A masker for the output of `command`.
    pub fn new(command: &str) -> Self {
        let hf = HF_TOKEN_PATHS
            .iter()
            .any(|path| command.contains(path))
            .then(|| LineMasker::new(FileClass::HfToken));
        Self {
            // `PemKey` masks PRIVATE KEY blocks and otherwise behaves as plain text.
            masker: LineMasker::new(FileClass::PemKey),
            hf,
            pending: Vec::new(),
            swallow: false,
        }
    }

    /// Feed a chunk; returns the bytes that are safe to send (possibly empty).
    pub fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(bytes.len());
        let mut rest = bytes;
        while !rest.is_empty() {
            if self.swallow {
                match rest.iter().position(u8::is_ascii_whitespace) {
                    Some(at) => {
                        self.swallow = false;
                        rest = &rest[at..];
                    }
                    None => return out,
                }
            }
            let room = MAX_LINE - self.pending.len();
            let window = &rest[..rest.len().min(room)];
            if let Some(at) = window.iter().position(|b| *b == b'\n') {
                self.pending.extend_from_slice(&rest[..=at]);
                rest = &rest[at + 1..];
                self.emit_line(&mut out);
            } else {
                self.pending.extend_from_slice(window);
                rest = &rest[window.len()..];
                if self.pending.len() >= MAX_LINE {
                    self.emit_piece(&mut out);
                }
            }
        }
        out
    }

    /// The stream ended: mask and return whatever is still held.
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if !self.pending.is_empty() {
            self.emit_line(&mut out);
        }
        self.swallow = false;
        out
    }

    /// Mask the held line (with or without a terminator) and append it.
    fn emit_line(&mut self, out: &mut Vec<u8>) {
        let line = std::mem::take(&mut self.pending);
        let body_end = line
            .iter()
            .rposition(|b| *b != b'\n' && *b != b'\r')
            .map_or(0, |at| at + 1);
        let (body, ending) = line.split_at(body_end);
        out.extend_from_slice(&self.mask_body(body).0);
        out.extend_from_slice(ending);
    }

    /// The held bytes reached [`MAX_LINE`] with no newline: scan up to the last
    /// whitespace (or everything, when there is none) and keep the rest.
    fn emit_piece(&mut self, out: &mut Vec<u8>) {
        let cut = self
            .pending
            .iter()
            .rposition(u8::is_ascii_whitespace)
            .map_or(self.pending.len(), |at| at + 1);
        let keep = self.pending.split_off(cut);
        let piece = std::mem::replace(&mut self.pending, keep);
        let (masked, reaches_end) = self.mask_body(&piece);
        out.extend_from_slice(&masked);
        if cut == piece.len() && !piece.last().is_some_and(u8::is_ascii_whitespace) {
            self.swallow = reaches_end;
        }
    }

    /// Mask one line body. Also reports whether a masked range runs to its end.
    fn mask_body<'a>(&mut self, body: &'a [u8]) -> (Cow<'a, [u8]>, bool) {
        let lossy;
        let text = match std::str::from_utf8(body) {
            Ok(text) => text,
            Err(_) => {
                lossy = String::from_utf8_lossy(body).into_owned();
                lossy.as_str()
            }
        };
        if let Some(hf) = self.hf.as_mut() {
            let trimmed = text.trim();
            if !trimmed.is_empty() && !trimmed.contains(char::is_whitespace) {
                let start = text.len() - text.trim_start().len();
                let tail = start + trimmed.len();
                if let Some((_, token)) = hf.scan(trimmed).into_iter().next() {
                    let mut masked = String::with_capacity(text.len());
                    masked.push_str(&text[..start]);
                    masked.push_str(&token);
                    masked.push_str(&text[tail..]);
                    return (Cow::Owned(masked.into_bytes()), tail == text.len());
                }
            }
        }
        let masks = self.masker.scan(text);
        if masks.is_empty() {
            return (Cow::Borrowed(body), false);
        }
        let reaches_end = masks
            .last()
            .is_some_and(|(range, _)| range.end == text.len());
        let mut masked = String::with_capacity(text.len());
        let mut cursor = 0;
        for (range, token) in masks {
            masked.push_str(&text[cursor..range.start]);
            masked.push_str(&token);
            cursor = range.end;
        }
        masked.push_str(&text[cursor..]);
        (Cow::Owned(masked.into_bytes()), reaches_end)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(command: &str, chunks: &[&[u8]]) -> String {
        let mut masker = StreamMasker::new(command);
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(masker.push(chunk));
        }
        out.extend(masker.finish());
        String::from_utf8(out).expect("utf-8 output")
    }

    fn whole(input: &str) -> String {
        all("ls", &[input.as_bytes()])
    }

    const TOK: &str = "\u{27E6}redacted";

    #[test]
    fn each_masked_class_in_command_output() {
        let cases: [(&str, &str); 10] = [
            (
                "HF_TOKEN=hunter2hunter2\n",
                "HF_TOKEN=\u{27E6}redacted:14\u{27E7}\n",
            ),
            (
                "export SVC_API_KEY=abc123\r\n",
                "export SVC_API_KEY=\u{27E6}redacted:6\u{27E7}\r\n",
            ),
            (
                "DB_PASSWORD=\"a b c\"\n",
                "DB_PASSWORD=\u{27E6}redacted:7\u{27E7}\n",
            ),
            (
                "Environment=APP_SECRET=xyz\n",
                "Environment=APP_SECRET=\u{27E6}redacted:3\u{27E7}\n",
            ),
            (
                "  environment:\n    - API_TOKEN=tok123\n",
                "  environment:\n    - API_TOKEN=\u{27E6}redacted:6\u{27E7}\n",
            ),
            (
                "srv: API_KEY: tok123\n",
                "srv: API_KEY: \u{27E6}redacted:6\u{27E7}\n",
            ),
            (
                "llama --api-key sk-abc --port 1\n",
                "llama --api-key \u{27E6}redacted:6\u{27E7} --port 1\n",
            ),
            (
                "run --hf-token=hf_zzz\n",
                "run --hf-token=\u{27E6}redacted:6\u{27E7}\n",
            ),
            (
                "run --hf-token \\\n  hf_zzz\n",
                "run --hf-token \\\n  \u{27E6}redacted:6\u{27E7}\n",
            ),
            (
                "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\nok\n",
                "\u{27E6}redacted\u{27E7}\n\u{27E6}redacted\u{27E7}\n\u{27E6}redacted\u{27E7}\nok\n",
            ),
        ];
        for (input, want) in cases {
            assert_eq!(whole(input), want, "input {input:?}");
        }
    }

    #[test]
    fn vendor_tokens_jwts_and_short_numbers_are_not_masked() {
        for input in [
            "ghp_0123456789abcdefghijklmnopqrstuvwxyz01\n",
            "sk-proj-abcdefghijklmnopqrstuvwxyz\n",
            "AKIAIOSFODNN7EXAMPLE\n",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl\n",
            "max_tokens=4096\n",
            "-----BEGIN CERTIFICATE-----\nMIIabc\n-----END CERTIFICATE-----\n",
            "id_rsa.pub AAAAB3NzaC1yc2E\n",
            "plain output with no secrets at all\n",
        ] {
            assert_eq!(whole(input), input, "input {input:?}");
        }
    }

    /// The masker's output must not depend on where the reads were cut.
    #[test]
    fn every_split_point_and_size_gives_the_same_output() {
        let input = "start\nDB_PASSWORD=supersecret\nrun --api-key\n  key-on-next-line\n\
                     -----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----\n\
                     tail SVC_TOKEN=abcdef\nlast --hf-token hf_last";
        let want = whole(input);
        assert!(
            !want.contains("supersecret") && !want.contains("key-on-next-line"),
            "{want}"
        );
        assert!(
            !want.contains("AAAA") && !want.contains("hf_last"),
            "{want}"
        );
        assert!(!want.contains("abcdef"), "{want}");
        let bytes = input.as_bytes();
        for size in (1..=64).chain([bytes.len()]) {
            let chunks: Vec<&[u8]> = bytes.chunks(size).collect();
            assert_eq!(all("ls", &chunks), want, "chunk size {size}");
        }
        for at in 0..=bytes.len() {
            assert_eq!(
                all("ls", &[&bytes[..at], &bytes[at..]]),
                want,
                "split at {at}"
            );
        }
    }

    #[test]
    fn a_partial_last_line_is_held_until_finish() {
        let mut masker = StreamMasker::new("ls");
        assert!(masker.push(b"MY_TOKEN=abc").is_empty());
        assert!(masker.push(b"def").is_empty());
        assert_eq!(
            String::from_utf8(masker.finish()).expect("utf-8"),
            format!("MY_TOKEN={TOK}:6\u{27E7}")
        );
        assert!(masker.finish().is_empty());
    }

    #[test]
    fn non_utf8_passes_through_unless_a_secret_shares_its_line() {
        let mut masker = StreamMasker::new("ls");
        let mut out = masker.push(b"\xff\xfe binary\n");
        out.extend(masker.push(b"KEY_TOKEN=abc \xff\n"));
        out.extend(masker.finish());
        assert!(out.starts_with(b"\xff\xfe binary\n"));
        let rest = String::from_utf8_lossy(&out[b"\xff\xfe binary\n".len()..]).into_owned();
        assert!(rest.starts_with("KEY_TOKEN=\u{27E6}redacted:3"), "{rest}");
        assert!(!rest.contains("abc"), "{rest}");
    }

    #[test]
    fn hf_token_file_lines_are_masked_only_when_the_command_names_the_file() {
        let printed = "hf_abcdefghijklmnop\n  \nnot a token\n";
        assert_eq!(all("cat /x/y", &[printed.as_bytes()]), printed);
        for command in ["cat ~/.cache/huggingface/token", "cat ~/.huggingface/token"] {
            assert_eq!(
                all(command, &[printed.as_bytes()]),
                format!("{TOK}:19\u{27E7}\n  \nnot a token\n"),
                "{command}"
            );
        }
    }

    #[test]
    fn an_unterminated_private_key_block_stays_masked_to_the_end() {
        let out = whole("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB");
        assert!(!out.contains("AAAA") && !out.contains("BBBB"), "{out}");
    }

    #[test]
    fn a_line_over_the_cap_is_scanned_in_pieces_and_memory_stays_bounded() {
        // A long unbroken value: everything after `NAME=` is masked, and the
        // part beyond the first piece is dropped, never emitted.
        let long = "x".repeat(MAX_LINE * 3);
        let input = format!("BIG_SECRET={long}\nnext\n");
        let mut masker = StreamMasker::new("ls");
        let mut out = Vec::new();
        for chunk in input.as_bytes().chunks(4000) {
            out.extend(masker.push(chunk));
            assert!(masker.pending.len() <= MAX_LINE);
        }
        out.extend(masker.finish());
        let text = String::from_utf8(out).expect("utf-8");
        assert!(!text.contains("xxxx"), "a value fragment leaked");
        assert!(
            text.starts_with("BIG_SECRET=\u{27E6}redacted:"),
            "{}",
            &text[..40]
        );
        assert!(text.ends_with("\nnext\n"));
        // Ordinary long output without secrets passes through intact.
        let words = "word ".repeat(MAX_LINE);
        assert_eq!(whole(&words), words);
    }

    #[test]
    fn an_assignment_straddling_the_line_cap_is_kept_whole_and_masked() {
        // The cap falls inside the name (`SVC_API_K|EY=`): the piece is cut at the
        // last whitespace, so the name is scanned together with its value.
        let prefix = format!("{} ", "w ".repeat((MAX_LINE - 10) / 2));
        assert_eq!(prefix.len(), MAX_LINE - 9);
        let input = format!("{prefix}SVC_API_KEY=leakedvalue123 tail\n");
        let want = format!("{prefix}SVC_API_KEY={TOK}:14\u{27E7} tail\n");
        assert_eq!(whole(&input), want);
        let mut masker = StreamMasker::new("ls");
        let mut out = Vec::new();
        for chunk in input.as_bytes().chunks(1000) {
            out.extend(masker.push(chunk));
        }
        out.extend(masker.finish());
        assert_eq!(String::from_utf8(out).expect("utf-8"), want);
    }

    #[test]
    fn crlf_and_blank_lines_are_preserved() {
        assert_eq!(whole("a\r\n\r\nb=1\r\n\n"), "a\r\n\r\nb=1\r\n\n");
    }

    #[test]
    fn masking_two_mebibytes_is_a_linear_scan() {
        use std::time::{Duration, Instant};
        let mixed = "INFO loaded model in 3.2s\nDB_PASSWORD=hunter2\nrun --api-key abc --port 80\n";
        let plain = "INFO request served in 12 ms path=/v1/chat/completions status=200\n";
        let run = |block: &str| {
            let mut masker = StreamMasker::new("ls");
            let data = block.repeat(2 * 1024 * 1024 / block.len());
            let started = Instant::now();
            let mut sent = 0;
            for chunk in data.as_bytes().chunks(16 * 1024) {
                sent += masker.push(chunk).len();
            }
            sent += masker.finish().len();
            std::hint::black_box(sent);
            started.elapsed()
        };
        let _ = run("WARM_TOKEN=x\n"); // compile the shared regex set once
        let (mixed_time, plain_time) = (run(mixed), run(plain));
        let bound = if cfg!(debug_assertions) {
            Duration::from_secs(30)
        } else {
            Duration::from_millis(600)
        };
        assert!(mixed_time < bound, "mixed {mixed_time:?}");
        assert!(plain_time < bound, "plain {plain_time:?}");
    }
}
