//! The Unix side of a supervised (agent-requested) terminal: the env the
//! daemon hands the confirm child, the in-band markers between them, and the
//! per-terminal state that follows the child's PTY. Supervised terminals need
//! a Unix PTY: elsewhere the hello reports `terminalSupported: false` and
//! `spawn_supervised` refuses with `unsupported`, so none of this is built.

use super::{Capture, terminal_crypto};

/// Env names the daemon sets for `wsmp terminal supervised-run`. The child
/// removes them before it execs the command.
pub(crate) const SUPERVISED_ENV_COMMAND: &str = "WSMP_SUPERVISED_COMMAND";
pub(crate) const SUPERVISED_ENV_REASON: &str = "WSMP_SUPERVISED_REASON";
pub(crate) const SUPERVISED_ENV_REQUESTER: &str = "WSMP_SUPERVISED_REQUESTER";
pub(crate) const SUPERVISED_ENV_SHARE: &str = "WSMP_SUPERVISED_SHARE";
pub(crate) const SUPERVISED_ENV_MARKER: &str = "WSMP_SUPERVISED_MARKER";
pub(crate) const SUPERVISED_ENV_NAMES: [&str; 5] = [
    SUPERVISED_ENV_COMMAND,
    SUPERVISED_ENV_REASON,
    SUPERVISED_ENV_REQUESTER,
    SUPERVISED_ENV_SHARE,
    SUPERVISED_ENV_MARKER,
];

/// The in-band signal between the confirm child and the daemon: an OSC
/// sequence carrying a per-spawn random marker that only the two of them
/// know. On the PTY output, `kind` is `ready` (screen drawn, stdin flushed)
/// or `accepted` (Enter pressed; the child waits). On the PTY input, `go` is
/// the daemon's decision that the command may start: it is written only when
/// the daemon takes `accepted` while the request is still waiting, so a
/// server expiry or cancel handled first means the command never starts.
pub(crate) fn supervised_marker(kind: &str, marker: &str) -> Vec<u8> {
    format!("\x1b]7717;wsmp-supervised;{kind};{marker}\x07").into_bytes()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MarkerEvent {
    Ready,
    Accepted,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Piece {
    Bytes(Vec<u8>),
    Event(MarkerEvent),
}

/// Finds the confirm child's markers in PTY output, including markers split
/// across reads, and removes them from what viewers see. Only `ready` and
/// then `accepted` are honored, each once; afterwards the output passes
/// through untouched, so a command printing a marker changes nothing.
pub(super) struct MarkerScanner {
    ready: Vec<u8>,
    accepted: Vec<u8>,
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
        Self {
            ready: supervised_marker("ready", marker),
            accepted: supervised_marker("accepted", marker),
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
            let ready = find_subslice(rest, &self.ready).map(|at| (at, MarkerEvent::Ready));
            let accepted =
                find_subslice(rest, &self.accepted).map(|at| (at, MarkerEvent::Accepted));
            let next = match (ready, accepted) {
                (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
                (left, right) => left.or(right),
            };
            let Some((at, event)) = next else {
                let keep = marker_prefix_suffix(rest, &self.ready)
                    .max(marker_prefix_suffix(rest, &self.accepted));
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
            let length = match event {
                MarkerEvent::Ready => self.ready.len(),
                MarkerEvent::Accepted => self.accepted.len(),
            };
            match event {
                MarkerEvent::Ready if !self.ready_seen => {
                    self.ready_seen = true;
                    pieces.push(Piece::Event(MarkerEvent::Ready));
                }
                MarkerEvent::Accepted if self.ready_seen => {
                    self.done = true;
                    pieces.push(Piece::Event(MarkerEvent::Accepted));
                }
                // A repeated `ready`, or `accepted` before `ready`: stripped, ignored.
                _ => {}
            }
            start += at + length;
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
        let overflow = self
            .tail
            .len()
            .saturating_sub(terminal_crypto::CAPTURE_TAIL_MAX);
        if overflow > 0 {
            self.tail.drain(..overflow);
        }
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
    fn capture_keeps_the_head_and_a_rolling_tail_like_the_server() {
        let mut capture = Capture::default();
        capture.push(b"abc");
        assert_eq!(capture.parts(), (b"abc".to_vec(), Vec::new()));
        let mut capture = Capture::default();
        let stream = (0..60_000_u32).map(|n| (n % 251) as u8).collect::<Vec<_>>();
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
