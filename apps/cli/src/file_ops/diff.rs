//! Compact unified diffs for edit/write results (plan section 2.1): one line of
//! context, hunks only (no file header), capped at 8 KiB. Callers pass the
//! **masked** before/after views for MCP results. Consent previews instead use
//! byte provenance: disk context is masked, and additions carrying hidden disk
//! bytes are blocked rather than rendered.

use std::ops::Range;
use std::time::Duration;

use serde::Serialize;
use similar::{Algorithm, TextDiff};

pub const DIFF_MAX_BYTES: usize = 8 * 1024;
const DIFF_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiffSummary {
    /// Unified hunks with one context line; empty when nothing changed.
    pub diff: String,
    pub added: usize,
    pub removed: usize,
    /// `[start, len]` in the new file (1-based), one per hunk.
    pub hunks: Vec<[usize; 2]>,
}

pub fn diff_lines(before: &str, after: &str) -> DiffSummary {
    let diff = TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .timeout(DIFF_TIMEOUT)
        .diff_lines(before, after);
    let mut added = 0;
    let mut removed = 0;
    for change in diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert => added += 1,
            similar::ChangeTag::Delete => removed += 1,
            similar::ChangeTag::Equal => {}
        }
    }
    let hunks = diff
        .grouped_ops(1)
        .iter()
        .filter_map(|group| {
            let first = group.first()?;
            let last = group.last()?;
            let start = first.new_range().start;
            let end = last.new_range().end;
            Some([start + 1, end - start])
        })
        .collect();

    let rendered: Vec<String> = diff
        .unified_diff()
        .context_radius(1)
        .iter_hunks()
        .map(|hunk| hunk.to_string())
        .collect();
    DiffSummary {
        diff: cap_hunks(&rendered),
        added,
        removed,
        hunks,
    }
}

struct DiskCopy {
    after: Range<usize>,
    before: Range<usize>,
}

/// Builds the after side together with its provenance. Every append is either
/// requester text or a checked slice of the disk pre-image; no caller can supply
/// after text while forgetting the carried disk ranges.
pub(crate) struct ConsentText<'a> {
    before: &'a str,
    after: String,
    disk: Vec<DiskCopy>,
}

impl<'a> ConsentText<'a> {
    pub(crate) fn new(before: &'a str) -> Self {
        Self {
            before,
            after: String::new(),
            disk: Vec::new(),
        }
    }

    pub(crate) fn push_agent(&mut self, text: &str) {
        self.after.push_str(text);
    }

    pub(crate) fn push_disk(&mut self, range: Range<usize>) -> super::error::FileResult<()> {
        let text = self.before.get(range.clone()).ok_or_else(|| {
            super::error::FileError::new(
                super::error::ErrorCode::RedactedSpan,
                "cannot map copied disk bytes",
            )
        })?;
        if !text.is_empty() {
            let start = self.after.len();
            self.after.push_str(text);
            self.disk.push(DiskCopy {
                after: start..self.after.len(),
                before: range,
            });
        }
        Ok(())
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.after
    }

    fn carries_hidden_disk(
        &self,
        line: Range<usize>,
        before: &super::redact::MaskedView,
        after: &super::redact::MaskedView,
    ) -> bool {
        fn hidden(view: &super::redact::MaskedView, range: Range<usize>) -> bool {
            let at = view
                .spans
                .partition_point(|span| span.orig.end <= range.start);
            view.spans
                .get(at)
                .is_some_and(|span| span.orig.start < range.end)
        }
        let at = self
            .disk
            .partition_point(|copy| copy.after.end <= line.start);
        self.disk[at..]
            .iter()
            .take_while(|copy| copy.after.start < line.end)
            .any(|copy| {
                let start = copy.after.start.max(line.start);
                let end = copy.after.end.min(line.end);
                let original_start = copy.before.start + start - copy.after.start;
                hidden(before, original_start..original_start + end - start)
                    || hidden(after, start..end)
            })
    }
}

/// The sole consent content renderer. Raw LF slices drive the diff; masked LF
/// slices supply disk deletions/context. An addition carrying hidden disk bytes
/// blocks the entire preview, while agent bytes remain verbatim. Never re-diff
/// masked text, which can turn unchanged disk secrets into additions.
pub(crate) fn consent_diff(
    text: &ConsentText<'_>,
    class: super::redact::FileClass,
) -> super::error::FileResult<String> {
    use super::error::{ErrorCode, FileError};
    let masked = super::redact::mask(class, text.before);
    let after_masked = super::redact::mask(class, text.as_str());
    if masked.long_construct || after_masked.long_construct {
        return Err(FileError::new(
            ErrorCode::RedactedSpan,
            "cannot fully mask the disk pre-image",
        ));
    }
    let (before_lines, lines) = consent_lines(text.before, &masked)?;
    let (after_lines, _) = consent_lines(text.as_str(), &after_masked)?;
    let diff = TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .timeout(DIFF_TIMEOUT)
        .newline_terminated(true)
        .diff_slices(&before_lines, &after_lines);
    if diff.old_len() != lines.len() || diff.new_len() != after_lines.len() {
        return Err(FileError::new(
            ErrorCode::RedactedSpan,
            "cannot map diff lines",
        ));
    }
    let mut offset = 0;
    let after_ranges: Vec<_> = after_lines
        .iter()
        .map(|line| {
            let start = offset;
            offset += line.len();
            start..offset
        })
        .collect();
    let mut out = String::new();
    for hunk in diff.unified_diff().context_radius(1).iter_hunks() {
        out.push_str(&format!("{}\n", hunk.header()));
        for change in hunk.iter_changes() {
            let value = match change.old_index() {
                Some(index) => *lines.get(index).ok_or_else(|| {
                    FileError::new(ErrorCode::RedactedSpan, "cannot map a disk diff line")
                })?,
                None => {
                    let range = change
                        .new_index()
                        .and_then(|index| after_ranges.get(index))
                        .ok_or_else(|| {
                            FileError::new(ErrorCode::RedactedSpan, "cannot map an added line")
                        })?;
                    if text.carries_hidden_disk(range.clone(), &masked, &after_masked) {
                        return Err(FileError::new(
                            ErrorCode::RedactedSpan,
                            "an added approval line carries masked disk bytes",
                        ));
                    }
                    change.value()
                }
            };
            out.push_str(&change.tag().to_string());
            out.push_str(value);
            if !value.ends_with('\n') {
                out.push_str("\n\\ No newline at end of file\n");
            }
            // The terminal escapes controls/invisible characters. Account for
            // that expansion too; padding must never hide an applicable hunk.
            if crate::display_escape::escape_for_display(&out).len() > DIFF_MAX_BYTES {
                return Err(FileError::new(
                    ErrorCode::TooLarge,
                    "the complete approval diff exceeds 8 KiB",
                ));
            }
        }
    }
    Ok(out)
}

fn consent_lines<'a>(
    raw: &'a str,
    masked: &'a super::redact::MaskedView,
) -> super::error::FileResult<(Vec<&'a str>, Vec<&'a str>)> {
    let raw: Vec<_> = super::text::lf_lines(raw).collect();
    let masked: Vec<_> = super::text::lf_lines(&masked.text).collect();
    if raw.len() != masked.len() {
        return Err(super::error::FileError::new(
            super::error::ErrorCode::RedactedSpan,
            "cannot map masked consent lines",
        ));
    }
    Ok((raw, masked))
}

fn cap_hunks(hunks: &[String]) -> String {
    let mut out = String::new();
    for (index, hunk) in hunks.iter().enumerate() {
        if out.len() + hunk.len() <= DIFF_MAX_BYTES {
            out.push_str(hunk);
            continue;
        }
        let remaining = hunks.len() - index;
        if index == 0 {
            let mut cut = DIFF_MAX_BYTES;
            while !hunk.is_char_boundary(cut) {
                cut -= 1;
            }
            out.push_str(&hunk[..cut]);
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&format!(
                "…[diff truncated: +{} more hunks]",
                remaining.saturating_sub(1)
            ));
        } else {
            out.push_str(&format!("…[diff truncated: +{remaining} more hunks]"));
        }
        return out;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consent_line_count_guard_fails_closed_for_either_side() {
        use super::super::redact::{FileClass, mask};
        for raw in ["a\rb\nc\n", "a\r\nb\r\n", "a\nb"] {
            let mut masked = mask(FileClass::Plain, raw);
            assert!(consent_lines(raw, &masked).is_ok());
            masked.text = "one line\n".to_owned();
            assert_eq!(
                consent_lines(raw, &masked).unwrap_err().code,
                super::super::error::ErrorCode::RedactedSpan
            );
            masked.text = format!("{raw}\nextra\n");
            assert_eq!(
                consent_lines(raw, &masked).unwrap_err().code,
                super::super::error::ErrorCode::RedactedSpan
            );
        }
    }

    #[test]
    fn single_line_change_matches_plan_shape() {
        let before = "a\nb\n--ctx-size 32768 \\\nd\ne\n";
        let after = "a\nb\n--ctx-size 65536 \\\nd\ne\n";
        let d = diff_lines(before, after);
        assert_eq!(
            d.diff,
            "@@ -2,3 +2,3 @@\n b\n---ctx-size 32768 \\\n+--ctx-size 65536 \\\n d\n"
        );
        assert_eq!((d.added, d.removed), (1, 1));
        assert_eq!(d.hunks, vec![[2, 3]]);
    }

    #[test]
    fn no_change_is_empty() {
        let d = diff_lines("x\n", "x\n");
        assert_eq!(
            d,
            DiffSummary {
                diff: String::new(),
                added: 0,
                removed: 0,
                hunks: vec![]
            }
        );
    }

    #[test]
    fn distant_edits_make_two_hunks_with_one_context_line() {
        let before: String = (1..=20).map(|n| format!("l{n}\n")).collect();
        let after = before.replace("l3\n", "L3\n").replace("l18\n", "L18\n");
        let d = diff_lines(&before, &after);
        assert_eq!(d.hunks.len(), 2);
        assert_eq!(d.diff.matches("@@").count(), 4);
        assert!(!d.diff.contains("l10"));
    }

    #[test]
    fn output_is_capped_at_hunk_boundaries() {
        let before: String = (0..4000).map(|n| format!("line {n}\n")).collect();
        let after: String = (0..4000)
            .map(|n| {
                if n % 10 == 0 {
                    format!("changed line number {n}\n")
                } else {
                    format!("line {n}\n")
                }
            })
            .collect();
        let d = diff_lines(&before, &after);
        assert!(d.diff.len() <= DIFF_MAX_BYTES + 64, "{}", d.diff.len());
        assert!(d.diff.contains("…[diff truncated: +"), "{}", d.diff);
        assert_eq!(d.hunks.len(), 400);
        assert_eq!(d.added, 400);
    }

    #[test]
    fn one_giant_hunk_is_cut_on_a_char_boundary() {
        let before = "x\n";
        let after = format!("{}\n", "é".repeat(20_000));
        let d = diff_lines(before, &after);
        assert!(d.diff.contains("…[diff truncated: +0 more hunks]"));
        assert!(d.diff.len() < DIFF_MAX_BYTES + 64);
    }

    #[test]
    fn missing_final_newline_is_reported() {
        let d = diff_lines("a\nb", "a\nb\n");
        assert!(d.diff.contains("No newline at end of file"), "{}", d.diff);
    }

    /// C3c-3: the provenance check is `hidden(before view) || hidden(after view)`.
    /// Each half is pinned by a hand-built `ConsentText` that only that half
    /// catches, independent of the edit planners (whose own guards keep carried
    /// masked bytes masked in the after view and would otherwise hide a dead half).
    #[test]
    fn consent_provenance_halves_each_block_alone() {
        use super::super::error::ErrorCode;
        use super::super::redact::FileClass;
        struct Row {
            label: &'static str,
            before: &'static str,
            agent_prefix: &'static str,
            disk: std::ops::Range<usize>,
            masked_in_before: bool,
            masked_in_after: bool,
            blocked: bool,
        }
        let rows = [
            // The carried bytes are a masked value on disk, but the surrounding
            // key is gone in the after text, so only the BEFORE view hides them.
            Row {
                label: "before view only",
                before: "--api-key value-one\n",
                agent_prefix: "",
                disk: 10..19,
                masked_in_before: true,
                masked_in_after: false,
                blocked: true,
            },
            // The carried bytes are harmless on disk (`--port ...`) but the requester
            // wraps them in a secret key: the AFTER view hides them, the disk
            // text never held a secret. Intended over-block: either masked view.
            Row {
                label: "after view only",
                before: "--port value-one\n",
                agent_prefix: "--api-key ",
                disk: 7..16,
                masked_in_before: false,
                masked_in_after: true,
                blocked: true,
            },
            Row {
                label: "both views",
                before: "--api-key value-one\n",
                agent_prefix: "--api-key ",
                disk: 10..19,
                masked_in_before: true,
                masked_in_after: true,
                blocked: true,
            },
            Row {
                label: "neither view",
                before: "--port value-one\n",
                agent_prefix: "--other ",
                disk: 7..16,
                masked_in_before: false,
                masked_in_after: false,
                blocked: false,
            },
        ];
        for row in rows {
            let mut text = ConsentText::new(row.before);
            text.push_agent(row.agent_prefix);
            text.push_disk(row.disk.clone()).expect("range maps");
            text.push_agent(" tail\n");
            let before_view = super::super::redact::mask(FileClass::Plain, row.before);
            let after_view = super::super::redact::mask(FileClass::Plain, text.as_str());
            let hidden = |view: &super::super::redact::MaskedView,
                          range: std::ops::Range<usize>| {
                view.spans
                    .iter()
                    .any(|span| span.orig.start < range.end && range.start < span.orig.end)
            };
            let after_range = row.agent_prefix.len()..row.agent_prefix.len() + row.disk.len();
            assert_eq!(
                hidden(&before_view, row.disk.clone()),
                row.masked_in_before,
                "{}: fixture",
                row.label
            );
            assert_eq!(
                hidden(&after_view, after_range),
                row.masked_in_after,
                "{}: fixture",
                row.label
            );
            let result = consent_diff(&text, FileClass::Plain);
            if row.blocked {
                assert_eq!(
                    result.unwrap_err().code,
                    ErrorCode::RedactedSpan,
                    "{}",
                    row.label
                );
            } else {
                let screen = result.expect(row.label);
                assert!(
                    screen.contains("+--other value-one tail"),
                    "{}: {screen}",
                    row.label
                );
            }
        }
    }
}
