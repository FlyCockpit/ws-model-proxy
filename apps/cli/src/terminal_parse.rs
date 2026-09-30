//! Where a terminal escape-sequence parser stands after a stream of bytes.
//!
//! Mirrors `TerminalByteState` and `appendRollingTail` in
//! `packages/config/src/cli-command-output.ts` (the server's and browser's
//! output normalizer), checked against the shared
//! `terminal-tail-vectors.json` on both sides. A capture drops bytes from the
//! front of its rolling tail until the parser is in its ground state on a
//! whole character, so the tail, parsed on its own, keeps exactly what the
//! terminal prints from that point: a DCS, APC, PM or OSC body that the
//! head/tail gap cuts into is never shown as text.
//!
//! The states and transitions are the VT500 parser's (vt100.net
//! dec_ansi_parser) as xterm.js implements them, over code points from a
//! WHATWG UTF-8 decoder (U+FFFD for invalid input, as `TextDecoder` decodes).

const GROUND: u8 = 0;
const ESCAPE: u8 = 1;
const ESCAPE_INTERMEDIATE: u8 = 2;
const CSI_ENTRY: u8 = 3;
const CSI_PARAM: u8 = 4;
const CSI_INTERMEDIATE: u8 = 5;
const CSI_IGNORE: u8 = 6;
const OSC_STRING: u8 = 7;
/// SOS, PM and APC bodies.
const IGNORED_STRING: u8 = 8;
const DCS_ENTRY: u8 = 9;
const DCS_PARAM: u8 = 10;
const DCS_INTERMEDIATE: u8 = 11;
const DCS_IGNORE: u8 = 12;
const DCS_PASSTHROUGH: u8 = 13;

/// The state after an ESC, CAN, SUB or C1 control, which act the same in
/// every state; `None` for any other code point.
fn anywhere_transition(code: u32) -> Option<u8> {
    match code {
        0x1b => Some(ESCAPE),
        0x18 | 0x1a => Some(GROUND),
        0x90 => Some(DCS_ENTRY),
        0x9b => Some(CSI_ENTRY),
        0x9d => Some(OSC_STRING),
        0x98 | 0x9e | 0x9f => Some(IGNORED_STRING),
        // ST and every other C1 control end any sequence.
        0x80..=0x9f => Some(GROUND),
        _ => None,
    }
}

/// C0 controls the parser executes (or, inside strings, ignores) in place.
fn is_executable(code: u32) -> bool {
    code <= 0x17 || code == 0x19 || (0x1c..=0x1f).contains(&code)
}

/// The state after a printable byte (0x20-0x7e) outside GROUND.
fn printable_transition(state: u8, code: u32) -> u8 {
    match state {
        ESCAPE => match code {
            0x20..=0x2f => ESCAPE_INTERMEDIATE,
            0x5b => CSI_ENTRY,
            0x5d => OSC_STRING,
            0x50 => DCS_ENTRY,
            0x58 | 0x5e | 0x5f => IGNORED_STRING,
            _ => GROUND,
        },
        ESCAPE_INTERMEDIATE => {
            if code <= 0x2f {
                ESCAPE_INTERMEDIATE
            } else {
                GROUND
            }
        }
        CSI_ENTRY | CSI_PARAM => match code {
            0x40.. => GROUND,
            ..=0x2f => CSI_INTERMEDIATE,
            0x3c..=0x3f if state == CSI_ENTRY => CSI_PARAM,
            0x3c..=0x3f => CSI_IGNORE,
            _ => CSI_PARAM,
        },
        CSI_INTERMEDIATE => match code {
            0x40.. => GROUND,
            ..=0x2f => CSI_INTERMEDIATE,
            _ => CSI_IGNORE,
        },
        CSI_IGNORE => {
            if code >= 0x40 {
                GROUND
            } else {
                CSI_IGNORE
            }
        }
        DCS_ENTRY | DCS_PARAM => match code {
            0x40.. => DCS_PASSTHROUGH,
            ..=0x2f => DCS_INTERMEDIATE,
            0x3c..=0x3f if state == DCS_ENTRY => DCS_PARAM,
            0x3c..=0x3f => DCS_IGNORE,
            _ => DCS_PARAM,
        },
        DCS_INTERMEDIATE => match code {
            0x40.. => DCS_PASSTHROUGH,
            ..=0x2f => DCS_INTERMEDIATE,
            _ => DCS_IGNORE,
        },
        // OSC, SOS/PM/APC, DCS ignore and passthrough bodies run to their end.
        _ => state,
    }
}

/// The state after a non-ASCII printable (U+00A0 and above) outside GROUND.
fn non_ascii_transition(state: u8) -> u8 {
    match state {
        DCS_ENTRY | DCS_PARAM | DCS_INTERMEDIATE => DCS_IGNORE,
        CSI_IGNORE | OSC_STRING | IGNORED_STRING | DCS_IGNORE | DCS_PASSTHROUGH => state,
        _ => GROUND,
    }
}

fn next_state(state: u8, code: u32) -> u8 {
    if let Some(next) = anywhere_transition(code) {
        return next;
    }
    if is_executable(code) {
        return if state == OSC_STRING && code == 0x07 {
            GROUND
        } else {
            state
        };
    }
    // DEL is ignored in every state.
    if code == 0x7f || state == GROUND {
        return state;
    }
    if code >= 0xa0 {
        non_ascii_transition(state)
    } else {
        printable_transition(state, code)
    }
}

/// The parser across a byte stream, one byte at a time.
#[derive(Debug, Clone, Copy)]
pub struct TerminalByteState {
    state: u8,
    decoded_any: bool,
    needed: u8,
    seen: u8,
    code_point: u32,
    lower: u8,
    upper: u8,
}

impl Default for TerminalByteState {
    fn default() -> Self {
        Self {
            state: GROUND,
            decoded_any: false,
            needed: 0,
            seen: 0,
            code_point: 0,
            lower: 0x80,
            upper: 0xbf,
        }
    }
}

impl TerminalByteState {
    /// True in the ground state with no partial character pending.
    pub fn at_boundary(&self) -> bool {
        self.state == GROUND && self.needed == 0
    }

    /// Feeds one byte (WHATWG UTF-8 decoding, U+FFFD for invalid input).
    pub fn feed(&mut self, byte: u8) {
        self.decode(byte, &mut |_| {});
    }

    /// Appends exactly the text retained by the server's terminal/control filter.
    /// State, including partial UTF-8, survives both pieces and physical LFs.
    pub fn feed_clean(&mut self, byte: u8, out: &mut String) {
        self.decode(byte, &mut |ch| out.push(ch));
    }

    /// WHATWG decoding emits a replacement for an incomplete final character.
    pub fn finish_clean(&mut self, out: &mut String) {
        if self.needed != 0 {
            self.reset();
            self.code(0xfffd, &mut |ch| out.push(ch));
        }
    }

    fn code(&mut self, code: u32, emit: &mut impl FnMut(char)) {
        // TextDecoder removes a BOM only at the start of its UTF-8 stream.
        // A leading BOM must not hide a column-0 secret flag from the scanner.
        let first = !self.decoded_any;
        self.decoded_any = true;
        if first && code == 0xfeff {
            return;
        }
        let printable = (0x20..=0x7e).contains(&code) || code >= 0xa0;
        if ((self.state == GROUND && printable)
            || (self.state <= CSI_IGNORE && matches!(code, 0x09 | 0x0a | 0x0d)))
            && let Some(ch) = char::from_u32(code)
        {
            emit(ch);
        }
        self.state = next_state(self.state, code);
    }

    fn decode(&mut self, byte: u8, emit: &mut impl FnMut(char)) {
        if self.needed == 0 {
            match byte {
                0x00..=0x7f => self.code(u32::from(byte), emit),
                0xc2..=0xdf => self.start(1, byte & 0x1f),
                0xe0..=0xef => {
                    if byte == 0xe0 {
                        self.lower = 0xa0;
                    }
                    if byte == 0xed {
                        self.upper = 0x9f;
                    }
                    self.start(2, byte & 0x0f);
                }
                0xf0..=0xf4 => {
                    if byte == 0xf0 {
                        self.lower = 0x90;
                    }
                    if byte == 0xf4 {
                        self.upper = 0x8f;
                    }
                    self.start(3, byte & 0x07);
                }
                _ => self.code(0xfffd, emit),
            }
            return;
        }
        if byte < self.lower || byte > self.upper {
            self.reset();
            self.code(0xfffd, emit);
            self.decode(byte, emit);
            return;
        }
        self.lower = 0x80;
        self.upper = 0xbf;
        self.code_point = (self.code_point << 6) | u32::from(byte & 0x3f);
        self.seen += 1;
        if self.seen == self.needed {
            let code_point = self.code_point;
            self.reset();
            self.code(code_point, emit);
        }
    }

    fn start(&mut self, needed: u8, bits: u8) {
        self.needed = needed;
        self.code_point = u32::from(bits);
    }

    fn reset(&mut self) {
        self.needed = 0;
        self.seen = 0;
        self.code_point = 0;
        self.lower = 0x80;
        self.upper = 0xbf;
    }
}

/// Drops bytes from the front of `tail` until it holds at most `max` bytes
/// AND `state` is at a boundary, feeding each dropped byte to `state`.
pub fn trim_rolling_tail(
    tail: &mut std::collections::VecDeque<u8>,
    max: usize,
    state: &mut TerminalByteState,
) {
    while let Some(&byte) = tail.front() {
        if tail.len() <= max && state.at_boundary() {
            break;
        }
        state.feed(byte);
        tail.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[derive(serde::Deserialize)]
    struct Shared {
        vectors: Vec<Vector>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        stream_hex: String,
        chunk: usize,
        max: usize,
        tail_hex: String,
    }

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex byte"))
            .collect()
    }

    fn rolling_tail(stream: &[u8], chunk: usize, max: usize) -> Vec<u8> {
        let mut state = TerminalByteState::default();
        let mut tail = VecDeque::new();
        for piece in stream.chunks(chunk.max(1)) {
            tail.extend(piece);
            trim_rolling_tail(&mut tail, max, &mut state);
        }
        tail.into_iter().collect()
    }

    #[test]
    fn matches_every_shared_vector() {
        let shared: Shared = serde_json::from_str(include_str!(
            "../../../packages/config/src/terminal-tail-vectors.json"
        ))
        .expect("shared terminal tail vectors");
        assert!(shared.vectors.len() > 20);
        for vector in shared.vectors {
            assert_eq!(
                rolling_tail(&hex(&vector.stream_hex), vector.chunk, vector.max),
                hex(&vector.tail_hex),
                "stream {} chunk {} max {}",
                vector.stream_hex,
                vector.chunk,
                vector.max
            );
        }
    }

    #[test]
    fn keeps_exactly_the_last_bytes_of_plain_output() {
        let stream = b"plain line\n".repeat(100);
        assert_eq!(rolling_tail(&stream, 7, 64), stream[stream.len() - 64..]);
    }

    #[test]
    fn starts_the_tail_after_a_control_string_the_cut_falls_inside() {
        let mut stream = b"VISIBLE\n\x1b_".to_vec();
        stream.extend(vec![b'x'; 500]);
        stream.extend(b"\nHIDDEN\n\x1b\\ AFTER\n");
        assert_eq!(rolling_tail(&stream, 13, 64), b" AFTER\n");
    }

    #[test]
    fn never_starts_the_tail_inside_a_utf8_encoded_c1_introducer() {
        // U+009F (APC) is C2 9F: a tail starting at 9F would show the body.
        let mut stream = b"abc\xc2\x9fHIDDEN".to_vec();
        stream.extend(b"\xc2\x9c AFTER");
        // Fifteen bytes would cut between C2 and 9F.
        assert_eq!(rolling_tail(&stream, 1, 15), b" AFTER");
    }
}
