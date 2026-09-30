//! Command-output masking for accidental disclosure (issue #107).
//!
//! Every server-visible exec stream and supervised shared/review capture uses
//! [`StreamMasker`]. The encrypted PTY viewer still receives the original bytes.
//! Normal physical lines use the file tools' restartable [`LineMasker`] exactly:
//! private-key PEM blocks, whole secret-name token lines and their continuation,
//! and secret-flag value tails. Naming a Hugging Face token file in the command
//! selects [`FileClass::HfToken`] for all its output. No disk access or additional
//! scanner, including vendor-prefix scanning, is performed.
//!
//! Latency is bounded in BYTES: a line waits for LF, EOF/completion, or
//! [`MAX_HELD_BYTES`] plus one input byte, whichever comes first. There is no
//! wall-clock deadline while a process is silent. EOF and teardown flush/discard
//! all held bytes. Each normal line is scanned once; overlong lines are scanned
//! in bounded pieces cut at whitespace (an unbroken piece uses the cap).
//! A secret-name token could occur AFTER an arbitrary public prefix. Therefore
//! an overlong line emits only `⟦redacted line⟧`, with no prefix or token tail.
//! At its terminating LF, a fresh scanner is primed through [`LineMasker::scan`]
//! as a column-0 secret-name token line: the next non-blank line is masked whole,
//! and subsequent lines indented deeper than column 0 stay masked. Blank lines
//! do not consume that next-line protection. Normal scanning then resumes.
//! CR/LF bytes are copied even while the overlong line is opaque.
//! Open-state input is also capped by [`MAX_STATE_INPUT_BYTES`]; exceeding it
//! frees scanner state and makes every remaining nonempty line opaque through
//! EOF, preserving CR/LF. This accepted residual bounds live PEM/indentation
//! state; unlike an overlong line, this fallback never recovers. Opaque scanner
//! state is reset after each piece/line, so PEM stacks cannot grow.
//! Invalid UTF-8 passes through when scanning its lossy view finds no mask;
//! otherwise the masked lossy view is emitted. LF/CRLF terminators are preserved.
//! Capture totals and `output_bytes` count these masked bytes, before head/tail
//! retention. Plain command output never uses the dotenv `KEY=⟦redacted:N⟧` view.

#[cfg(unix)]
use crate::file_ops::redact::{FileClass, LineMasker};
#[cfg(not(unix))]
#[allow(dead_code)]
#[path = "file_ops/redact.rs"]
mod redact;
#[cfg(not(unix))]
use redact::{FileClass, LineMasker};

/// Maximum raw tail retained per stream (LF is handled separately).
pub const MAX_HELD_BYTES: usize = 64 * 1024;
/// Bound on input that can contribute live openers (PEM labels/indentation).
/// This bounds scanner state as well as the raw line tail, conservatively.
pub const MAX_STATE_INPUT_BYTES: usize = 1024 * 1024;
const LINE_MARKER: &[u8] = "⟦redacted line⟧".as_bytes();

#[derive(Debug, PartialEq, Eq)]
enum Mode {
    Scanning,
    OverlongLine,
    OpaqueStream,
}

/// One restartable masker per output stream. Chunk boundaries carry no meaning.
pub struct StreamMasker {
    masker: LineMasker,
    pending: Vec<u8>,
    mode: Mode,
    opaque_line: bool,
    recovery_pending: bool,
    finished: bool,
    state_input_bytes: usize,
}

impl StreamMasker {
    pub fn new(command: &str) -> Self {
        let class = if [".cache/huggingface/token", ".huggingface/token"]
            .iter()
            .any(|path| command.contains(path))
        {
            FileClass::HfToken
        } else {
            FileClass::Plain
        };
        Self {
            masker: LineMasker::new(class),
            pending: Vec::new(),
            mode: Mode::Scanning,
            opaque_line: false,
            recovery_pending: false,
            finished: false,
            state_input_bytes: 0,
        }
    }

    /// Raw bytes held for the next line or bounded piece.
    pub fn held(&self) -> usize {
        self.pending.len()
    }

    /// Feed raw output; only the returned bytes may enter the shared copy.
    pub fn push(&mut self, mut bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        if self.finished {
            return out;
        }
        while !bytes.is_empty() {
            if bytes[0] == b'\n' {
                self.emit_line(&mut out);
                out.push(b'\n');
                if self.mode == Mode::OverlongLine {
                    self.mode = Mode::Scanning;
                    self.prime_recovery();
                }
                bytes = &bytes[1..];
                continue;
            }
            if self.pending.len() == MAX_HELD_BYTES {
                if self.mode == Mode::Scanning {
                    self.mode = Mode::OverlongLine;
                    self.reset_scanner();
                    Self::emit_opaque(&mut self.opaque_line, &self.pending, &mut out);
                }
                self.scan_piece();
            }
            let room = MAX_HELD_BYTES - self.pending.len();
            let window = &bytes[..bytes.len().min(room)];
            let end = window
                .iter()
                .position(|b| *b == b'\n')
                .unwrap_or(window.len());
            let body = &window[..end];
            if self.mode != Mode::Scanning {
                Self::emit_opaque(&mut self.opaque_line, body, &mut out);
            }
            self.pending.extend_from_slice(body);
            bytes = &bytes[end..];
        }
        out
    }

    /// Flush a partial last line at EOF/completion. Idempotent; seals the stream.
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if !self.finished {
            if !self.pending.is_empty() {
                self.emit_line(&mut out);
            }
            self.reset_scanner();
            self.finished = true;
        }
        out
    }

    fn emit_line(&mut self, out: &mut Vec<u8>) {
        if self.mode != Mode::Scanning {
            // Pieces already emitted their opaque marker/CR bytes.
            self.masker.advance_bytes(&self.pending);
            self.reset_scanner();
            self.pending.fill(0);
            self.pending.clear();
            self.opaque_line = false;
            return;
        }
        let body_end = self
            .pending
            .iter()
            .rposition(|b| *b != b'\r')
            .map_or(0, |i| i + 1);
        let (body, ending) = self.pending.split_at(body_end);
        let text = String::from_utf8_lossy(body);
        let blank = text.trim().is_empty();
        let (masked, count) = self.masker.mask_line_counted(&text);
        if count == 0 {
            out.extend_from_slice(body);
        } else {
            out.extend_from_slice(masked.as_bytes());
        }
        out.extend_from_slice(ending);
        if self.recovery_pending {
            if blank {
                // The file scanner consumes its pending token on a blank line.
                // Keep the recovery guard until the next non-blank line instead.
                self.prime_recovery();
            } else {
                self.recovery_pending = false;
            }
        }
        if self.masker.in_continuation() {
            self.state_input_bytes = self
                .state_input_bytes
                .saturating_add(self.pending.len() + 1);
            if self.state_input_bytes > MAX_STATE_INPUT_BYTES {
                self.make_opaque();
            }
        } else {
            self.state_input_bytes = 0;
        }
        self.pending.fill(0);
        self.pending.clear();
    }

    fn scan_piece(&mut self) {
        let cut = self
            .pending
            .iter()
            .rposition(u8::is_ascii_whitespace)
            .map_or(self.pending.len(), |i| i + 1);
        self.masker.advance_bytes(&self.pending[..cut]);
        self.reset_scanner();
        self.pending[..cut].fill(0);
        self.pending.drain(..cut);
    }

    fn reset_scanner(&mut self) {
        self.masker = LineMasker::new(self.masker.class());
        self.state_input_bytes = 0;
        self.recovery_pending = false;
    }

    fn prime_recovery(&mut self) {
        // Use the real token rule to set both pending-token and indent-0 state.
        let _ = self.masker.scan("X_TOKEN");
        self.recovery_pending = true;
    }

    fn make_opaque(&mut self) {
        self.mode = Mode::OpaqueStream;
        self.reset_scanner();
    }

    fn emit_opaque(started: &mut bool, bytes: &[u8], out: &mut Vec<u8>) {
        for byte in bytes {
            if *byte == b'\r' {
                out.push(*byte);
            } else if !*started {
                out.extend_from_slice(LINE_MARKER);
                *started = true;
            }
        }
    }
}

impl Drop for StreamMasker {
    fn drop(&mut self) {
        // A cancelled/disconnected session discards its unshared tail now.
        self.pending.fill(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        name: String,
        command: String,
        input: String,
        expected: String,
        hidden: Vec<String>,
    }

    fn cases() -> Vec<Case> {
        serde_json::from_str(include_str!("../tests/fixtures/masking/stream-cases.json"))
            .expect("masking fixture")
    }

    fn run(command: &str, chunks: &[&[u8]], hidden: &[String]) -> Vec<u8> {
        let mut masker = StreamMasker::new(command);
        let mut output = Vec::new();
        for chunk in chunks {
            let emitted = masker.push(chunk);
            output.extend(emitted);
            for secret in hidden {
                assert!(
                    !String::from_utf8_lossy(&output).contains(secret),
                    "emitted secret"
                );
            }
            assert!(masker.held() <= MAX_HELD_BYTES);
            assert!(masker.state_input_bytes <= MAX_STATE_INPUT_BYTES);
        }
        output.extend(masker.finish());
        assert_eq!(masker.held(), 0);
        assert!(masker.finish().is_empty());
        assert!(masker.push(b"late data\n").is_empty());
        output
    }

    #[test]
    fn every_byte_split_and_bytewise_feed_match_the_final_line_rules() {
        for case in cases() {
            let input = case.input.as_bytes();
            // Fixed expected output kills no-op/over-masking mutants; comparison
            // with the final API also pins continuation/marker compatibility.
            let expected = case.expected.as_bytes();
            assert_eq!(
                run(&case.command, &[input], &case.hidden),
                expected,
                "{}",
                case.name
            );
            let class = StreamMasker::new(&case.command).masker.class();
            let mut reference = LineMasker::new(class);
            let mut reference_text = String::new();
            for raw in case.input.split_inclusive('\n') {
                let line = raw.trim_end_matches(['\r', '\n']);
                reference_text.push_str(&reference.mask_line(line));
                reference_text.push_str(&raw[line.len()..]);
            }
            assert_eq!(reference_text.as_bytes(), expected, "{} API", case.name);
            for at in 0..=input.len() {
                assert_eq!(
                    run(&case.command, &[&input[..at], &input[at..]], &case.hidden),
                    expected,
                    "{} split {at}",
                    case.name
                );
            }
            assert_eq!(
                run(
                    &case.command,
                    &input.chunks(1).collect::<Vec<_>>(),
                    &case.hidden
                ),
                expected,
                "{} bytewise",
                case.name
            );
        }
    }

    #[test]
    fn pem_begin_body_end_are_three_separate_chunks() {
        let case = cases()
            .into_iter()
            .find(|c| c.name == "pem")
            .expect("pem row");
        let lines: Vec<_> = case.input.split_inclusive('\n').collect();
        let chunks = [
            lines[..2].concat(),
            lines[2].to_string(),
            lines[3..].concat(),
        ];
        assert_eq!(
            run(
                &case.command,
                &chunks.iter().map(|s| s.as_bytes()).collect::<Vec<_>>(),
                &case.hidden
            ),
            case.expected.as_bytes()
        );
    }

    #[test]
    fn negative_vendor_tokens_and_public_options_stay_visible() {
        let input = include_str!("../tests/fixtures/masking/stream-negatives.txt").as_bytes();
        assert_eq!(
            run("show", &input.chunks(1).collect::<Vec<_>>(), &[]),
            input
        );
    }

    #[test]
    fn invalid_utf8_passes_through_or_is_masked_using_the_lossy_view() {
        let case = cases()
            .into_iter()
            .find(|c| c.name == "token-next")
            .expect("token row");
        let mut input = b"\xff\xfe public\r\n".to_vec();
        input.push(0xff);
        input.extend_from_slice(case.input.as_bytes());
        let mut expected = b"\xff\xfe public\r\n\xffpublic\n".to_vec();
        expected.extend_from_slice(
            case.expected
                .strip_prefix("public\n")
                .expect("prefix")
                .as_bytes(),
        );
        for at in 0..=input.len() {
            assert_eq!(
                run("show", &[&input[..at], &input[at..]], &case.hidden),
                expected
            );
        }
        let mut secret_input = vec![0xff];
        secret_input.extend_from_slice(
            case.input
                .strip_prefix("public\n")
                .expect("prefix")
                .as_bytes(),
        );
        assert_eq!(
            run(
                "show",
                &secret_input.chunks(1).collect::<Vec<_>>(),
                &case.hidden
            ),
            case.expected
                .strip_prefix("public\n")
                .expect("prefix")
                .as_bytes()
        );
        let flag = cases()
            .into_iter()
            .find(|c| c.name == "flag")
            .expect("flag row");
        let mut flag_bytes = vec![0xff];
        flag_bytes.extend_from_slice(flag.input.as_bytes());
        let expected = format!("\u{fffd}{}", flag.expected);
        assert_eq!(
            run(
                "show",
                &flag_bytes.chunks(1).collect::<Vec<_>>(),
                &flag.hidden
            ),
            expected.as_bytes()
        );
    }

    #[test]
    fn unterminated_output_waits_for_eof_and_keeps_crlf_exactly() {
        let case = cases()
            .into_iter()
            .find(|c| c.name == "eof")
            .expect("eof row");
        let mut masker = StreamMasker::new("show");
        for byte in case.input.as_bytes() {
            assert!(masker.push(&[*byte]).is_empty());
        }
        assert_eq!(masker.finish(), case.expected.as_bytes());
        let clean = b"a\r\n\r\r\n\nb\r";
        assert_eq!(
            run("show", &clean.chunks(1).collect::<Vec<_>>(), &[]),
            clean
        );
    }

    #[test]
    fn hf_class_is_selected_by_command_text_only() {
        let case = cases()
            .into_iter()
            .find(|c| c.name == "hf")
            .expect("hf row");
        assert_eq!(
            run("show", &[case.input.as_bytes()], &[]),
            case.input.as_bytes()
        );
        for command in ["cat ~/.cache/huggingface/token", "cat ~/.huggingface/token"] {
            assert_eq!(
                run(command, &[case.input.as_bytes()], &case.hidden),
                case.expected.as_bytes()
            );
        }
    }

    #[test]
    fn long_lines_have_bounded_holdback_and_never_release_a_prefix_or_token_tail() {
        let secret = include_str!("../tests/fixtures/masking/stream-long.txt");
        // Secret before and after the cap, an unbroken token and whitespace-cut
        // pieces. ALL are outside accepted bounded lines and fail closed.
        for input in [
            format!(
                "{secret}{}\r\nnext\n  continuation\nvisible\n",
                "z".repeat(3 * 1024 * 1024)
            ),
            format!(
                "{}{secret}\r\nnext\n  continuation\nvisible\n",
                "word ".repeat(800_000)
            ),
            format!(
                "{}\nnext\n  continuation\nvisible\n",
                "z".repeat(3 * 1024 * 1024)
            ),
            format!(
                "{}\n{}\n",
                "a".repeat(MAX_HELD_BYTES + 1),
                "b".repeat(2 * 1024 * 1024)
            ),
        ] {
            let whole = run("show", &[input.as_bytes()], &[]);
            let chunked = run(
                "show",
                &input.as_bytes().chunks(997).collect::<Vec<_>>(),
                &[],
            );
            assert_eq!(chunked, whole);
            let expected = if input.contains("\r\n") {
                "⟦redacted line⟧\r\n⟦redacted line⟧\n⟦redacted⟧\nvisible\n"
            } else if input.contains("visible") {
                "⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted⟧\nvisible\n"
            } else {
                "⟦redacted line⟧\n⟦redacted line⟧\n"
            };
            assert_eq!(whole, expected.as_bytes());
        }
        // An exact-cap line is accepted; its LF arrives in the next chunk.
        let exact = "p".repeat(MAX_HELD_BYTES);
        let mut masker = StreamMasker::new("show");
        assert!(masker.push(exact.as_bytes()).is_empty());
        let mut expected = exact.into_bytes();
        expected.push(b'\n');
        assert_eq!(masker.push(b"\n"), expected);
        assert!(masker.finish().is_empty());
    }

    #[test]
    fn overlong_line_recovery_is_invariant_at_every_split_and_bytewise() {
        let long = "z".repeat(MAX_HELD_BYTES + 1);
        let pem = cases()
            .into_iter()
            .find(|c| c.name == "pem")
            .expect("pem row");
        let pem_input = pem.input.strip_prefix("before\n").expect("pem prefix");
        let pem_expected = pem.expected.strip_prefix("before\n").expect("pem prefix");
        for (name, input, expected) in [
            (
                "next and indentation",
                format!("{long}\nnext\n  continuation\nvisible\n"),
                "⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted⟧\nvisible\n".to_string(),
            ),
            (
                "CRLF and blanks before next",
                format!("{long}\r\n\r\n \t\r\nnext\r\n  continuation\r\nvisible\r\n"),
                "⟦redacted line⟧\r\n\r\n⟦redacted⟧\r\n⟦redacted line⟧\r\n⟦redacted⟧\r\nvisible\r\n"
                    .to_string(),
            ),
            (
                "exactly cap plus one",
                format!("{long}\nnext\nvisible\n"),
                "⟦redacted line⟧\n⟦redacted line⟧\nvisible\n".to_string(),
            ),
            (
                "two overlong lines",
                format!("{long}\n{long}\nnext\n  continuation\nvisible\n"),
                "⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted⟧\nvisible\n"
                    .to_string(),
            ),
            (
                "PEM immediately after recovery",
                format!("{long}\n{pem_input}"),
                format!("⟦redacted line⟧\n{pem_expected}"),
            ),
            (
                "EOF without LF",
                long.clone(),
                "⟦redacted line⟧".to_string(),
            ),
        ] {
            let bytes = input.as_bytes();
            assert_eq!(
                run("show", &[bytes], &pem.hidden),
                expected.as_bytes(),
                "{name}"
            );
            // Interior offsets of a long opaque run add nothing, so test every
            // split within 6 bytes of a line start, an LF, a piece cut (line
            // start + cap) and the end; feed bytewise in those windows and in
            // 4 KiB chunks elsewhere. (All 65k offsets x 6 rows took minutes.)
            let len = bytes.len();
            let mut interesting = vec![0, len];
            let mut line_start = 0;
            for (at, byte) in bytes.iter().enumerate() {
                if *byte == b'\n' {
                    interesting.push(at);
                    interesting.push(at + 1);
                    interesting.push(line_start + MAX_HELD_BYTES);
                    line_start = at + 1;
                }
            }
            interesting.push(line_start + MAX_HELD_BYTES);
            let mut near = vec![false; len + 1];
            for centre in interesting {
                let (from, to) = (centre.saturating_sub(6), (centre + 6).min(len));
                near.iter_mut()
                    .take(to + 1)
                    .skip(from)
                    .for_each(|flag| *flag = true);
            }
            for at in (0..=len).filter(|at| near[*at]) {
                assert_eq!(
                    run("show", &[&bytes[..at], &bytes[at..]], &pem.hidden),
                    expected.as_bytes(),
                    "{name} split {at}"
                );
            }
            let mut chunks: Vec<&[u8]> = Vec::new();
            let mut at = 0;
            while at < len {
                let step = if near[at] { 1 } else { 4096.min(len - at) };
                let end = (at + step).min(len);
                // never run a big chunk into a near window
                let end = (at + 1..=end)
                    .find(|e| near[*e] && *e > at + 1)
                    .map_or(end, |e| e - 1)
                    .max(at + 1);
                chunks.push(&bytes[at..end]);
                at = end;
            }
            assert_eq!(
                run("show", &chunks, &pem.hidden),
                expected.as_bytes(),
                "{name} chunked"
            );
        }
    }

    #[test]
    fn a_token_crossing_the_hold_cap_never_releases_the_earlier_line_prefix() {
        let secret = include_str!("../tests/fixtures/masking/stream-long.txt");
        let input = format!(
            "{}{secret}\r\nvisible\n",
            "public ".repeat(MAX_HELD_BYTES / 7)
        );
        assert!(input.len() > MAX_HELD_BYTES);
        let expected = "⟦redacted line⟧\r\n⟦redacted line⟧\n".as_bytes();
        for at in [
            0,
            MAX_HELD_BYTES - 1,
            MAX_HELD_BYTES,
            MAX_HELD_BYTES + 1,
            input.len(),
        ] {
            assert_eq!(
                run(
                    "show",
                    &[&input.as_bytes()[..at], &input.as_bytes()[at..]],
                    &[]
                ),
                expected
            );
        }
        assert_eq!(
            run("show", &input.as_bytes().chunks(1).collect::<Vec<_>>(), &[]),
            expected
        );
    }

    #[test]
    fn live_state_input_cap_stays_opaque_through_eof_even_after_long_lines() {
        let pem = cases()
            .into_iter()
            .find(|c| c.name == "missing-pem-end")
            .expect("pem row");
        let opener = pem.input.split_inclusive('\n').next().expect("opener");
        let mut masker = StreamMasker::new("show");
        for _ in 0..(MAX_STATE_INPUT_BYTES / opener.len() + 2) {
            assert!(!masker.push(opener.as_bytes()).is_empty());
            assert!(masker.held() <= MAX_HELD_BYTES);
            assert!(masker.state_input_bytes <= MAX_STATE_INPUT_BYTES);
        }
        assert_eq!(masker.mode, Mode::OpaqueStream, "unbounded live PEM stack");
        assert!(
            !masker.masker.in_continuation(),
            "opaque mode retained a PEM stack"
        );
        assert_eq!(
            masker.push(b"public after budget\n"),
            LINE_MARKER
                .iter()
                .copied()
                .chain(*b"\n")
                .collect::<Vec<_>>()
        );
        let long = format!(
            "{}\r\nnext\n  continuation\nvisible",
            "z".repeat(MAX_HELD_BYTES + 1)
        );
        let mut output = Vec::new();
        for chunk in long.as_bytes().chunks(997) {
            output.extend(masker.push(chunk));
            assert!(masker.held() <= MAX_HELD_BYTES);
            assert!(masker.state_input_bytes <= MAX_STATE_INPUT_BYTES);
            assert_eq!(masker.mode, Mode::OpaqueStream);
        }
        output.extend(masker.finish());
        assert_eq!(
            output,
            "⟦redacted line⟧\r\n⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted line⟧".as_bytes()
        );
        assert_eq!(masker.held(), 0);
        assert!(masker.finish().is_empty());
        assert!(masker.push(b"late\n").is_empty());
        assert!(!masker.masker.in_continuation());
    }

    #[test]
    fn the_documented_bounds_are_pinned() {
        assert_eq!(MAX_HELD_BYTES, 64 * 1024);
        assert_eq!(MAX_STATE_INPUT_BYTES, 1024 * 1024);
    }

    #[test]
    fn streamed_scanning_stays_linear_on_two_mebibytes() {
        use std::time::{Duration, Instant};
        let mixed = include_str!("../tests/fixtures/masking/stream-session.txt");
        for (label, block) in [
            ("mixed", format!("{mixed}\n\n")),
            ("plain", "INFO request completed in 12 ms\n".to_string()),
        ] {
            let data = block.repeat(2 * 1024 * 1024 / block.len());
            let mut masker = StreamMasker::new("show");
            let started = Instant::now();
            let mut emitted = 0;
            for chunk in data.as_bytes().chunks(16 * 1024) {
                emitted += masker.push(chunk).len();
            }
            emitted += masker.finish().len();
            std::hint::black_box(emitted);
            let elapsed = started.elapsed();
            let bound = if cfg!(debug_assertions) {
                Duration::from_secs(5)
            } else {
                Duration::from_millis(250)
            };
            assert!(elapsed < bound, "{label}: {elapsed:?}");
        }
    }
}
