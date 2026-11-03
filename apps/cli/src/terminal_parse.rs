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

/// The VT500 parser's states (the subset that decides what is printed).
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VtState {
    Ground,
    Escape,
    EscapeIntermediate,
    CsiEntry,
    CsiParam,
    CsiIntermediate,
    CsiIgnore,
    OscString,
    /// SOS, PM and APC bodies.
    IgnoredString,
    DcsEntry,
    DcsParam,
    DcsIntermediate,
    DcsIgnore,
    DcsPassthrough,
}

impl VtState {
    /// Whether HT, LF and CR are printed here: in ground and inside an escape
    /// or CSI sequence, but never inside a string body (OSC, SOS/PM/APC, DCS).
    fn prints_line_controls(self) -> bool {
        matches!(
            self,
            Self::Ground
                | Self::Escape
                | Self::EscapeIntermediate
                | Self::CsiEntry
                | Self::CsiParam
                | Self::CsiIntermediate
                | Self::CsiIgnore
        )
    }
}

/// The state after an ESC, CAN, SUB or C1 control, which act the same in
/// every state; `None` for any other code point.
fn anywhere_transition(code: u32) -> Option<VtState> {
    use VtState::*;
    match code {
        0x1b => Some(Escape),
        0x18 | 0x1a => Some(Ground),
        0x90 => Some(DcsEntry),
        0x9b => Some(CsiEntry),
        0x9d => Some(OscString),
        0x98 | 0x9e | 0x9f => Some(IgnoredString),
        // ST and every other C1 control end any sequence.
        0x80..=0x9f => Some(Ground),
        _ => None,
    }
}

/// C0 controls the parser executes (or, inside strings, ignores) in place.
fn is_executable(code: u32) -> bool {
    code <= 0x17 || code == 0x19 || (0x1c..=0x1f).contains(&code)
}

/// The state after a printable byte (0x20-0x7e) outside GROUND.
fn printable_transition(state: VtState, code: u32) -> VtState {
    use VtState::*;
    match state {
        Escape => match code {
            0x20..=0x2f => EscapeIntermediate,
            0x5b => CsiEntry,
            0x5d => OscString,
            0x50 => DcsEntry,
            0x58 | 0x5e | 0x5f => IgnoredString,
            _ => Ground,
        },
        EscapeIntermediate => {
            if code <= 0x2f {
                EscapeIntermediate
            } else {
                Ground
            }
        }
        CsiEntry | CsiParam => match code {
            0x40.. => Ground,
            ..=0x2f => CsiIntermediate,
            0x3c..=0x3f if state == CsiEntry => CsiParam,
            0x3c..=0x3f => CsiIgnore,
            _ => CsiParam,
        },
        CsiIntermediate => match code {
            0x40.. => Ground,
            ..=0x2f => CsiIntermediate,
            _ => CsiIgnore,
        },
        CsiIgnore => {
            if code >= 0x40 {
                Ground
            } else {
                CsiIgnore
            }
        }
        DcsEntry | DcsParam => match code {
            0x40.. => DcsPassthrough,
            ..=0x2f => DcsIntermediate,
            0x3c..=0x3f if state == DcsEntry => DcsParam,
            0x3c..=0x3f => DcsIgnore,
            _ => DcsParam,
        },
        DcsIntermediate => match code {
            0x40.. => DcsPassthrough,
            ..=0x2f => DcsIntermediate,
            _ => DcsIgnore,
        },
        // OSC, SOS/PM/APC, DCS ignore and passthrough bodies run to their end.
        Ground | OscString | IgnoredString | DcsIgnore | DcsPassthrough => state,
    }
}

/// The state after a non-ASCII printable (U+00A0 and above) outside GROUND.
fn non_ascii_transition(state: VtState) -> VtState {
    use VtState::*;
    match state {
        DcsEntry | DcsParam | DcsIntermediate => DcsIgnore,
        CsiIgnore | OscString | IgnoredString | DcsIgnore | DcsPassthrough => state,
        Ground | Escape | EscapeIntermediate | CsiEntry | CsiParam | CsiIntermediate => Ground,
    }
}

fn next_state(state: VtState, code: u32) -> VtState {
    if let Some(next) = anywhere_transition(code) {
        return next;
    }
    if is_executable(code) {
        return if state == VtState::OscString && code == 0x07 {
            VtState::Ground
        } else {
            state
        };
    }
    // DEL is ignored in every state.
    if code == 0x7f || state == VtState::Ground {
        return state;
    }
    if code >= 0xa0 {
        non_ascii_transition(state)
    } else {
        printable_transition(state, code)
    }
}

/// The WHATWG UTF-8 decoder between code points.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Utf8 {
    /// On a character boundary.
    Idle,
    /// Inside a multi-byte character: `remaining` continuation bytes to come,
    /// the next of which must lie in `lower..=upper`.
    Partial {
        remaining: u8,
        code_point: u32,
        lower: u8,
        upper: u8,
    },
}

impl Utf8 {
    /// After a lead byte announcing `remaining` continuation bytes.
    fn lead(remaining: u8, bits: u8, lower: u8, upper: u8) -> Self {
        Self::Partial {
            remaining,
            code_point: u32::from(bits),
            lower,
            upper,
        }
    }
}

/// The parser across a byte stream, one byte at a time.
#[derive(Debug, Clone, Copy)]
pub struct TerminalByteState {
    state: VtState,
    decoded_any: bool,
    utf8: Utf8,
}

impl Default for TerminalByteState {
    fn default() -> Self {
        Self {
            state: VtState::Ground,
            decoded_any: false,
            utf8: Utf8::Idle,
        }
    }
}

impl TerminalByteState {
    /// True in the ground state with no partial character pending.
    pub fn at_boundary(&self) -> bool {
        self.state == VtState::Ground && self.utf8 == Utf8::Idle
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
        if self.utf8 != Utf8::Idle {
            self.utf8 = Utf8::Idle;
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
        if ((self.state == VtState::Ground && printable)
            || (self.state.prints_line_controls() && matches!(code, 0x09 | 0x0a | 0x0d)))
            && let Some(ch) = char::from_u32(code)
        {
            emit(ch);
        }
        self.state = next_state(self.state, code);
    }

    fn decode(&mut self, byte: u8, emit: &mut impl FnMut(char)) {
        match self.utf8 {
            Utf8::Idle => match byte {
                0x00..=0x7f => self.code(u32::from(byte), emit),
                0xc2..=0xdf => self.utf8 = Utf8::lead(1, byte & 0x1f, 0x80, 0xbf),
                0xe0..=0xef => {
                    let lower = if byte == 0xe0 { 0xa0 } else { 0x80 };
                    let upper = if byte == 0xed { 0x9f } else { 0xbf };
                    self.utf8 = Utf8::lead(2, byte & 0x0f, lower, upper);
                }
                0xf0..=0xf4 => {
                    let lower = if byte == 0xf0 { 0x90 } else { 0x80 };
                    let upper = if byte == 0xf4 { 0x8f } else { 0xbf };
                    self.utf8 = Utf8::lead(3, byte & 0x07, lower, upper);
                }
                _ => self.code(0xfffd, emit),
            },
            Utf8::Partial {
                remaining,
                code_point,
                lower,
                upper,
            } => {
                if !(lower..=upper).contains(&byte) {
                    // The character is cut short: a replacement, then the byte
                    // starts afresh (once: the decoder is idle now).
                    self.utf8 = Utf8::Idle;
                    self.code(0xfffd, emit);
                    self.decode(byte, emit);
                    return;
                }
                let code_point = (code_point << 6) | u32::from(byte & 0x3f);
                if remaining == 1 {
                    self.utf8 = Utf8::Idle;
                    self.code(code_point, emit);
                } else {
                    self.utf8 = Utf8::Partial {
                        remaining: remaining - 1,
                        code_point,
                        lower: 0x80,
                        upper: 0xbf,
                    };
                }
            }
        }
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
    fn line_controls_print_outside_string_bodies_only() {
        use VtState::*;
        for state in [
            Ground,
            Escape,
            EscapeIntermediate,
            CsiEntry,
            CsiParam,
            CsiIntermediate,
            CsiIgnore,
        ] {
            assert!(state.prints_line_controls(), "{state:?}");
        }
        for state in [
            OscString,
            IgnoredString,
            DcsEntry,
            DcsParam,
            DcsIntermediate,
            DcsIgnore,
            DcsPassthrough,
        ] {
            assert!(!state.prints_line_controls(), "{state:?}");
        }
        let clean = |bytes: &[u8]| {
            let mut state = TerminalByteState::default();
            let mut out = String::new();
            for &byte in bytes {
                state.feed_clean(byte, &mut out);
            }
            state.finish_clean(&mut out);
            out
        };
        assert_eq!(clean(b"a\x1b[\nb"), "a\n");
        assert_eq!(clean(b"a\x1b]0;\ntitle\x07b"), "ab");
    }

    #[test]
    fn a_cut_character_is_one_replacement_and_the_byte_starts_afresh() {
        let mut state = TerminalByteState::default();
        let mut out = String::new();
        // E2 82 then `A`: U+FFFD for the cut character, then `A` itself.
        for &byte in b"\xe2\x82A" {
            state.feed_clean(byte, &mut out);
        }
        assert_eq!(out, "\u{fffd}A");
        assert!(state.at_boundary());
        // A partial character is no boundary; finishing replaces it.
        state.feed_clean(0xf0, &mut out);
        state.feed_clean(0x9f, &mut out);
        assert!(!state.at_boundary());
        state.finish_clean(&mut out);
        assert_eq!(out, "\u{fffd}A\u{fffd}");
        assert!(state.at_boundary());
        // E0 needs A0..=BF next: 80 is not a continuation of it.
        let mut out = String::new();
        let mut state = TerminalByteState::default();
        for &byte in b"\xe0\x80" {
            state.feed_clean(byte, &mut out);
        }
        assert_eq!(out, "\u{fffd}\u{fffd}");
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
