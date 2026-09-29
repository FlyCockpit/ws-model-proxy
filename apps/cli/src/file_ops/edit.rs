//! `forwarder_cli_file_edit`: exact-string and line-range edits, applied
//! all-or-nothing against the ORIGINAL content.
//!
//! Exact matching runs against the **masked view**, never the raw bytes: an
//! agent that cannot see a secret cannot probe it through `match_count` /
//! `no_match` differences, and any match that touches a masked span is refused
//! (`redacted_span`). Line-range edits address the original file's lines and
//! require `expectedEtag`. There is no fuzzy matching.

use std::ops::Range;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::atomic;
use super::diff::diff_lines;
use super::error::{ErrorCode, FileError, FileResult};
use super::policy::Access;
use super::read::{binary_error, load_all};
use super::redact::{self, MASK_OPEN, MaskedView};
use super::resolve::{ResolveOpts, resolve};
use super::text::{self, Eol};
use super::{Cancel, FileOps, check_reason};

pub const MAX_EDITS: usize = 20;
/// Edits load the whole file, so the result is capped (config and script files).
pub const MAX_EDIT_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ExpectedMatches {
    Count(u32),
    All(String),
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditOp {
    pub old_text: Option<String>,
    pub new_text: String,
    pub expected_matches: Option<ExpectedMatches>,
    pub start_line: Option<u64>,
    pub end_line: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditArgs {
    pub path: String,
    /// Required when any edit is a line-range edit; recommended always.
    pub expected_etag: Option<String>,
    pub edits: Vec<EditOp>,
    pub dry_run: Option<bool>,
    pub return_diff: Option<bool>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    /// The new etag (the previous one for a dry run or an unchanged file).
    pub etag: String,
    pub previous_etag: String,
    pub added: usize,
    pub removed: usize,
    pub applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    /// `[start, len]` per hunk when `returnDiff` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hunks: Option<Vec<[usize; 2]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
}

struct Planned {
    orig: Range<usize>,
    replacement: String,
}

pub fn edit(ops: &FileOps, args: &EditArgs, cancel: &Cancel) -> FileResult<EditResult> {
    check_reason(&args.reason)?;
    if args.edits.is_empty() || args.edits.len() > MAX_EDITS {
        return Err(FileError::invalid(format!(
            "edits must hold 1 to {MAX_EDITS} entries"
        )));
    }
    let mut needs_etag = false;
    for op in &args.edits {
        match (&op.old_text, op.start_line, op.end_line) {
            (Some(old), None, None) => {
                if old.is_empty() {
                    return Err(FileError::invalid("oldText must not be empty"));
                }
            }
            (None, Some(_), Some(_)) if op.expected_matches.is_none() => needs_etag = true,
            _ => {
                return Err(FileError::invalid(
                    "each edit is either {oldText,newText[,expectedMatches]} or {startLine,endLine,newText}",
                ));
            }
        }
        if op.new_text.contains(MASK_OPEN) {
            return Err(FileError::new(
                ErrorCode::RedactedSpan,
                "newText contains a redaction marker; masked text cannot be written back",
            ));
        }
    }
    if needs_etag && args.expected_etag.is_none() {
        return Err(FileError::invalid(
            "expectedEtag is required for line-range edits",
        ));
    }

    let resolved = resolve(
        &args.path,
        &ResolveOpts {
            follow_last: true,
            make_parents: None,
            policy: &ops.policy,
            access: Access::Write,
        },
    )?;
    let (mut file, stat) = resolved.open_regular(&ops.policy, Access::Write)?;
    let full = resolved.full_path();
    let _lock = ops.lock_path(full.clone(), cancel)?;

    let original = load_all(&mut file, &stat, MAX_EDIT_FILE_BYTES)?;
    let previous_etag = ops.key.strong(&original);
    if let Some(expected) = &args.expected_etag
        && *expected != previous_etag
    {
        return Err(FileError::conflict(&previous_etag));
    }
    if let Some(kind) = text::sniff_binary(&original) {
        return Err(binary_error(kind, stat.size, &previous_etag));
    }
    let original_text = std::str::from_utf8(&original)
        .map_err(|_| binary_error("unknown", stat.size, &previous_etag))?;
    let class = redact::classify(&full);
    let view = redact::mask(class, original_text);
    let crlf = text::detect_eol(&original) == Eol::Crlf;

    let mut planned: Vec<Planned> = Vec::new();
    for (index, op) in args.edits.iter().enumerate() {
        let new_text = translate_eol(&op.new_text, crlf);
        match (&op.old_text, op.start_line, op.end_line) {
            (Some(old), _, _) => {
                plan_exact(
                    &view,
                    &translate_eol(old, crlf),
                    &new_text,
                    op,
                    index,
                    &mut planned,
                )?;
            }
            (None, Some(start), Some(end)) => {
                planned.push(plan_lines(&view, &original, start, end, new_text, index)?);
            }
            _ => return Err(FileError::invalid("malformed edit")),
        }
    }
    planned.sort_by_key(|p| (p.orig.start, p.orig.end));
    for pair in planned.windows(2) {
        if pair[1].orig.start < pair[0].orig.end || pair[1].orig.start == pair[0].orig.start {
            return Err(FileError::invalid(
                "edits overlap; every edit is evaluated against the original file",
            ));
        }
    }

    let mut updated: Vec<u8> = Vec::with_capacity(original.len());
    let mut cursor = 0;
    for plan in &planned {
        updated.extend_from_slice(&original[cursor..plan.orig.start]);
        updated.extend_from_slice(plan.replacement.as_bytes());
        cursor = plan.orig.end;
    }
    updated.extend_from_slice(&original[cursor..]);
    if updated.len() as u64 > MAX_EDIT_FILE_BYTES {
        return Err(FileError::new(
            ErrorCode::TooLarge,
            "the edited file would exceed 16 MiB",
        ));
    }
    let updated_text = std::str::from_utf8(&updated)
        .map_err(|_| FileError::invalid("the edit would produce invalid UTF-8"))?;

    let after_view = redact::mask(class, updated_text);
    let summary = diff_lines(&view.text, &after_view.text);
    let (diff, hunks) = if args.return_diff.unwrap_or(true) {
        (Some(summary.diff.clone()), None)
    } else {
        (None, Some(summary.hunks.clone()))
    };
    let echo = resolved.echo(&args.path);

    if updated == original {
        return Ok(EditResult {
            etag: previous_etag.clone(),
            previous_etag,
            added: 0,
            removed: 0,
            applied: false,
            diff,
            hunks,
            resolved_path: echo,
        });
    }
    if args.dry_run.unwrap_or(false) {
        return Ok(EditResult {
            etag: previous_etag.clone(),
            previous_etag,
            added: summary.added,
            removed: summary.removed,
            applied: false,
            diff,
            hunks,
            resolved_path: echo,
        });
    }

    cancel.check()?;
    atomic::replace(
        ops,
        &resolved.dir,
        &resolved.name,
        &mut file,
        &stat,
        &previous_etag,
        &updated,
        cancel,
    )?;
    Ok(EditResult {
        etag: ops.key.strong(&updated),
        previous_etag,
        added: summary.added,
        removed: summary.removed,
        applied: true,
        diff,
        hunks,
        resolved_path: echo,
    })
}

/// In a uniformly CRLF file, a bare `\n` in the request means `\r\n`.
fn translate_eol(text: &str, crlf: bool) -> String {
    if !crlf {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + 8);
    let mut prev = '\0';
    for ch in text.chars() {
        if ch == '\n' && prev != '\r' {
            out.push('\r');
        }
        out.push(ch);
        prev = ch;
    }
    out
}

fn line_of(text: &str, byte: usize) -> usize {
    text[..byte].matches('\n').count() + 1
}

fn plan_exact(
    view: &MaskedView,
    old: &str,
    new_text: &str,
    op: &EditOp,
    index: usize,
    planned: &mut Vec<Planned>,
) -> FileResult<()> {
    let matches: Vec<usize> = view.text.match_indices(old).map(|(at, _)| at).collect();
    let found = matches.len();
    if found == 0 {
        return Err(FileError::new(
            ErrorCode::NoMatch,
            format!("edit {index}: oldText was not found"),
        )
        .with_detail(json!({ "edit": index, "nearestLine": nearest_line(&view.text, old) })));
    }
    let expected = match &op.expected_matches {
        None => Some(1),
        Some(ExpectedMatches::Count(0)) => {
            return Err(FileError::invalid(
                "expectedMatches must be at least 1 or \"all\"",
            ));
        }
        Some(ExpectedMatches::Count(n)) => Some(*n as usize),
        Some(ExpectedMatches::All(word)) if word == "all" => None,
        Some(ExpectedMatches::All(_)) => {
            return Err(FileError::invalid(
                "expectedMatches must be a positive number or \"all\"",
            ));
        }
    };
    if let Some(expected) = expected
        && expected != found
    {
        let lines: Vec<usize> = matches
            .iter()
            .take(5)
            .map(|at| line_of(&view.text, *at))
            .collect();
        return Err(FileError::new(
            ErrorCode::MatchCount,
            format!("edit {index}: expected {expected} match(es), found {found}"),
        )
        .with_detail(
            json!({ "edit": index, "expected": expected, "found": found, "lines": lines }),
        ));
    }
    for at in matches {
        let range = at..at + old.len();
        if view.overlaps_span(&range) {
            return Err(FileError::new(
                ErrorCode::RedactedSpan,
                format!("edit {index}: the match touches a redacted value and cannot be edited"),
            )
            .with_detail(json!({ "edit": index, "line": line_of(&view.text, at) })));
        }
        planned.push(Planned {
            orig: view.to_orig(range.start)..view.to_orig(range.end),
            replacement: new_text.to_string(),
        });
    }
    Ok(())
}

fn plan_lines(
    view: &MaskedView,
    original: &[u8],
    start: u64,
    end: u64,
    new_text: String,
    index: usize,
) -> FileResult<Planned> {
    let total = text::count_lines(original) as u64;
    if start == 0 || end + 1 < start || start > total + 1 || end > total {
        return Err(FileError::invalid(format!(
            "edit {index}: line range {start}..{end} is outside the file ({total} lines)"
        )));
    }
    let from = line_start(original, start as usize - 1);
    let to = line_start(original, end as usize);
    let range = from..to;
    if view
        .spans
        .iter()
        .any(|span| range.start < span.orig.end && span.orig.start < range.end)
    {
        return Err(FileError::new(
            ErrorCode::RedactedSpan,
            format!("edit {index}: the line range covers a redacted value and cannot be replaced"),
        )
        .with_detail(json!({ "edit": index })));
    }
    Ok(Planned {
        orig: range,
        replacement: new_text,
    })
}

/// Byte offset of the start of 0-based line `n` (`len` past the end).
fn line_start(bytes: &[u8], n: usize) -> usize {
    if n == 0 {
        return 0;
    }
    let mut seen = 0;
    for (idx, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            seen += 1;
            if seen == n {
                return idx + 1;
            }
        }
    }
    bytes.len()
}

/// 1-based line whose start shares the longest common prefix with the first
/// line of `old` (none when nothing shares a character). No text is echoed.
fn nearest_line(haystack: &str, old: &str) -> Option<usize> {
    let first = old.lines().next().unwrap_or(old);
    let mut best: Option<(usize, usize)> = None;
    for (index, line) in haystack.lines().enumerate() {
        let common = line
            .chars()
            .zip(first.chars())
            .take_while(|(a, b)| a == b)
            .count();
        if common > 0 && best.is_none_or(|(_, len)| common > len) {
            best = Some((index + 1, common));
        }
    }
    best.map(|(line, _)| line)
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn crlf_translation_keeps_existing_crlf() {
        assert_eq!(translate_eol("a\nb\r\nc", true), "a\r\nb\r\nc");
        assert_eq!(translate_eol("a\nb", false), "a\nb");
    }

    #[test]
    fn nearest_line_uses_prefix_only() {
        let hay = "alpha\n--ctx-size 32768\nzeta\n";
        assert_eq!(nearest_line(hay, "--ctx-size 65536\nmore"), Some(2));
        assert_eq!(nearest_line(hay, "qqq"), None);
    }
}
