//! Bounded secret masking for accidental disclosure (`design-r3.md`).
//!
//! In ordinary files, a case-insensitive secret-name word masks its WHOLE line
//! as `⟦redacted line⟧`, and the following non-blank line as
//! `⟦redacted line⟧`. Words are maximal `[A-Za-z0-9_-]+` runs that do not start
//! with `-`: they end in `_TOKEN`, `_KEY`, `_SECRET`, `_PASSWORD`, `apikey`,
//! `api-key`, `api_key`, `hf-token` or `hf_token`, or equal `PASSWORD`.
//! The suffix must end the word; `MAX_TOKENS`, `TOKENS` and `KEYBOARD` stay
//! visible. Words starting with `-` use the separate secret-flag rule, which
//! masks the value tail of `--api-key VALUE` and its continuations.
//!
//! Dotenv files retain their own rule: only blanks, comments and the KEY of a
//! simple `KEY=` / `export KEY=` line are shown; unknown lines are masked whole.
//! Comments containing a secret-name word use the whole-line rule. Hugging Face
//! token files and non-public `.ssh` files are masked by class. Private-key PEM
//! blocks are masked by content in every file through the matching END label;
//! an END closes only the innermost opener of its own label. Public keys and
//! certificates stay visible. There is no vendor-prefix credential scanner.
//!
//! A token line also masks every following line indented deeper than itself
//! (blank lines inside the run included; a tab against a space is fail-closed
//! deeper) and ends at the first non-blank line at or below its indentation. No
//! block header, key syntax or comment is inspected. An open quote or a trailing
//! backslash on a token line also runs to the next blank line. Openers are
//! scanned even inside masked runs, and all open constructs contribute masks
//! (restartable union semantics).
//! Reads feed the bounded [`LOOKBACK_BYTES`] context plus its preceding line;
//! constructs beyond that lookback are a documented residual. [`mask`]
//! records every replacement as a span without changing line counts. Edits
//! cannot touch spans or expose surviving masked bytes, and cannot create a
//! construct longer than the lookback. Mask markers are refused on write-back.
//!
//! Path classification is Unicode-folded, ignores trailing dots/spaces and
//! never searches other files. Secret-class paths and directories are read-only
//! through [`is_secret_scope`] and `Policy::check_path`.
//!
//! `class` classifies by path, `recognize` holds the stateless per-line rules,
//! and `masker` folds them over lines ([`LineMasker`]); the masked view and
//! [`mask`] over a whole text are here.

use std::ops::Range;

mod class;
mod masker;
mod recognize;
#[cfg(test)]
mod tests;

pub(crate) use class::fold;
pub use class::{FileClass, classify, is_secret_scope};
pub use masker::LineMasker;
pub(crate) use masker::SameLineCarry;

/// Prefix of every mask token. Content carrying it is refused on write.
pub const MASK_OPEN: &str = "\u{27E6}redacted";
const MASK_CLOSE: &str = "\u{27E7}";

/// One masked region: its byte range in the masked view and in the real text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub view: Range<usize>,
    pub orig: Range<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaskedView {
    pub text: String,
    pub spans: Vec<Span>,
    /// `cum[i]`: real-text length minus masked-view length over `spans[..=i]`.
    cum: Vec<isize>,
    /// A masked multi-line run reaches further past its opening line than
    /// [`LOOKBACK_BYTES`]: a windowed read would not see the opener. An edit that
    /// creates such a run is refused (an agent could otherwise build one).
    long_construct: bool,
}

/// One occurrence of an exact-match needle in a masked view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occurrence {
    /// Byte offset of the match in the masked view.
    pub at: usize,
    /// The match's range in the real text; `None` when the match touches a
    /// masked span (it cannot be edited).
    pub orig: Option<Range<usize>>,
}

/// Why the masked view of an edited text is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exposure {
    /// The edited text holds a masked multi-line run longer than the read
    /// lookback (see [`MaskedView`]): a read could not mask it.
    LongConstruct,
    /// A masked byte of the original that the edit kept is not masked in the
    /// edited text.
    Unmasked,
}

impl MaskedView {
    pub fn redactions(&self) -> usize {
        self.spans.len()
    }

    /// Every occurrence of `needle` in the masked view, in order, with the
    /// real-text range it would replace.
    pub fn occurrences<'a>(&'a self, needle: &'a str) -> impl Iterator<Item = Occurrence> + 'a {
        self.text.match_indices(needle).map(|(at, _)| {
            let range = at..at + needle.len();
            let orig = (!self.overlaps_span(&range))
                .then(|| self.to_orig(range.start)..self.to_orig(range.end));
            Occurrence { at, orig }
        })
    }

    /// The masked view of `edited`, the real text of `self` after an edit,
    /// refused when it holds a masked run longer than the read lookback or
    /// when a masked byte of `self` that the edit kept is no longer masked in
    /// it. `shift` gives, for a real-text position of `self` outside the
    /// replaced ranges, how far the replacements before it shift it.
    pub fn after_edit(
        &self,
        class: FileClass,
        edited: &str,
        shift: impl Fn(usize) -> i64,
    ) -> Result<MaskedView, Exposure> {
        let after = mask(class, edited);
        if after.long_construct {
            return Err(Exposure::LongConstruct);
        }
        if !self.stays_masked_in(&after, shift) {
            return Err(Exposure::Unmasked);
        }
        Ok(after)
    }

    /// Whether `range` (masked-view bytes) overlaps a masked span. An empty
    /// range overlaps only when strictly inside a span.
    fn overlaps_span(&self, range: &Range<usize>) -> bool {
        // Spans are sorted and disjoint: the first one that ends after
        // `range.start` is the only candidate.
        let idx = self
            .spans
            .partition_point(|span| span.view.end <= range.start);
        let Some(span) = self.spans.get(idx) else {
            return false;
        };
        if range.start == range.end {
            range.start > span.view.start && range.start < span.view.end
        } else {
            range.start < span.view.end && span.view.start < range.end
        }
    }

    /// Count of spans whose masked-view range starts inside `range`.
    pub fn spans_in(&self, range: &Range<usize>) -> usize {
        self.spans
            .iter()
            .filter(|s| s.view.start >= range.start && s.view.start < range.end)
            .count()
    }

    /// Whether a masked span covers part of `range` (real-text bytes).
    pub fn masks_orig(&self, range: &Range<usize>) -> bool {
        self.spans
            .iter()
            .any(|span| range.start < span.orig.end && span.orig.start < range.end)
    }

    /// Whether every masked span of `self` that survives an edit lies inside a
    /// masked span of `after`, the masked view of the edited text. `delta`
    /// gives, for a real-text position of `self` outside the replaced ranges,
    /// how far the replacements before it shift it.
    fn stays_masked_in(&self, after: &MaskedView, delta: impl Fn(usize) -> i64) -> bool {
        for span in &self.spans {
            let start = (span.orig.start as i64 + delta(span.orig.start)) as usize;
            let end = start + span.orig.len();
            // masked-view spans of `after` are sorted; walk the run that covers `start`
            let mut at = after.spans.partition_point(|s| s.orig.end <= start);
            let mut cursor = start;
            while cursor < end {
                match after.spans.get(at) {
                    Some(s) if s.orig.start <= cursor => {
                        cursor = s.orig.end;
                        at += 1;
                    }
                    _ => return false,
                }
            }
        }
        true
    }

    /// The masked view's lines, each with its end of line.
    pub fn lines(&self) -> std::str::SplitInclusive<'_, char> {
        self.text.split_inclusive('\n')
    }

    /// Map a masked-view position that is not strictly inside a span to the
    /// same position in the real text.
    fn to_orig(&self, pos: usize) -> usize {
        let idx = self.spans.partition_point(|span| span.view.end <= pos);
        let delta = if idx == 0 { 0 } else { self.cum[idx - 1] };
        (pos as isize + delta) as usize
    }

    fn from_parts(text: String, spans: Vec<Span>, long_construct: bool) -> Self {
        let mut delta: isize = 0;
        let cum = spans
            .iter()
            .map(|span| {
                delta += span.orig.len() as isize - span.view.len() as isize;
                delta
            })
            .collect();
        Self {
            text,
            spans,
            cum,
            long_construct,
        }
    }
}

fn token(chars: usize) -> String {
    format!("{MASK_OPEN}:{chars}{MASK_CLOSE}")
}

fn token_bare() -> String {
    format!("{MASK_OPEN}{MASK_CLOSE}")
}

/// How far before a window a read looks for masking context (an open multi-line
/// value or `PRIVATE KEY` block). The masker is fed only the lines in this many
/// bytes before the window, never the whole prefix. Real PEM keys are a few KiB
/// and a secret value that spans lines is small, so 1 MiB covers them by a wide
/// margin; a construct opened further back than this is not seen (documented
/// residual in `design-r2.md` and the PR body).
pub const LOOKBACK_BYTES: usize = 1024 * 1024;

/// Mask `text` (the real file content) for `class`. Used by the edit engine,
/// which needs the whole masked view; reads mask only the lines they return.
pub fn mask(class: FileClass, text: &str) -> MaskedView {
    mask_with_lookback(class, text, LOOKBACK_BYTES)
}

/// [`mask`] with an explicit lookback (tests use a tiny one).
pub(crate) fn mask_with_lookback(class: FileClass, text: &str, lookback: usize) -> MaskedView {
    let mut masker = LineMasker::with_lookback(class, lookback);
    let mut out = String::with_capacity(text.len());
    let mut spans = Vec::new();
    let mut offset = 0;
    for raw in text.split_inclusive('\n') {
        let body_len = raw.trim_end_matches(['\n', '\r']).len();
        let (line, ending) = raw.split_at(body_len);
        let mut cursor = 0;
        let masks = masker.scan_at(line, offset);
        for (range, tok) in masks {
            out.push_str(&line[cursor..range.start]);
            let view_start = out.len();
            out.push_str(&tok);
            spans.push(Span {
                view: view_start..out.len(),
                orig: offset + range.start..offset + range.end,
            });
            cursor = range.end;
        }
        out.push_str(&line[cursor..]);
        out.push_str(ending);
        offset += raw.len();
    }
    MaskedView::from_parts(out, spans, masker.long_run())
}
