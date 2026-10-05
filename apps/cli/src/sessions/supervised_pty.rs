//! The Unix side of a supervised (agent-requested) terminal: the env the
//! daemon hands the confirm child, the in-band markers between them, and the
//! per-terminal state that follows the child's PTY. Supervised terminals need
//! a Unix PTY: elsewhere the hello reports `terminalSupported: false` and
//! `spawn_supervised` refuses with `unsupported`, so none of this is built.

use super::{Capture, terminal_crypto};
use crate::protocol::FileErrorCode;

/// Env names the daemon sets for `wsmp terminal supervised-run`. The child
/// removes them before it execs the command.
pub(crate) const SUPERVISED_ENV_COMMAND: &str = "WSMP_SUPERVISED_COMMAND";
pub(crate) const SUPERVISED_ENV_REASON: &str = "WSMP_SUPERVISED_REASON";
pub(crate) const SUPERVISED_ENV_REQUESTER: &str = "WSMP_SUPERVISED_REQUESTER";
pub(crate) const SUPERVISED_ENV_SHARE: &str = "WSMP_SUPERVISED_SHARE";
pub(crate) const SUPERVISED_ENV_MARKER: &str = "WSMP_SUPERVISED_MARKER";
pub(crate) const SUPERVISED_ENV_FILE_OP: &str = "WSMP_SUPERVISED_FILE_OP";
pub(crate) const SUPERVISED_ENV_FILE_ARGS: &str = "WSMP_SUPERVISED_FILE_ARGS";
pub(crate) const SUPERVISED_ENV_FILE_BODY: &str = "WSMP_SUPERVISED_FILE_BODY";
pub(crate) const SUPERVISED_ENV_FILE_ETAG_KEY: &str = "WSMP_SUPERVISED_FILE_ETAG_KEY";
pub(crate) const SUPERVISED_ENV_FILE_PREIMAGE: &str = "WSMP_SUPERVISED_FILE_PREIMAGE";
pub(crate) const SUPERVISED_ENV_FILE_BLOCKED: &str = "WSMP_SUPERVISED_FILE_BLOCKED";
pub(crate) const SUPERVISED_ENV_FILE_ALLOW_ROOT: &str = "WSMP_SUPERVISED_FILE_ALLOW_ROOT";
pub(crate) const SUPERVISED_ENV_FILE_ROOTS: &str = "WSMP_SUPERVISED_FILE_ROOTS";
/// The operator (deployment) confirm screen's request, as JSON
/// (`supervised_run::operator::OperatorRequest`).
pub(crate) const SUPERVISED_ENV_OPERATOR: &str = "WSMP_SUPERVISED_OPERATOR";
pub(crate) const SUPERVISED_ENV_NAMES: [&str; 14] = [
    SUPERVISED_ENV_COMMAND,
    SUPERVISED_ENV_REASON,
    SUPERVISED_ENV_REQUESTER,
    SUPERVISED_ENV_SHARE,
    SUPERVISED_ENV_MARKER,
    SUPERVISED_ENV_FILE_OP,
    SUPERVISED_ENV_FILE_ARGS,
    SUPERVISED_ENV_FILE_BODY,
    SUPERVISED_ENV_FILE_ETAG_KEY,
    SUPERVISED_ENV_FILE_PREIMAGE,
    SUPERVISED_ENV_FILE_BLOCKED,
    SUPERVISED_ENV_FILE_ALLOW_ROOT,
    SUPERVISED_ENV_FILE_ROOTS,
    SUPERVISED_ENV_OPERATOR,
];

/// The in-band signal between the confirm child and the daemon: an OSC
/// sequence carrying a per-spawn random marker that only the two of them
/// know. On the PTY output, `kind` is `ready` (screen drawn, stdin flushed)
/// or `accepted` (Enter pressed; the child waits). On the PTY input, `go` is
/// the daemon's decision that the command may start: it is written only when
/// the daemon takes `accepted` while the request is still waiting, so a
/// server expiry or cancel handled first means the command never starts.
///
/// The operator (deployment) confirm child adds `exited;<code>` on the PTY
/// output: the command it ran after `go` ended with `<code>` (0..=255,
/// decimal, no leading zeros). A non-zero code is followed by a new `ready`
/// when the child offers a retry; see [`MarkerScanner::operator`].
pub(crate) fn supervised_marker(kind: &str, marker: &str) -> Vec<u8> {
    format!("\x1b]7717;wsmp-supervised;{kind};{marker}\x07").into_bytes()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MarkerEvent {
    Ready,
    Accepted,
    Blocked(FileErrorCode),
    /// Operator grammar only: the confirmed command exited with this code.
    Exited(u8),
    Invalid,
}

/// Which confirm child the scanner listens to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Grammar {
    /// Agent command or file: ready -> (accepted | blocked;<code>), once.
    Supervised,
    /// Deployment operator step: ready -> accepted -> exited;<code>, where a
    /// non-zero code starts the cycle again (retry) and 0 ends it.
    #[cfg_attr(not(test), allow(dead_code))] // Chunk 5 spawns operator terminals.
    Operator,
}

/// Where an operator child is in its cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OperatorPhase {
    /// Before the (first or retry) screen's `ready`.
    AwaitReady,
    /// The screen is up; only `accepted` may follow.
    AwaitDecision,
    /// The command runs; only `exited;<code>` may follow.
    Running,
}

/// `<code>` of an `exited;<code>` marker: canonical decimal 0..=255.
fn exit_code(text: &str) -> Option<u8> {
    let canonical = !text.is_empty()
        && text.len() <= 3
        && text.bytes().all(|byte| byte.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'));
    canonical.then(|| text.parse().ok()).flatten()
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Piece {
    Bytes(Vec<u8>),
    Event(MarkerEvent),
}

/// Finds the confirm child's markers in PTY output, including markers split
/// across reads, and removes them from what viewers see. The accepted grammar
/// is ready -> (accepted | blocked;<FileErrorCode>), authenticated by the
/// per-request marker. Each decision is honored once; later output passes
/// through untouched, so a command printing a marker changes nothing.
pub(super) struct MarkerScanner {
    grammar: Grammar,
    operator: OperatorPhase,
    prefix: Vec<u8>,
    marker: Vec<u8>,
    /// Output that may be the start of a marker, held until it is decided.
    pending: Vec<u8>,
    ready_seen: bool,
    done: bool,
}

pub(super) fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The longest proper prefix of `marker` that ends `bytes`.
fn marker_prefix_suffix(bytes: &[u8], marker: &[u8]) -> usize {
    let longest = marker.len().saturating_sub(1).min(bytes.len());
    (1..=longest)
        .rev()
        .find(|len| bytes.ends_with(&marker[..*len]))
        .unwrap_or(0)
}

impl MarkerScanner {
    pub(super) fn new(marker: &str) -> Self {
        Self::with_grammar(marker, Grammar::Supervised)
    }

    /// A scanner for the operator (deployment) confirm child. Its grammar is
    /// `ready -> accepted -> exited;<code>`, repeated while `<code>` is not 0:
    /// after a failed run the child redraws the screen (a new `ready`) and a
    /// person may run the command again. `exited;0` ends it. Any event out of
    /// that order, a `blocked` verdict or a malformed code is `Invalid` and
    /// ends the scan: the child never produces one.
    #[cfg_attr(not(test), allow(dead_code))] // Chunk 5 spawns operator terminals.
    pub(super) fn operator(marker: &str) -> Self {
        Self::with_grammar(marker, Grammar::Operator)
    }

    fn with_grammar(marker: &str, grammar: Grammar) -> Self {
        Self {
            grammar,
            operator: OperatorPhase::AwaitReady,
            prefix: b"\x1b]7717;wsmp-supervised;".to_vec(),
            marker: marker.as_bytes().to_vec(),
            pending: Vec::new(),
            ready_seen: false,
            done: false,
        }
    }

    pub(super) fn feed(&mut self, bytes: &[u8]) -> Vec<Piece> {
        if self.done {
            return if bytes.is_empty() {
                Vec::new()
            } else {
                vec![Piece::Bytes(bytes.to_vec())]
            };
        }
        let mut buffer = std::mem::take(&mut self.pending);
        buffer.extend_from_slice(bytes);
        let mut pieces = Vec::new();
        let mut start = 0;
        loop {
            let rest = &buffer[start..];
            if self.done {
                if !rest.is_empty() {
                    pieces.push(Piece::Bytes(rest.to_vec()));
                }
                return pieces;
            }
            let Some(at) = find_subslice(rest, &self.prefix) else {
                let keep = marker_prefix_suffix(rest, &self.prefix);
                let emit = rest.len() - keep;
                if emit > 0 {
                    pieces.push(Piece::Bytes(rest[..emit].to_vec()));
                }
                self.pending = rest[emit..].to_vec();
                return pieces;
            };
            if at > 0 {
                pieces.push(Piece::Bytes(rest[..at].to_vec()));
            }
            let marker_start = at + self.prefix.len();
            let Some(end) = rest[marker_start..].iter().position(|byte| *byte == 0x07) else {
                // Marker kinds are tiny. Do not let arbitrary PTY output hold
                // an unbounded buffer merely because it begins like an OSC.
                if rest.len().saturating_sub(at) > 256 {
                    pieces.push(Piece::Bytes(rest[at..at + 1].to_vec()));
                    start += at + 1;
                    continue;
                }
                self.pending = rest[at..].to_vec();
                return pieces;
            };
            let end = marker_start + end;
            // Output that began like a marker but never ended (a bare prefix,
            // no BEL) must not swallow a later real marker: anchor on the last
            // prefix before this BEL and pass everything before it through.
            if let Some(last) = rest[at + 1..end]
                .windows(self.prefix.len())
                .rposition(|window| window == self.prefix.as_slice())
            {
                let anchor = at + 1 + last;
                pieces.push(Piece::Bytes(rest[at..anchor].to_vec()));
                start += anchor;
                continue;
            }
            let payload = &rest[marker_start..end];
            let Some(separator) = payload.iter().rposition(|byte| *byte == b';') else {
                pieces.push(Piece::Bytes(rest[at..=end].to_vec()));
                start += end + 1;
                continue;
            };
            if payload[separator + 1..] != self.marker {
                // A marker for another request is ordinary display output.
                pieces.push(Piece::Bytes(rest[at..=end].to_vec()));
                start += end + 1;
                continue;
            }
            let kind = std::str::from_utf8(&payload[..separator]).ok();
            let event = match kind {
                Some("ready") => MarkerEvent::Ready,
                Some("accepted") => MarkerEvent::Accepted,
                Some(value) if value.starts_with("blocked;") => {
                    // `uncertain_outcome` is an apply-time verdict only the daemon
                    // produces after acceptance; the confirm child never has it.
                    // `unsafe_filesystem` may be a preview-time capability refusal,
                    // so its blocked verdict is allowed after the dismiss key.
                    FileErrorCode::from_wire_code(&value["blocked;".len()..])
                        .filter(|code| !matches!(code, FileErrorCode::UncertainOutcome))
                        .map(MarkerEvent::Blocked)
                        .unwrap_or(MarkerEvent::Invalid)
                }
                Some(value) if value.starts_with("exited;") => exit_code(&value["exited;".len()..])
                    .map(MarkerEvent::Exited)
                    .unwrap_or(MarkerEvent::Invalid),
                _ => MarkerEvent::Invalid,
            };
            if self.grammar == Grammar::Operator {
                let event = self.operator_event(event);
                pieces.push(Piece::Event(event));
                start += end + 1;
                continue;
            }
            match event {
                MarkerEvent::Ready if !self.ready_seen => {
                    self.ready_seen = true;
                    pieces.push(Piece::Event(MarkerEvent::Ready));
                }
                MarkerEvent::Accepted if self.ready_seen => {
                    self.done = true;
                    pieces.push(Piece::Event(MarkerEvent::Accepted));
                }
                MarkerEvent::Blocked(code) if self.ready_seen => {
                    self.done = true;
                    pieces.push(Piece::Event(MarkerEvent::Blocked(code)));
                }
                // `exited` belongs to the operator grammar only.
                MarkerEvent::Invalid | MarkerEvent::Exited(_) => {
                    self.done = true;
                    pieces.push(Piece::Event(MarkerEvent::Invalid));
                }
                // A repeated `ready`, or `accepted` before `ready`: stripped, ignored.
                _ => {}
            }
            start += end + 1;
        }
    }
}

impl MarkerScanner {
    /// One authenticated operator-child event, checked against the cycle.
    /// Returns the event to report; anything out of order is `Invalid` and
    /// ends the scan, so later output passes through untouched.
    fn operator_event(&mut self, event: MarkerEvent) -> MarkerEvent {
        let next = match (self.operator, event) {
            (OperatorPhase::AwaitReady, MarkerEvent::Ready) => Some(OperatorPhase::AwaitDecision),
            (OperatorPhase::AwaitDecision, MarkerEvent::Accepted) => Some(OperatorPhase::Running),
            (OperatorPhase::Running, MarkerEvent::Exited(0)) => {
                self.done = true;
                return event;
            }
            (OperatorPhase::Running, MarkerEvent::Exited(_)) => Some(OperatorPhase::AwaitReady),
            _ => None,
        };
        match next {
            Some(phase) => {
                self.operator = phase;
                event
            }
            None => {
                self.done = true;
                MarkerEvent::Invalid
            }
        }
    }
}

/// What a supervised terminal tracks about its confirm child and PTY.
pub(super) struct ChildLink {
    pub(super) scanner: MarkerScanner,
    /// The `go` token that lets the confirm child exec the command.
    pub(super) go: Vec<u8>,
    /// The PTY reported EOF, so every byte the command wrote has arrived.
    pub(super) eof: bool,
}

impl ChildLink {
    pub(super) fn new(marker: &str) -> Self {
        Self {
            scanner: MarkerScanner::new(marker),
            go: supervised_marker("go", marker),
            eof: false,
        }
    }
}

/// Only the PTY reader feeds a capture.
impl Capture {
    pub(super) fn push(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let room = terminal_crypto::CAPTURE_HEAD_MAX.saturating_sub(self.head.len());
        self.head.extend_from_slice(&bytes[..room.min(bytes.len())]);
        self.tail.extend(bytes);
        // Never start the tail inside an escape sequence or control string:
        // the reviewer and the model would see its hidden body as text.
        crate::terminal_parse::trim_rolling_tail(
            &mut self.tail,
            terminal_crypto::CAPTURE_TAIL_MAX,
            &mut self.tail_state,
        );
        self.total = self.total.saturating_add(bytes.len() as u64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_scanner_honors_ready_then_accepted_across_split_reads() {
        let marker = "00112233445566778899aabbccddeeff";
        let ready = supervised_marker("ready", marker);
        let accepted = supervised_marker("accepted", marker);
        let mut scanner = MarkerScanner::new(marker);
        let mut stream = b"screen".to_vec();
        // `accepted` before `ready` is stripped and ignored.
        stream.extend(&accepted);
        stream.extend(&ready);
        stream.extend(b"wait");
        stream.extend(&ready);
        stream.extend(&accepted);
        stream.extend(b"out");
        stream.extend(&ready);
        let mut pieces = Vec::new();
        for chunk in stream.chunks(3) {
            pieces.extend(scanner.feed(chunk));
        }
        let mut events = Vec::new();
        let mut before = Vec::new();
        let mut after = Vec::new();
        for piece in pieces {
            match piece {
                Piece::Event(event) => events.push(event),
                Piece::Bytes(bytes) if events.contains(&MarkerEvent::Accepted) => {
                    after.extend(bytes)
                }
                Piece::Bytes(bytes) => before.extend(bytes),
            }
        }
        assert_eq!(events, vec![MarkerEvent::Ready, MarkerEvent::Accepted]);
        assert_eq!(before, b"screenwait");
        let mut expected_after = b"out".to_vec();
        expected_after.extend(&ready);
        assert_eq!(after, expected_after);
        // Another marker's bytes do not count.
        let mut other = MarkerScanner::new("ffffffffffffffffffffffffffffffff");
        assert_eq!(other.feed(&ready), vec![Piece::Bytes(ready.clone())]);
    }

    #[test]
    fn marker_scanner_accepts_one_valid_blocked_code_and_rejects_arbitrary_kinds() {
        let marker = "00112233445566778899aabbccddeeff";
        // A preview-time capability refusal is valid after screen dismissal.
        for code in [FileErrorCode::Conflict, FileErrorCode::UnsafeFilesystem] {
            let mut blocked = MarkerScanner::new(marker);
            let mut stream = supervised_marker("ready", marker);
            stream.extend(supervised_marker(
                &format!("blocked;{}", code.as_str()),
                marker,
            ));
            let pieces = blocked.feed(&stream);
            assert!(pieces.contains(&Piece::Event(MarkerEvent::Ready)));
            assert!(pieces.contains(&Piece::Event(MarkerEvent::Blocked(code))));
        }

        // An apply-time verdict the confirm child never produces is malformed there.
        for kind in [
            "blocked;made_up",
            "blocked;conflict;extra",
            "blocked;uncertain_outcome",
            "surprise",
        ] {
            let mut scanner = MarkerScanner::new(marker);
            let mut stream = supervised_marker("ready", marker);
            stream.extend(supervised_marker(kind, marker));
            let pieces = scanner.feed(&stream);
            assert!(
                pieces.contains(&Piece::Event(MarkerEvent::Invalid)),
                "{kind}"
            );
            assert!(pieces.iter().all(|piece| !matches!(piece, Piece::Bytes(bytes) if
                bytes.windows(b"wsmp-supervised".len()).any(|window| window == b"wsmp-supervised"))));
        }
    }

    fn events_and_bytes(scanner: &mut MarkerScanner, stream: &[u8]) -> (Vec<MarkerEvent>, Vec<u8>) {
        let mut events = Vec::new();
        let mut bytes = Vec::new();
        // Split reads: every marker crosses a read boundary somewhere.
        for chunk in stream.chunks(5) {
            for piece in scanner.feed(chunk) {
                match piece {
                    Piece::Event(event) => events.push(event),
                    Piece::Bytes(chunk) => bytes.extend(chunk),
                }
            }
        }
        (events, bytes)
    }

    #[test]
    fn operator_scanner_follows_ready_accepted_exited_with_retries() {
        let marker = "00112233445566778899aabbccddeeff";
        let m = |kind: &str| supervised_marker(kind, marker);
        let mut stream = b"screen".to_vec();
        stream.extend(m("ready"));
        stream.extend(m("accepted"));
        stream.extend(b"sudo: password");
        stream.extend(m("exited;1"));
        stream.extend(b"retry screen");
        stream.extend(m("ready"));
        stream.extend(m("accepted"));
        stream.extend(b"ok");
        stream.extend(m("exited;0"));
        stream.extend(b"done");
        // After the end every byte passes through, a late marker included.
        stream.extend(m("ready"));
        let mut scanner = MarkerScanner::operator(marker);
        let (events, bytes) = events_and_bytes(&mut scanner, &stream);
        assert_eq!(
            events,
            vec![
                MarkerEvent::Ready,
                MarkerEvent::Accepted,
                MarkerEvent::Exited(1),
                MarkerEvent::Ready,
                MarkerEvent::Accepted,
                MarkerEvent::Exited(0),
            ]
        );
        let mut expected = b"screensudo: passwordretry screenokdone".to_vec();
        expected.extend(m("ready"));
        assert_eq!(bytes, expected);
    }

    #[test]
    fn operator_scanner_refuses_out_of_order_and_malformed_events() {
        let marker = "00112233445566778899aabbccddeeff";
        let m = |kind: &str| supervised_marker(kind, marker);
        for (kinds, expected) in [
            // `accepted` or `exited` before the screen is drawn.
            (vec!["accepted"], vec![MarkerEvent::Invalid]),
            (vec!["exited;0"], vec![MarkerEvent::Invalid]),
            // A second `ready` while the screen waits.
            (
                vec!["ready", "ready"],
                vec![MarkerEvent::Ready, MarkerEvent::Invalid],
            ),
            // `exited` while nothing runs.
            (
                vec!["ready", "exited;0"],
                vec![MarkerEvent::Ready, MarkerEvent::Invalid],
            ),
            // A second `accepted` while the command runs.
            (
                vec!["ready", "accepted", "accepted"],
                vec![
                    MarkerEvent::Ready,
                    MarkerEvent::Accepted,
                    MarkerEvent::Invalid,
                ],
            ),
            // A retry must redraw (`ready`) before it is accepted.
            (
                vec!["ready", "accepted", "exited;2", "accepted"],
                vec![
                    MarkerEvent::Ready,
                    MarkerEvent::Accepted,
                    MarkerEvent::Exited(2),
                    MarkerEvent::Invalid,
                ],
            ),
            // File verdicts are not part of this grammar.
            (
                vec!["ready", "blocked;conflict"],
                vec![MarkerEvent::Ready, MarkerEvent::Invalid],
            ),
        ] {
            let mut stream = Vec::new();
            for kind in &kinds {
                stream.extend(m(kind));
            }
            let mut scanner = MarkerScanner::operator(marker);
            let (events, _) = events_and_bytes(&mut scanner, &stream);
            assert_eq!(events, expected, "{kinds:?}");
        }
        for code in ["", "256", "-1", "+1", "01", "00", "1a", "1;2", "1000", " 1"] {
            let mut stream = m("ready");
            stream.extend(m("accepted"));
            stream.extend(m(&format!("exited;{code}")));
            let mut scanner = MarkerScanner::operator(marker);
            let (events, bytes) = events_and_bytes(&mut scanner, &stream);
            assert_eq!(events.last(), Some(&MarkerEvent::Invalid), "{code:?}");
            assert!(bytes.is_empty(), "{code:?}");
        }
        for (code, value) in [("0", 0), ("9", 9), ("127", 127), ("255", 255)] {
            assert_eq!(exit_code(code), Some(value));
        }
        // Another request's markers are ordinary output, even mid-run.
        let mut stream = m("ready");
        stream.extend(m("accepted"));
        let forged = supervised_marker("exited;0", "ffffffffffffffffffffffffffffffff");
        stream.extend(&forged);
        let mut scanner = MarkerScanner::operator(marker);
        let (events, bytes) = events_and_bytes(&mut scanner, &stream);
        assert_eq!(events, vec![MarkerEvent::Ready, MarkerEvent::Accepted]);
        assert_eq!(bytes, forged);
    }

    #[test]
    fn a_dangling_prefix_in_output_neither_hides_output_nor_the_real_marker() {
        let marker = "00112233445566778899aabbccddeeff";
        let m = |kind: &str| supervised_marker(kind, marker);
        let prefix = b"\x1b]7717;wsmp-supervised;".to_vec();
        let mut junk_300 = prefix.clone();
        junk_300.extend(vec![b'j'; 300]);
        let mut fake_exit = prefix.clone();
        fake_exit.extend(format!("exited;0;{marker}").as_bytes());
        for (junk, real, code) in [
            (prefix.clone(), "exited;0", 0),
            (fake_exit, "exited;1", 1),
            (junk_300, "exited;0", 0),
        ] {
            let mut stream = m("ready");
            stream.extend(m("accepted"));
            stream.extend(b"out:");
            stream.extend(&junk);
            stream.extend(m(real));
            for chunk_size in [1, 5, 4096] {
                let mut scanner = MarkerScanner::operator(marker);
                let mut events = Vec::new();
                let mut bytes = Vec::new();
                for chunk in stream.chunks(chunk_size) {
                    for piece in scanner.feed(chunk) {
                        match piece {
                            Piece::Event(event) => events.push(event),
                            Piece::Bytes(chunk) => bytes.extend(chunk),
                        }
                    }
                }
                assert_eq!(
                    events,
                    vec![
                        MarkerEvent::Ready,
                        MarkerEvent::Accepted,
                        MarkerEvent::Exited(code)
                    ],
                    "{real} after {chunk_size}-byte reads"
                );
                let mut expected = b"out:".to_vec();
                expected.extend(&junk);
                assert_eq!(bytes, expected, "{real} after {chunk_size}-byte reads");
            }
        }
        // The agent grammar re-anchors the same way.
        let mut stream = prefix;
        stream.extend(m("ready"));
        let mut scanner = MarkerScanner::new(marker);
        let (events, _) = events_and_bytes(&mut scanner, &stream);
        assert_eq!(events, vec![MarkerEvent::Ready]);
    }

    #[test]
    fn the_supervised_scanner_treats_exited_as_invalid() {
        let marker = "00112233445566778899aabbccddeeff";
        let mut stream = supervised_marker("ready", marker);
        stream.extend(supervised_marker("exited;0", marker));
        let mut scanner = MarkerScanner::new(marker);
        let (events, _) = events_and_bytes(&mut scanner, &stream);
        assert_eq!(events, vec![MarkerEvent::Ready, MarkerEvent::Invalid]);
    }

    #[test]
    fn capture_tail_starts_after_a_control_string_the_gap_cuts_into() {
        let mut stream = b"VISIBLE\n\x1bPq".to_vec();
        stream.extend(vec![b'x'; 60_000]);
        stream.extend(b"\nHIDDEN PAYLOAD\n\x1b\\ AFTER\n");
        let mut capture = Capture::default();
        for chunk in stream.chunks(4096) {
            capture.push(chunk);
        }
        let (head, tail) = capture.parts();
        assert_eq!(head, stream[..terminal_crypto::CAPTURE_HEAD_MAX]);
        assert_eq!(tail, b" AFTER\n");
        assert_eq!(capture.total, stream.len() as u64);
    }

    #[test]
    fn capture_keeps_the_head_and_a_rolling_tail_like_the_server() {
        let mut capture = Capture::default();
        capture.push(b"abc");
        assert_eq!(capture.parts(), (b"abc".to_vec(), Vec::new()));
        let mut capture = Capture::default();
        // Plain text: the tail starts exactly CAPTURE_TAIL_MAX bytes from the end.
        let stream = (0..60_000_u32)
            .map(|n| {
                if n % 80 == 79 {
                    b'\n'
                } else {
                    b'a' + (n % 26) as u8
                }
            })
            .collect::<Vec<_>>();
        for chunk in stream.chunks(1000) {
            capture.push(chunk);
        }
        let (head, tail) = capture.parts();
        assert_eq!(capture.total, 60_000);
        assert_eq!(head, stream[..terminal_crypto::CAPTURE_HEAD_MAX]);
        assert_eq!(
            tail,
            stream[stream.len() - terminal_crypto::CAPTURE_TAIL_MAX..]
        );
    }
}
