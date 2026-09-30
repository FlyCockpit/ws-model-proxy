//! Compact unified diffs for edit/write results (plan section 2.1): one line of
//! context, hunks only (no file header), capped at 8 KiB. Callers pass the
//! **masked** before/after views for MCP results. Consent previews instead use
//! raw changes, mapping only disk-derived lines to their masked pre-image.

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

/// A complete consent diff: additions are requester-authored, while deletions
/// and context come only from the independently masked disk pre-image. Never
/// re-diff masked text: that would turn unchanged disk secrets into additions.
pub(crate) fn consent_diff(
    before: &str,
    after: &str,
    masked: &super::redact::MaskedView,
) -> super::error::FileResult<String> {
    use super::error::{ErrorCode, FileError};
    if masked.long_construct {
        return Err(FileError::new(
            ErrorCode::RedactedSpan,
            "cannot fully mask the disk pre-image",
        ));
    }
    let lines: Vec<&str> = masked.text.split_inclusive('\n').collect();
    if lines.len() != before.split_inclusive('\n').count() {
        return Err(FileError::new(
            ErrorCode::RedactedSpan,
            "cannot map the disk pre-image",
        ));
    }
    let diff = TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .timeout(DIFF_TIMEOUT)
        .diff_lines(before, after);
    let mut out = String::new();
    for hunk in diff.unified_diff().context_radius(1).iter_hunks() {
        out.push_str(&format!("{}\n", hunk.header()));
        for change in hunk.iter_changes() {
            let value = match change.old_index() {
                Some(index) => *lines.get(index).ok_or_else(|| {
                    FileError::new(ErrorCode::RedactedSpan, "cannot map a disk diff line")
                })?,
                None => change.value(),
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
}
