//! The stateful, restartable line masker ([`LineMasker`]) that folds the
//! recognizers over lines in file order, and [`SameLineCarry`], its bounded
//! carry for an overlong line fed in pieces.

use std::ops::Range;

use super::class::FileClass;
use super::recognize::{
    Construct, DOTENV_ASSIGN, FLAG_AT_END, LineMask, construct_for_tail, continuation_value,
    first_flag, first_secret_name, indent_kinds, indent_of, merge, mixed_indent, pem_events,
    quote_left_open, tail_mask,
};
use super::{LOOKBACK_BYTES, MASK_CLOSE, MASK_OPEN, token, token_bare};

/// Bounded carry for one overlong terminal-cleaned line. Piece boundaries are
/// never interpreted as line boundaries. Only exact private-key labels are
/// carried; the general recovery run is opened by [`Self::recover`] and kept
/// across blank lines by `StreamMasker` ([`LineMasker::guard_next_line`]).
#[derive(Default)]
pub(crate) struct SameLineCarry {
    pem_tail: String,
    pem_open: std::collections::BTreeMap<String, usize>,
    state_cost: usize,
    live_input: usize,
    unrepresentable: bool,
}

impl SameLineCarry {
    // Labels have no bound in files. Streaming output fails closed when a
    // marker cannot fit this bounded overlap, rather than dropping its opener.
    pub(crate) const OVERLAP: usize = 1024;

    pub(crate) fn feed(&mut self, piece: &str, input_bytes: usize, state_limit: usize) {
        if self.unrepresentable {
            return;
        }
        // A visible LF inside a terminal group cannot be represented by this
        // single-line carry. Fail closed rather than merge visual line state.
        if piece.contains('\n') {
            self.unrepresentable = true;
            return;
        }
        self.pem_tail.push_str(piece);
        loop {
            let Some(start) = self.pem_tail.find("-----") else {
                let mut cut = self.pem_tail.len().saturating_sub(4);
                while !self.pem_tail.is_char_boundary(cut) {
                    cut += 1;
                }
                self.pem_tail.drain(..cut);
                break;
            };
            self.pem_tail.drain(..start);
            let rest = &self.pem_tail[5..];
            let prefix = if rest.starts_with("BEGIN ") {
                Some(11)
            } else if rest.starts_with("END ") {
                Some(9)
            } else if "BEGIN ".starts_with(rest) || "END ".starts_with(rest) {
                break;
            } else {
                None
            };
            let Some(label_at) = prefix else {
                self.pem_tail.drain(..5);
                continue;
            };
            let Some(end) = self.pem_tail[label_at..].find("-----") else {
                if self.pem_tail.len() > Self::OVERLAP {
                    self.unrepresentable = true;
                    self.pem_tail.clear();
                }
                break;
            };
            let close_at = label_at + end;
            // Keep the closing dashes: they may introduce the adjacent marker.
            let marker_end = close_at + 5;
            if marker_end > Self::OVERLAP {
                self.unrepresentable = true;
                self.pem_tail.clear();
                break;
            }
            for (begin, label) in pem_events(&self.pem_tail[..marker_end]) {
                if begin {
                    let count = self.pem_open.entry(label.to_owned()).or_default();
                    *count += 1;
                    // Charge complete opener input, including its terminator.
                    self.state_cost = self.state_cost.saturating_add(label.len() + 17);
                } else if let Some(count) = self.pem_open.get_mut(label) {
                    *count -= 1;
                    self.state_cost = self.state_cost.saturating_sub(label.len() + 17);
                    if *count == 0 {
                        self.pem_open.remove(label);
                    }
                }
            }
            self.pem_tail.drain(..close_at);
            if self.state_cost > state_limit {
                self.unrepresentable = true;
                self.pem_open.clear();
                break;
            }
        }
        if !self.pem_open.is_empty() {
            self.live_input = self.live_input.saturating_add(input_bytes);
        } else {
            self.live_input = 0;
        }
        if self.live_input > state_limit {
            self.unrepresentable = true;
            self.pem_open.clear();
        }
    }

    /// Restore the carried private-key openers into `masker` (fresh after the
    /// overlong line), then open the unconditional recovery run: one rule
    /// covers every overlong value shape. The open quote seeds UntilBlank
    /// alongside the token's column-0 block and next-nonblank guard. Returns
    /// the state cost to charge, or `None` when the line could not be carried
    /// (the stream must turn opaque); `masker` is then untouched.
    pub(crate) fn recover(mut self, masker: &mut LineMasker) -> Option<usize> {
        if self.unrepresentable {
            return None;
        }
        let cost = self.state_cost.max(self.live_input);
        for (label, count) in std::mem::take(&mut self.pem_open) {
            let opener = format!("-----BEGIN {label}-----");
            for _ in 0..count {
                let _ = masker.scan(&opener);
            }
        }
        let _ = masker.scan("X_TOKEN=\"");
        Some(cost)
    }

    #[cfg(test)]
    pub(crate) fn pem_tail_len(&self) -> usize {
        self.pem_tail.len()
    }

    pub(crate) fn unrepresentable(&self) -> bool {
        self.unrepresentable
    }
}

impl Drop for SameLineCarry {
    fn drop(&mut self) {
        let mut bytes = std::mem::take(&mut self.pem_tail).into_bytes();
        bytes.fill(0);
    }
}

/// One open YAML-like block: it masks lines indented deeper than `indent` until
/// a non-blank line at or below it.
#[derive(Debug, Clone, Copy)]
struct OpenBlock {
    indent: usize,
    /// Which whitespace kinds (1 space, 2 tab) its line was indented with.
    ws: u8,
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
/// State: per-label PEM opener lists, previous-line secret token/flag flags,
/// an until-blank run and open YAML blocks. Command output reuses this scanner.
#[derive(Debug, Clone)]
pub struct LineMasker {
    class: FileClass,
    lookback: usize,
    /// Open `-----BEGIN <label>-----` private-key blocks per label: the offsets of
    /// their BEGIN lines. An END closes the innermost block of the SAME label. No
    /// cap: a dropped BEGIN would leave its body visible.
    pem_open: std::collections::BTreeMap<String, Vec<usize>>,
    /// Offsets of every open BEGIN with their counts: the latest one is an O(log n)
    /// lookup, so a file with thousands of distinct labels stays linear.
    pem_latest: std::collections::BTreeMap<usize, usize>,
    pending_flag_value: bool,
    /// Offset of the latest opener of the run that masks lines until a blank line.
    until_blank: Option<usize>,
    blocks: Vec<OpenBlock>,
    /// The previous line contained a secret-name token (one line of scope).
    pending_token_line: bool,
    /// Offset of the previous line when it was a token line: the run it opened
    /// survives the always-masked next line, even at the same indentation.
    token_at: Option<usize>,
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
            pem_open: std::collections::BTreeMap::new(),
            pem_latest: std::collections::BTreeMap::new(),
            pending_flag_value: false,
            until_blank: None,
            blocks: Vec::new(),
            pending_token_line: false,
            token_at: None,
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
        self.until_blank.is_some() || !self.blocks.is_empty() || !self.pem_open.is_empty()
    }

    /// Content constructs, including unconditional recovery UntilBlank, must
    /// fail closed through EOF if another line crosses the hold cap.
    pub(crate) fn has_content_continuation(&self) -> bool {
        self.until_blank.is_some() || !self.pem_open.is_empty()
    }

    /// Advance the state over a line that is not valid UTF-8 (context before a
    /// window). The state depends only on ASCII delimiters, which a lossy
    /// conversion keeps.
    pub fn advance_bytes(&mut self, line: &[u8]) {
        let _ = self.scan(&String::from_utf8_lossy(line));
    }

    /// A window line (without its terminator) with its secrets replaced, and
    /// how many spans were masked. A line that is not valid UTF-8 is masked
    /// whole in a secret-class file (unknown means masked; the state advances
    /// as for context); in any other file it is `None` (binary content) and the
    /// state does not advance.
    pub fn mask_bytes<'a>(&mut self, line: &'a [u8]) -> Option<(std::borrow::Cow<'a, str>, usize)> {
        match std::str::from_utf8(line) {
            Ok(body) => Some(self.mask_line_counted(body)),
            Err(_) if self.class.is_secret() => {
                self.advance_bytes(line);
                Some((std::borrow::Cow::Owned(token_bare()), 1))
            }
            Err(_) => None,
        }
    }

    /// Advance the state as a line holding just a secret name (`X_TOKEN`)
    /// would: under the generic rules the next non-blank line is masked, and
    /// every following line indented deeper than column 0. Output recovery
    /// re-arms this guard over blank lines.
    pub fn guard_next_line(&mut self) {
        let _ = self.scan("X_TOKEN");
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
            // whitespace-only lines inside an indentation run are part of it (their
            // bytes are masked); an empty line carries no bytes
            if !line.is_empty() {
                masked_by = self.blocks.iter().map(|block| block.opener).max();
            }
        } else {
            let indent = indent_of(line);
            let kinds = indent_kinds(line);
            self.blocks.retain(|block| {
                block.indent < indent
                    || (indent > 0 && mixed_indent(block.ws, kinds))
                    || Some(block.opener) == self.token_at
            });
            masked_by = self
                .blocks
                .iter()
                .map(|block| block.opener)
                .chain(self.until_blank)
                .max();
        }
        // private-key blocks (any file): from a BEGIN line through the END line of the
        // same label. The markers of a line apply in byte order (`END CERT-----BEGIN
        // KEY` opens one); a mismatched END closes nothing (fail closed); several
        // blocks may be open at once, and the latest opener charges the lookback.
        let pem_open_at_start = self.pem_latest.keys().next_back().copied();
        let mut pem_touched = pem_open_at_start.is_some();
        for (begin, label) in pem_events(line) {
            pem_touched = true;
            if begin {
                self.pem_open.entry(label.to_string()).or_default().push(at);
                *self.pem_latest.entry(at).or_insert(0) += 1;
            } else if let Some(openers) = self.pem_open.get_mut(label) {
                if let Some(opener) = openers.pop()
                    && let Some(count) = self.pem_latest.get_mut(&opener)
                {
                    *count -= 1;
                    if *count == 0 {
                        self.pem_latest.remove(&opener);
                    }
                }
                if openers.is_empty() {
                    self.pem_open.remove(label);
                }
            }
        }
        let pem_opener = pem_open_at_start.or(pem_touched.then_some(at));
        masked_by = masked_by.max(pem_opener);
        // 2. the line's own rules and openers, always (union semantics)
        let (masks, opened) = self.scan_body(line);
        self.token_at = self.pending_token_line.then_some(at);
        if let Some(opener) = masked_by
            && at.saturating_sub(opener) > self.lookback
        {
            self.long_run = true;
        }
        // 3. register what this line opened or closed
        for construct in opened {
            match construct {
                Construct::None => {}
                Construct::UntilBlank => self.until_blank = Some(at),
                Construct::Block { line_indent } => {
                    let kinds = indent_kinds(line);
                    self.blocks
                        .retain(|block| block.indent != line_indent || block.ws != kinds);
                    self.blocks.push(OpenBlock {
                        indent: line_indent,
                        ws: indent_kinds(line),
                        opener: at,
                    });
                }
            }
        }
        // PEM content stays opaque even when its body happens to contain a name.
        if pem_touched {
            return vec![(0..line.len(), token_bare())];
        }
        if masked_by.is_some() {
            if masks.len() == 1
                && masks
                    .first()
                    .is_some_and(|(range, _)| range.start == 0 && range.end == line.len())
            {
                return masks;
            }
            return vec![(0..line.len(), token_bare())];
        }
        if masks.is_empty() {
            masks
        } else {
            merge(masks, line)
        }
    }

    /// The class and generic rules over `line` (ranges relative to `line`).
    fn scan_body(&mut self, line: &str) -> (Vec<LineMask>, Vec<Construct>) {
        let mut masks: Vec<LineMask> = Vec::new();
        // every recognizer that fires contributes its opener: none replaces another
        let mut constructs: Vec<Construct> = Vec::new();
        let mut generic = true;
        match self.class {
            FileClass::SshPrivateKey => {
                generic = false;
                if !line.trim().is_empty() {
                    masks.push((0..line.len(), token_bare()));
                }
            }
            FileClass::HfToken => {
                generic = false;
                if !line.trim().is_empty() {
                    masks.push((0..line.len(), token(line.chars().count())));
                }
            }
            FileClass::PemKey | FileClass::Plain => {}
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
                    constructs.push(construct_for_tail(
                        &line[m.end()..],
                        false,
                        indent_of(line),
                        quote_left_open(line),
                    ));
                } else {
                    masks.push((0..line.len(), token_bare()));
                    constructs.push(construct_for_tail(
                        line,
                        false,
                        indent_of(line),
                        quote_left_open(line),
                    ));
                }
            }
        }
        if generic {
            if self.pending_flag_value
                && let Some((range, opened)) = continuation_value(line)
            {
                masks.extend(tail_mask(line, range.start));
                constructs.push(opened);
            }
            if first_secret_name(line).is_some() {
                // purely structural: every following line indented deeper than this one
                // (blank lines included) is masked, whatever the line looks like
                constructs.push(Construct::Block {
                    line_indent: indent_of(line),
                });
                // an open quote or a trailing backslash also runs to the next blank line
                if line.trim_end().ends_with('\\') || quote_left_open(line) {
                    constructs.push(Construct::UntilBlank);
                }
                // the marker never copies text of the line (a word that looks like a
                // secret name can itself be the secret value: `--password admin_password`)
                masks = vec![(0..line.len(), format!("{MASK_OPEN} line{MASK_CLOSE}"))];
                self.pending_token_line = true;
            } else {
                if let Some((start, opened)) = first_flag(line) {
                    masks.extend(tail_mask(line, start));
                    constructs.push(opened);
                }
                if self.pending_token_line && !line.trim().is_empty() {
                    masks = vec![(0..line.len(), format!("{MASK_OPEN} line{MASK_CLOSE}"))];
                    // a value that opens a quote or ends in a backslash runs on to the
                    // next blank line (`value = """`, `VALUE="a` )
                    if line.trim_end().ends_with('\\') || quote_left_open(line) {
                        constructs.push(Construct::UntilBlank);
                    }
                }
                self.pending_token_line = false;
            }
        } else {
            self.pending_token_line = false;
        }
        self.pending_flag_value = line.contains('-') && FLAG_AT_END.is_match(line);
        (masks, constructs)
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
