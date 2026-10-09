//! Command-output masking for accidental disclosure (issue #107).
//!
//! Every server-visible exec stream and supervised shared/review capture uses
//! [`StreamMasker`]. The encrypted PTY viewer still receives the original bytes.
//! Detection uses the terminal/control-filtered view and unchanged file-tool
//! [`LineMasker`] rules. Bounded unmasked output passes through byte for byte;
//! ordinary masked lines emit cleaned text with their exact trailing CR/LF.
//! Terminal state and UTF-8 decoding survive chunks and physical lines. An LF
//! inside an unfinished terminal sequence is held with the preceding text until
//! a ground-state LF, so hidden newlines cannot join an unscanned secret name.
//! A masked group spanning physical lines is opaque with physical CR/LF kept;
//! this also prevents a raw control opener losing its masked-away terminator.
//! Naming a Hugging Face token file selects [`FileClass::HfToken`]. No disk
//! access, vendor-prefix credential scanner, or additional naming rules run.
//!
//! Latency is bounded in bytes: hold at most [`MAX_HELD_BYTES`] until a
//! ground-state LF, EOF, or the next byte. Overlong lines/groups emit only opaque
//! markers and CR/LF; no prefix or token tail leaves the CLI. Their cleaned pieces
//! retain only exact private-key labels, duplicate counts and a 1 KiB marker
//! overlap. At terminating LF, recovery always masks nonblank output until the
//! next blank line, plus the next nonblank line and deeper indentation. PEM
//! blocks close at their matching END; blank lines keep the next-value guard.
//! A PEM marker larger than the overlap, or a live-state input budget larger
//! than [`MAX_STATE_INPUT_BYTES`], makes the remaining stream opaque through EOF.
//! A cleaned LF inside an overlong group also makes the stream opaque.
//! An opener live BEFORE crossing the hold cap also keeps that accepted opaque
//! policy. Opaque mode frees scanner/carry state and keeps terminal state current.
//! EOF seals and flushes once; cancellation wipes/discards retained raw/cleaned
//! bytes. Invalid UTF-8 stays raw when unmasked and is lossy when masked.
//!
//! Capture totals and `output_bytes` count these masked bytes, before head/tail
//! retention. Plain command output never uses the dotenv `KEY=⟦redacted:N⟧` view.

#[cfg(unix)]
use crate::file_ops::redact::{FileClass, LineMasker, SameLineCarry};
#[cfg(not(unix))]
#[allow(dead_code)]
#[path = "file_ops/redact.rs"]
mod redact;
#[cfg(not(unix))]
use redact::{FileClass, LineMasker, SameLineCarry};

use crate::terminal_parse::TerminalByteState;

/// Maximum raw tail retained per stream (LF is handled separately).
pub const MAX_HELD_BYTES: usize = 64 * 1024;
/// Bound on input that can contribute live openers (PEM labels/indentation).
/// This bounds scanner state as well as the raw line tail, conservatively.
pub const MAX_STATE_INPUT_BYTES: usize = 1024 * 1024;
const LINE_MARKER: &[u8] = "⟦redacted line⟧".as_bytes();

#[derive(Debug, PartialEq, Eq)]
enum Mode {
    Scanning,
    /// The overlong line is opaque; at LF, recovery masks through the next
    /// blank line. Used only when no multi-line opener was already live.
    OverlongLine,
    /// Every remaining nonempty line is opaque through EOF (the 1 MiB state
    /// fallback, and an overlong line inside a live opener).
    OpaqueStream,
}

/// One restartable masker per output stream. Chunk boundaries carry no meaning.
pub struct StreamMasker {
    masker: LineMasker,
    pending: Vec<u8>,
    cleaned: String,
    terminal: TerminalByteState,
    carry: SameLineCarry,
    mode: Mode,
    opaque_line: bool,
    recovery_pending: bool,
    finished: bool,
    state_input_bytes: usize,
    hold_limit: usize,
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
            cleaned: String::new(),
            terminal: TerminalByteState::default(),
            carry: SameLineCarry::default(),
            mode: Mode::Scanning,
            opaque_line: false,
            recovery_pending: false,
            finished: false,
            state_input_bytes: 0,
            hold_limit: MAX_HELD_BYTES,
        }
    }

    /// Raw bytes held for the next bounded terminal group or piece.
    pub fn held(&self) -> usize {
        self.pending.len()
    }

    /// Feed raw output; only the returned bytes may enter the shared copy.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        if self.finished {
            return out;
        }
        for &byte in bytes {
            // A ground-state LF terminates an exact-cap group without overflow.
            if self.pending.len() == self.hold_limit
                && !(byte == b'\n' && self.terminal.at_boundary())
            {
                if self.mode == Mode::Scanning {
                    let live_opener = self.masker.has_content_continuation()
                        || (self.masker.in_continuation() && !self.recovery_pending);
                    self.mode = if live_opener {
                        Mode::OpaqueStream
                    } else {
                        Mode::OverlongLine
                    };
                    self.reset_scanner();
                    Self::emit_opaque(&mut self.opaque_line, &self.pending, &mut out);
                }
                self.scan_piece();
            }
            self.terminal.feed_clean(byte, &mut self.cleaned);
            if byte == b'\n' && self.terminal.at_boundary() {
                // Keep hidden physical LFs in the group until the terminal is
                // ground. Otherwise OSC/APC/DCS can join a name across lines,
                // or raw opening bytes can outlive a masked-away terminator.
                self.cleaned.pop();
                self.emit_group(&mut out);
                out.push(byte);
                self.opaque_line = false;
                if self.mode == Mode::OverlongLine {
                    self.mode = Mode::Scanning;
                    self.reset_scanner();
                    let carry = std::mem::take(&mut self.carry);
                    if let Some(cost) = carry.recover(&mut self.masker) {
                        self.prime_recovery();
                        self.state_input_bytes = cost;
                    } else {
                        self.make_opaque();
                    }
                }
            } else {
                if self.mode != Mode::Scanning {
                    Self::emit_opaque(&mut self.opaque_line, &[byte], &mut out);
                }
                self.pending.push(byte);
            }
        }
        out
    }

    /// Flush a partial last group at EOF/completion. Idempotent; seals the stream.
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if !self.finished {
            self.terminal.finish_clean(&mut self.cleaned);
            if !self.pending.is_empty() {
                self.emit_group(&mut out);
            }
            self.reset_scanner();
            self.carry = SameLineCarry::default();
            self.finished = true;
        }
        out
    }

    fn emit_group(&mut self, out: &mut Vec<u8>) {
        if self.mode != Mode::Scanning {
            self.scan_piece();
            return;
        }
        let mut rendered = String::new();
        let mut any_mask = false;
        // A terminal group may contain executable LF inside an unfinished CSI,
        // as well as hidden LF inside a control string. Scan visible lines only.
        let lines: Vec<&str> = if self.cleaned.is_empty() {
            vec![""]
        } else {
            self.cleaned.split_inclusive('\n').collect()
        };
        for raw in lines {
            let line = raw.trim_end_matches(['\r', '\n']);
            let (masked, count) = self.masker.mask_line_counted(line);
            any_mask |= count != 0;
            rendered.push_str(&masked);
            rendered.push_str(&raw[line.len()..]);
            if self.recovery_pending {
                if line.trim().is_empty() {
                    let _ = self.masker.scan("X_TOKEN");
                } else {
                    self.recovery_pending = false;
                }
            }
        }
        if !any_mask {
            out.extend_from_slice(&self.pending);
        } else if self.pending.contains(&b'\n') {
            // Mapping a mask over an LF hidden by OSC/DCS would reintroduce a
            // printable join. Conservatively mask the whole terminal group,
            // preserving every physical CR/LF byte in its original order.
            Self::emit_opaque(&mut self.opaque_line, &self.pending, out);
        } else {
            out.extend_from_slice(rendered.as_bytes());
            // Trailing physical CRs hidden by a control sequence still frame
            // the line; they survive even though the cleaned view omitted them.
            let raw_crs = self
                .pending
                .iter()
                .rev()
                .take_while(|b| **b == b'\r')
                .count();
            let rendered_crs = rendered.bytes().rev().take_while(|b| *b == b'\r').count();
            out.extend(std::iter::repeat_n(
                b'\r',
                raw_crs.saturating_sub(rendered_crs),
            ));
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
        self.clear_piece();
    }

    fn scan_piece(&mut self) {
        if self.mode == Mode::OverlongLine {
            self.carry
                .feed(&self.cleaned, self.pending.len(), MAX_STATE_INPUT_BYTES);
            if self.carry.unrepresentable() {
                self.make_opaque();
            }
        }
        self.clear_piece();
    }

    fn clear_piece(&mut self) {
        self.pending.fill(0);
        self.pending.clear();
        // Cleaned content is sensitive too. String::clear alone would leave it
        // in the allocation. Moving to bytes permits wiping without unsafe.
        let mut bytes = std::mem::take(&mut self.cleaned).into_bytes();
        bytes.fill(0);
        bytes.clear();
        self.cleaned = String::from_utf8(bytes).unwrap_or_default();
    }

    fn reset_scanner(&mut self) {
        self.masker = LineMasker::new(self.masker.class());
        self.state_input_bytes = 0;
        self.recovery_pending = false;
    }

    fn prime_recovery(&mut self) {
        // One unconditional recovery rule covers every overlong value shape.
        // The open quote seeds UntilBlank alongside the token's column-0 block
        // and next-nonblank guard; PEM labels have already been restored.
        let _ = self.masker.scan("X_TOKEN=\"");
        self.recovery_pending = true;
    }

    fn make_opaque(&mut self) {
        self.mode = Mode::OpaqueStream;
        self.reset_scanner();
        self.carry = SameLineCarry::default();
    }

    fn emit_opaque(started: &mut bool, bytes: &[u8], out: &mut Vec<u8>) {
        for byte in bytes {
            if matches!(*byte, b'\r' | b'\n') {
                out.push(*byte);
                if *byte == b'\n' {
                    *started = false;
                }
            } else if !*started {
                out.extend_from_slice(LINE_MARKER);
                *started = true;
            }
        }
    }
}

impl Drop for StreamMasker {
    fn drop(&mut self) {
        self.clear_piece();
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

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DesignCase {
        name: String,
        input: String,
        expected: String,
        #[serde(default)]
        prefix: String,
        #[serde(default)]
        prefix_repeat: usize,
        #[serde(default)]
        hidden: Vec<String>,
        #[serde(default)]
        input_segments: Vec<FixtureSegment>,
        #[serde(default)]
        production_cap: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureSegment {
        text: String,
        #[serde(default = "single_repeat")]
        repeat: usize,
        #[serde(default)]
        grow_with_cap: bool,
    }

    fn single_repeat() -> usize {
        1
    }

    impl DesignCase {
        fn expanded_input(&self, hold_limit: usize) -> String {
            let growth = hold_limit - DESIGN_HOLD_BYTES;
            let prefix_repeat = self.prefix_repeat
                + if self.prefix.is_empty() {
                    0
                } else {
                    growth / self.prefix.len()
                };
            let mut input = self.prefix.repeat(prefix_repeat);
            for segment in &self.input_segments {
                let repeats = segment.repeat
                    + if segment.grow_with_cap {
                        assert!(
                            !segment.text.is_empty(),
                            "{} empty repeat segment",
                            self.name
                        );
                        growth / segment.text.len()
                    } else {
                        0
                    };
                input.push_str(&segment.text.repeat(repeats));
            }
            input.push_str(&self.input);
            input
        }
    }

    fn design_input(case: &DesignCase, hold_limit: usize) -> String {
        case.expanded_input(hold_limit)
    }

    const DESIGN_HOLD_BYTES: usize = 128;

    fn design_run(chunks: &[&[u8]], hidden: &[String]) -> Vec<u8> {
        let mut masker = StreamMasker::new("show");
        // Exhaustive splits use the SAME algorithm with a smaller byte cap.
        // A separate production-boundary check pins the public default.
        masker.hold_limit = DESIGN_HOLD_BYTES;
        let mut output = Vec::new();
        for chunk in chunks {
            output.extend(masker.push(chunk));
            assert!(masker.held() <= DESIGN_HOLD_BYTES);
            assert!(masker.cleaned.len() <= 3 * DESIGN_HOLD_BYTES);
            assert!(masker.carry.pem_tail_len() <= SameLineCarry::OVERLAP);
            assert!(masker.state_input_bytes <= MAX_STATE_INPUT_BYTES);
            for value in hidden {
                assert!(!String::from_utf8_lossy(&output).contains(value));
            }
        }
        output.extend(masker.finish());
        assert!(masker.finish().is_empty());
        assert!(masker.push(b"late\n").is_empty());
        assert_eq!(masker.held(), 0);
        output
    }

    fn design_table(fixture: &str) {
        let cases: Vec<DesignCase> = serde_json::from_str(fixture).expect("design cases");
        for case in cases {
            let input = design_input(&case, DESIGN_HOLD_BYTES);
            let bytes = input.as_bytes();
            assert_eq!(
                design_run(&[bytes], &case.hidden),
                case.expected.as_bytes(),
                "{} whole",
                case.name
            );
            for at in 0..=bytes.len() {
                assert_eq!(
                    design_run(&[&bytes[..at], &bytes[at..]], &case.hidden),
                    case.expected.as_bytes(),
                    "{} split {at}",
                    case.name
                );
            }
            assert_eq!(
                design_run(&bytes.chunks(1).collect::<Vec<_>>(), &case.hidden),
                case.expected.as_bytes(),
                "{} bytewise",
                case.name
            );
        }
    }

    #[test]
    fn design_adversarial_table_every_byte_split_and_bytewise() {
        design_table(include_str!(
            "../tests/fixtures/masking/stream-design-cases.json"
        ));
    }

    #[test]
    fn design_inverse_table_preserves_raw_bytes_and_recovers() {
        design_table(include_str!(
            "../tests/fixtures/masking/stream-design-controls.json"
        ));
    }

    #[test]
    fn design_openers_cross_the_production_cap_with_the_same_recovery() {
        let cases: Vec<DesignCase> = serde_json::from_str(include_str!(
            "../tests/fixtures/masking/stream-design-cases.json"
        ))
        .expect("design cases");
        let controls: Vec<DesignCase> = serde_json::from_str(include_str!(
            "../tests/fixtures/masking/stream-design-controls.json"
        ))
        .expect("design controls");
        for case in cases
            .into_iter()
            .chain(controls)
            .filter(|case| case.production_cap)
        {
            let input = design_input(&case, MAX_HELD_BYTES);
            let bytes = input.as_bytes();
            for chunks in [
                vec![bytes],
                bytes.chunks(4096).collect(),
                bytes.chunks(1).collect(),
            ] {
                assert_eq!(
                    run("show", &chunks, &case.hidden),
                    case.expected.as_bytes(),
                    "{} production cap",
                    case.name
                );
            }
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
                "{secret}{}\r\nnext\n  continuation\nordinary output\n\nvisible\n",
                "z".repeat(3 * 1024 * 1024)
            ),
            format!(
                "{}{secret}\r\nnext\n  continuation\nordinary output\n\nvisible\n",
                "word ".repeat(800_000)
            ),
            format!(
                "{}\nnext\n  continuation\nordinary output\n\nvisible\n",
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
                "⟦redacted line⟧\r\n⟦redacted line⟧\n⟦redacted⟧\n⟦redacted⟧\n\nvisible\n"
            } else if input.contains("visible") {
                "⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted⟧\n⟦redacted⟧\n\nvisible\n"
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

    /// Asserts `run` reproduces `expected` for every split of `input` near a
    /// line start, an LF, a piece cut (line start + cap) or the end, for a
    /// bytewise feed inside those windows, and for a 4 KiB chunked feed. Also
    /// injects every `hidden` secret into the check. Interior offsets of a long
    /// opaque run add nothing, so they are fed in 4 KiB chunks. (All offsets of
    /// a 3 MiB input x a handful of rows took minutes.)
    fn assert_split_invariant(
        command: &str,
        name: &str,
        input: &str,
        expected: &str,
        hidden: &[String],
    ) {
        let bytes = input.as_bytes();
        assert_eq!(
            run(command, &[bytes], hidden),
            expected.as_bytes(),
            "{name}"
        );
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
                run(command, &[&bytes[..at], &bytes[at..]], hidden),
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
            run(command, &chunks, hidden),
            expected.as_bytes(),
            "{name} chunked"
        );
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
                format!("{long}\nnext\n  continuation\nordinary output\n\nvisible\n"),
                "⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted⟧\n⟦redacted⟧\n\nvisible\n".to_string(),
            ),
            (
                "CRLF and blanks before next",
                format!("{long}\r\n\r\n \t\r\nnext\r\n  continuation\r\n\r\nvisible\r\n"),
                "⟦redacted line⟧\r\n\r\n⟦redacted⟧\r\n⟦redacted line⟧\r\n⟦redacted⟧\r\n\r\nvisible\r\n"
                    .to_string(),
            ),
            (
                "exactly cap plus one",
                format!("{long}\nnext\n\nvisible\n"),
                "⟦redacted line⟧\n⟦redacted line⟧\n\nvisible\n".to_string(),
            ),
            (
                "two overlong lines",
                format!("{long}\n{long}\nnext\n  continuation\nordinary output\n\nvisible\n"),
                "⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted line⟧\n\n⟦redacted line⟧\n"
                    .to_string(),
            ),
            (
                "PEM immediately after recovery",
                format!("{long}\n\n{pem_input}"),
                format!("⟦redacted line⟧\n\n{pem_expected}"),
            ),
            (
                "EOF without LF",
                long.clone(),
                "⟦redacted line⟧".to_string(),
            ),
        ] {
            // Interior offsets of a long opaque run add nothing, so test every
            // split within 6 bytes of a line start, an LF, a piece cut (line
            // start + cap) and the end; feed bytewise in those windows and in
            // 4 KiB chunks elsewhere.
            assert_split_invariant("show", name, &input, &expected, &pem.hidden);
        }
    }

    /// Every row here starts with a live multi-line opener, crosses the hold cap
    /// on a line inside it, and then prints column-0 body lines that the opener
    /// would still mask. The cap transition must not drop that opener: the
    /// stream goes opaque through EOF. The last row has no live opener and must
    /// still recover at the terminating LF, and the row after it pins that the
    /// fail-closed transition does not leak a later same-stream secret either.
    #[test]
    fn an_overlong_line_inside_a_live_opener_makes_the_rest_of_the_stream_opaque() {
        let long = "z".repeat(MAX_HELD_BYTES + 1);
        let overlong_blank = format!("\n{}", " ".repeat(MAX_HELD_BYTES + 1));
        // The private-key markers live in the owner-approved fixture directory,
        // the only place fake secret-shaped text is allowed (see policy-checks).
        let begin = include_str!("../tests/fixtures/masking/stream-overlong.txt");
        let begin = begin.trim_end();
        let end = "-----END PRIVATE KEY-----";
        for (name, input, expected) in [
            (
                "PEM body",
                format!("{begin}\n{long}\nb64bodysecret107-three\n{end}\nvisible\n"),
                "⟦redacted⟧\n⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted line⟧\n"
                    .to_string(),
            ),
            (
                "open quote run",
                format!("APP_TOKEN\nquote-open \"{long}\nquoterunsecret107-three\n\nvisible\n"),
                "⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted line⟧\n\n⟦redacted line⟧\n"
                    .to_string(),
            ),
            (
                // The line that crosses the cap is blanks-only but indented, so
                // it is part of the run: opaque through EOF with the blank left
                // as it was (its bytes are not secret).
                "indentation block, blank line inside",
                format!("APP_SECRET:\n{overlong_blank}\nindentblocksecret107-three\nvisible\n"),
                "⟦redacted line⟧\n\n⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted line⟧\n"
                    .to_string(),
            ),
            (
                "indentation block, dedent to column 0",
                format!("APP_SECRET:\n{long}\nindentblocksecret107-three\nvisible\n"),
                "⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted line⟧\n".to_string(),
            ),
            (
                "no live opener still recovers",
                format!("{long}\nnext\n  continuation\nordinary output\n\nvisible\n"),
                "⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted⟧\n⟦redacted⟧\n\nvisible\n".to_string(),
            ),
            (
                "opaque to EOF hides a later PEM too",
                format!("{begin}\n{long}\nlatepemsecret107-three\n{end}\n"),
                "⟦redacted⟧\n⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted line⟧\n".to_string(),
            ),
        ] {
            let hidden = [
                "b64bodysecret107-three".to_string(),
                "quoterunsecret107-three".to_string(),
                "indentblocksecret107-three".to_string(),
                "latepemsecret107-three".to_string(),
            ];
            assert_split_invariant("show", name, &input, &expected, &hidden);
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
    fn recovered_same_line_openers_keep_their_live_input_budget() {
        let pem = cases()
            .into_iter()
            .find(|case| case.name == "missing-pem-end")
            .expect("PEM fixture");
        let opener = pem.input.split_inclusive('\n').next().expect("opener");
        let count = MAX_STATE_INPUT_BYTES / opener.len() - 1;
        let line = format!("{}\n", opener.trim_end().repeat(count));
        let mut masker = StreamMasker::new("show");
        let _ = masker.push(line.as_bytes());
        assert_eq!(masker.mode, Mode::Scanning);
        assert!(masker.state_input_bytes >= count * opener.len());
        // A recovered stack near the cap has only its original budget left.
        for _ in 0..3 {
            let _ = masker.push(opener.as_bytes());
        }
        assert_eq!(masker.mode, Mode::OpaqueStream);
        assert_eq!(
            masker.push(b"public\n"),
            LINE_MARKER
                .iter()
                .copied()
                .chain(*b"\n")
                .collect::<Vec<_>>()
        );
        assert!(masker.finish().is_empty());
    }

    #[test]
    fn the_documented_bounds_are_pinned() {
        let controls: Vec<DesignCase> = serde_json::from_str(include_str!(
            "../tests/fixtures/masking/stream-design-controls.json"
        ))
        .expect("design controls");
        let default_case = controls
            .iter()
            .find(|case| case.name == "raw-sgr-public")
            .expect("bounded control");
        assert!(!default_case.production_cap);
        assert!(default_case.input_segments.is_empty());
        assert_eq!(
            design_input(default_case, DESIGN_HOLD_BYTES),
            default_case.input
        );
        let cases: Vec<DesignCase> = serde_json::from_str(include_str!(
            "../tests/fixtures/masking/stream-design-cases.json"
        ))
        .expect("design cases");
        let default_segment = cases
            .iter()
            .find(|case| case.name == "pending-flag-value-quote-P1")
            .and_then(|case| case.input_segments.first())
            .expect("segment with omitted defaults");
        assert_eq!(default_segment.repeat, 1);
        assert!(!default_segment.grow_with_cap);
        assert_eq!(MAX_HELD_BYTES, 64 * 1024);
        assert_eq!(MAX_STATE_INPUT_BYTES, 1024 * 1024);
        let mut masker = StreamMasker::new("show");
        assert_eq!(masker.hold_limit, MAX_HELD_BYTES);
        let exact = vec![b'p'; MAX_HELD_BYTES];
        assert!(masker.push(&exact).is_empty());
        assert_eq!(masker.held(), MAX_HELD_BYTES);
        assert_eq!(masker.push(b"p"), LINE_MARKER);
        assert_eq!(masker.held(), 1);
        assert_eq!(
            masker.push(b"\r\nnext\nordinary output\n\nvisible\n"),
            b"\r\n"
                .iter()
                .copied()
                .chain(LINE_MARKER.iter().copied())
                .chain(*b"\n")
                .chain("⟦redacted⟧".bytes())
                .chain(*b"\n\nvisible\n")
                .collect::<Vec<_>>()
        );
    }

    /// The live-state counter measures the CURRENT run, not the stream: a run
    /// that closes before the cap must reset it. Many separate short runs feed
    /// more than `MAX_STATE_INPUT_BYTES` in total; the stream must stay
    /// recoverable (each row is a fresh counter reset), not opaque.
    #[test]
    fn closing_a_continuation_resets_the_live_state_counter() {
        let mut input = String::new();
        let mut expected = String::new();
        let runs = MAX_STATE_INPUT_BYTES / 32 + 1;
        for _ in 0..runs {
            input.push_str("APP_SECRET:\n  first-secret-107\n  second-secret-107\n\npublic\n");
            expected.push_str("⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted⟧\n\npublic\n");
        }
        assert!(input.len() > MAX_STATE_INPUT_BYTES);
        // A live tail is what the recovery marker covers; the point here is that
        // the counter stayed below the cap (the mode never becomes opaque).
        input.push_str("result: 42\n");
        expected.push_str("result: 42\n");
        let mut masker = StreamMasker::new("show");
        let mut output = Vec::new();
        let bytes = input.as_bytes();
        for chunk in bytes.chunks(997) {
            output.extend(masker.push(chunk));
            assert!(masker.state_input_bytes <= MAX_STATE_INPUT_BYTES);
            assert_ne!(masker.mode, Mode::OpaqueStream, "counter never reset");
        }
        output.extend(masker.finish());
        assert_eq!(output, expected.as_bytes());
    }

    #[test]
    fn streamed_scanning_stays_linear_on_two_mebibytes() {
        use std::time::{Duration, Instant};
        // A wall-clock budget fails under machine load, so compare against
        // the same workload at one sixteenth the size, measured in the same run.
        // Linear scanning costs about 16x; quadratic scanning costs about 256x.
        // Interleaved rounds, keeping each size's fastest, cancel out load
        // that rises or falls while the test runs.
        const LARGE: usize = 2 * 1024 * 1024;
        const SMALL: usize = LARGE / 16;
        const ROUNDS: usize = 3;
        const MAX_RATIO: f64 = 48.0;
        fn scan(data: &[u8]) -> Duration {
            let mut masker = StreamMasker::new("show");
            let started = Instant::now();
            let mut emitted = 0;
            for chunk in data.chunks(16 * 1024) {
                emitted += masker.push(chunk).len();
            }
            emitted += masker.finish().len();
            std::hint::black_box(emitted);
            started.elapsed()
        }
        let mixed = include_str!("../tests/fixtures/masking/stream-session.txt");
        for (label, block) in [
            ("mixed", format!("{mixed}\n\n")),
            ("plain", "INFO request completed in 12 ms\n".to_string()),
        ] {
            let large = block.repeat(LARGE / block.len());
            let small = block.repeat(SMALL / block.len());
            let (mut small_best, mut large_best) = (Duration::MAX, Duration::MAX);
            for _ in 0..ROUNDS {
                small_best = small_best.min(scan(small.as_bytes()));
                large_best = large_best.min(scan(large.as_bytes()));
            }
            let size_ratio = large.len() as f64 / small.len() as f64;
            let ratio = large_best.as_secs_f64() / small_best.as_secs_f64().max(1e-9);
            assert!(
                ratio < MAX_RATIO,
                "{label}: {size_ratio:.1}x input took {ratio:.1}x time \
                 ({small_best:?} -> {large_best:?})"
            );
        }
    }
}
