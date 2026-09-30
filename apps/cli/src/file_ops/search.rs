//! `forwarder_cli_file_search`: literal or regex search under a root.
//!
//! Matching runs on the **masked** text of each file, so a search can neither
//! return nor probe a secret. Secret-class files (`redact::classify`) are skipped
//! entirely (issue 19), like binary files and files over [`MAX_FILE_BYTES`]. Uses
//! the `regex` crate (linear time, no backreferences) over an fd-based walk that
//! never follows symlinks.

use std::io::Read;
use std::time::Instant;

use regex::RegexBuilder;
use serde::{Deserialize, Serialize};

use super::error::{FileError, FileResult};
use super::glob::Glob;
use super::policy::Access;
use super::redact;
use super::resolve::{Kind, ResolveOpts, resolve};
use super::text::{self, floor_boundary, name_for_display, strip_eol};
use super::walk::{Entry, Flow, walk};
use super::{Cancel, FileOps};

pub const DEFAULT_MATCHES: u32 = 100;
pub const MAX_MATCHES: u32 = 500;
pub const DEFAULT_MAX_FILES: u32 = 20_000;
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_PATTERN_BYTES: usize = 1024;
pub const MAX_LINE_BYTES: usize = 1000;
/// Output cap so a result always fits one relay control frame.
pub const MAX_OUTPUT_BYTES: usize = 48 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    #[default]
    Literal,
    Regex,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchArgs {
    pub root: String,
    pub pattern: String,
    pub mode: Option<SearchMode>,
    pub glob: Option<String>,
    pub case_insensitive: Option<bool>,
    /// 0..3
    pub context_lines: Option<u32>,
    pub max_matches: Option<u32>,
    pub max_files: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchMore {
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// `path:line|text` per match; context lines use `path-line|text`, and
    /// non-adjacent groups are separated by `--`.
    pub matches: String,
    pub files: usize,
    pub count: usize,
    pub scanned_files: usize,
    pub more: Option<SearchMore>,
}

pub(crate) fn search(
    ops: &FileOps,
    args: &SearchArgs,
    cancel: &Cancel,
) -> FileResult<SearchResult> {
    if args.pattern.is_empty() || args.pattern.len() > MAX_PATTERN_BYTES {
        return Err(FileError::invalid("pattern must be 1 to 1024 bytes"));
    }
    let source = match args.mode.unwrap_or_default() {
        SearchMode::Literal => regex::escape(&args.pattern),
        SearchMode::Regex => args.pattern.clone(),
    };
    let re = RegexBuilder::new(&source)
        .case_insensitive(args.case_insensitive.unwrap_or(false))
        .size_limit(2 * 1024 * 1024)
        .dfa_size_limit(4 * 1024 * 1024)
        .build()
        .map_err(|err| {
            FileError::invalid(format!(
                "invalid pattern: {}",
                err.to_string().lines().last().unwrap_or("regex error")
            ))
        })?;
    let glob = args
        .glob
        .as_deref()
        .map(Glob::new)
        .transpose()
        .map_err(FileError::invalid)?;
    let context = args.context_lines.unwrap_or(0).min(3) as usize;
    let max_matches = args
        .max_matches
        .unwrap_or(DEFAULT_MATCHES)
        .clamp(1, MAX_MATCHES) as usize;
    let max_files = args
        .max_files
        .unwrap_or(DEFAULT_MAX_FILES)
        .clamp(1, DEFAULT_MAX_FILES) as usize;

    let resolved = resolve(
        &args.root,
        &ResolveOpts {
            follow_last: true,
            make_parents: None,
            policy: &ops.policy,
            access: Access::Read,
            preview_missing: false,
            pin: None,
            cancel: None,
        },
    )?;
    let started = Instant::now();
    let deadline = ops.limits.search_deadline;
    let prefix = name_for_display(args.root.trim_end_matches('/'));

    let mut state = State {
        out: String::new(),
        count: 0,
        files: 0,
        scanned: 0,
        note: None,
    };

    let scan_file = |state: &mut State, entry: &Entry<'_>, shown: &str| -> FileResult<()> {
        let opened = super::resolve::Resolved {
            dir: entry.parent.try_clone()?,
            dir_path: entry
                .full
                .parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or_default(),
            name: entry.name.into(),
            created: Vec::new(),
            missing_suffix: Vec::new(),
        };
        let Ok((mut file, stat)) = opened.open_regular(&ops.policy, Access::Read) else {
            return Ok(());
        };
        if stat.size > MAX_FILE_BYTES {
            return Ok(());
        }
        let mut bytes = Vec::with_capacity(stat.size as usize);
        if file
            .by_ref()
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return Ok(());
        }
        state.scanned += 1;
        if text::sniff_binary(&bytes).is_some() {
            return Ok(());
        }
        let Ok(content) = std::str::from_utf8(&bytes) else {
            return Ok(());
        };
        let class = redact::classify(entry.full);
        if class.is_secret() {
            // Secret-class files are skipped (issue 19/AC19): a match would
            // reveal key names and masked-value lengths, and the tool must not
            // scan a file it would refuse to serve.
            return Ok(());
        }
        let view = redact::mask(class, content);
        let lines: Vec<&str> = view
            .text
            .split_inclusive('\n')
            .map(|l| std::str::from_utf8(strip_eol(l.as_bytes())).unwrap_or(l))
            .collect();
        let mut emitted_through: Option<usize> = None; // last line index printed
        let mut file_hit = false;
        for (index, line) in lines.iter().enumerate() {
            if !re.is_match(line) {
                continue;
            }
            file_hit = true;
            if state.count >= max_matches {
                state.note = Some(format!(
                    "more matches exist beyond {max_matches}; narrow root or glob"
                ));
                return Ok(());
            }
            let from = index.saturating_sub(context);
            let from = emitted_through.map_or(from, |last| from.max(last + 1));
            let to = (index + context).min(lines.len().saturating_sub(1));
            let needs_separator = context > 0
                && match emitted_through {
                    Some(last) => from > last + 1,
                    None => !state.out.is_empty(),
                };
            if needs_separator {
                state.out.push_str("--\n");
            }
            for (i, text) in lines.iter().enumerate().take(to + 1).skip(from) {
                let sep = if i == index { ':' } else { '-' };
                let shown_line = &text[..floor_boundary(text, MAX_LINE_BYTES)];
                let clipped = if shown_line.len() < text.len() {
                    "…"
                } else {
                    ""
                };
                state
                    .out
                    .push_str(&format!("{shown}{sep}{}|{shown_line}{clipped}\n", i + 1));
            }
            emitted_through = Some(to);
            state.count += 1;
            if state.out.len() > MAX_OUTPUT_BYTES {
                state.note = Some("output limit reached; narrow root or glob".to_string());
                return Ok(());
            }
        }
        if file_hit {
            state.files += 1;
        }
        Ok(())
    };

    let single_file = if resolved.is_self() {
        None
    } else {
        resolved.lstat()?
    };
    if let Some(st) = single_file.filter(|st| st.kind() == Kind::File) {
        // A single file: scan it through a synthetic entry.
        let full = resolved.full_path();
        let name = resolved.name.to_string_lossy().to_string();
        let entry = Entry {
            name: &name,
            rel: &name,
            kind: Kind::File,
            stat: st,
            parent: &resolved.dir,
            full: &full,
            depth: 1,
        };
        scan_file(&mut state, &entry, &prefix)?;
    } else {
        let root = resolved.open_dir()?;
        let root_path = resolved.full_path();
        let mut visit = |entry: &Entry<'_>| -> FileResult<Flow> {
            cancel.check()?;
            if started.elapsed() > deadline {
                state.note = Some("search time budget reached; narrow root or glob".to_string());
                return Ok(Flow::Stop);
            }
            if entry.kind != Kind::File {
                return Ok(Flow::Continue);
            }
            if let Some(glob) = &glob
                && !glob.matches(entry.name, entry.rel)
            {
                return Ok(Flow::Continue);
            }
            if ops.policy.hidden_from_walk(entry.full) {
                return Ok(Flow::Continue);
            }
            if state.scanned >= max_files {
                state.note = Some(format!(
                    "file limit of {max_files} reached; narrow root or glob"
                ));
                return Ok(Flow::Stop);
            }
            let shown = format!("{prefix}/{}", name_for_display(entry.rel));
            scan_file(&mut state, entry, &shown)?;
            Ok(if state.note.is_some() {
                Flow::Stop
            } else {
                Flow::Continue
            })
        };
        walk(&ops.policy, &root, &root_path, 64, &mut visit)?;
    }
    if state.out.ends_with('\n') {
        state.out.pop();
    }
    Ok(SearchResult {
        matches: state.out,
        files: state.files,
        count: state.count,
        scanned_files: state.scanned,
        more: state.note.map(|note| SearchMore { note }),
    })
}

struct State {
    out: String,
    count: usize,
    files: usize,
    scanned: usize,
    note: Option<String>,
}
