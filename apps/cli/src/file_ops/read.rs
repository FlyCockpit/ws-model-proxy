//! `forwarder_cli_file_read`: bounded, line-numbered, masked windows.
//!
//! The file is masked line by line as it is returned (only the returned window
//! plus one line of context, or the whole file for `.pem`/`.key` files), so a
//! secret is always masked whole and reading a plain file costs one cheap
//! trigger-substring check per returned line.

use std::io::{BufRead, BufReader, Read};
use std::os::unix::fs::FileExt;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::error::{ErrorCode, FileError, FileResult};
use super::etag::STRONG_ETAG_MAX_BYTES;
use super::policy::Access;
use super::redact::{self, FileClass, LineMasker};
use super::resolve::{ResolveOpts, Stat, resolve};
use super::text::{self, Eol, SNIFF_BYTES, floor_boundary, strip_eol};
use super::{Cancel, FileOps, fmt};

pub const DEFAULT_MAX_LINES: u32 = 400;
pub const MAX_LINES: u32 = 2000;
pub const DEFAULT_MAX_BYTES: u32 = 32 * 1024;
pub const MAX_BYTES: u32 = 128 * 1024;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadArgs {
    pub path: String,
    /// 1-based; negative counts from the end (-200 = the last 200 lines).
    pub start_line: Option<i64>,
    pub max_lines: Option<u32>,
    pub max_bytes: Option<u32>,
    /// Continue inside one very long line (bytes of the masked line).
    pub byte_offset: Option<u64>,
    pub line_numbers: Option<bool>,
    pub if_none_match: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct More {
    pub start_line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_offset: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ReadOutcome {
    Unchanged { unchanged: bool, etag: String },
    Content(Box<ReadResult>),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub etag: String,
    pub size: u64,
    pub mtime: String,
    pub mode: String,
    /// `null` when the file is over 64 MiB (not scanned).
    pub total_lines: Option<u64>,
    /// `null` for a tail window of a file over 64 MiB (line numbers unknown).
    pub start_line: Option<u64>,
    pub end_line: Option<u64>,
    pub eol: Eol,
    pub text: String,
    pub redactions: u64,
    pub more: Option<More>,
    pub secret_file: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
}

/// Rows of a served window.
pub(crate) struct Window {
    pub text: String,
    pub start_line: u64,
    pub end_line: u64,
    pub more: Option<More>,
    pub redactions: u64,
}

pub(crate) struct WindowOpts {
    pub start_line: u64,
    pub max_lines: usize,
    pub max_bytes: usize,
    pub byte_offset: Option<u64>,
    pub numbers: bool,
}

pub(crate) fn binary_error(sniff: &str, size: u64, etag: &str) -> FileError {
    FileError::new(ErrorCode::BinaryFile, "file is not text")
        .with_detail(json!({ "size": size, "etag": etag, "sniff": sniff }))
}

pub(crate) fn clamp_window(args: &ReadArgs) -> FileResult<(usize, usize)> {
    let lines = args.max_lines.unwrap_or(DEFAULT_MAX_LINES);
    let bytes = args.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    if lines == 0 || bytes == 0 {
        return Err(FileError::invalid(
            "maxLines and maxBytes must be at least 1",
        ));
    }
    Ok((lines.min(MAX_LINES) as usize, bytes.min(MAX_BYTES) as usize))
}

/// Read the whole file (at most `max` bytes) from an open fd.
pub(crate) fn load_all(file: &mut std::fs::File, stat: &Stat, max: u64) -> FileResult<Vec<u8>> {
    if stat.size > max {
        return Err(FileError::new(
            ErrorCode::TooLarge,
            format!("file is larger than {max} bytes"),
        ));
    }
    let mut bytes = Vec::with_capacity(stat.size as usize);
    file.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(FileError::new(
            ErrorCode::TooLarge,
            format!("file is larger than {max} bytes"),
        ));
    }
    Ok(bytes)
}

/// The current etag of an open regular file: strong up to 64 MiB, weak above.
pub(crate) fn current_etag(
    ops: &FileOps,
    file: &mut std::fs::File,
    stat: &Stat,
) -> FileResult<String> {
    if stat.size > STRONG_ETAG_MAX_BYTES {
        return Ok(ops.key.weak_stat(stat));
    }
    let bytes = load_all(file, stat, STRONG_ETAG_MAX_BYTES)?;
    Ok(ops.key.strong(&bytes))
}

pub fn read(ops: &FileOps, args: &ReadArgs, cancel: &Cancel) -> FileResult<ReadOutcome> {
    let (max_lines, max_bytes) = clamp_window(args)?;
    let start = args.start_line.unwrap_or(1);
    if start == 0 {
        return Err(FileError::invalid(
            "startLine is 1-based; use a negative value to read from the end",
        ));
    }
    let resolved = resolve(
        &args.path,
        &ResolveOpts {
            follow_last: true,
            make_parents: None,
            policy: &ops.policy,
            access: Access::Read,
        },
    )?;
    let (mut file, stat) = resolved.open_regular(&ops.policy, Access::Read)?;
    let full = resolved.full_path();
    let class = redact::classify(&full);
    let echo = resolved.echo(&args.path);
    let numbers = args.line_numbers.unwrap_or(true);
    let opts_for = |start_line: u64| WindowOpts {
        start_line,
        max_lines,
        max_bytes,
        byte_offset: args.byte_offset,
        numbers,
    };

    if stat.size > STRONG_ETAG_MAX_BYTES {
        return read_large(
            ops, args, &mut file, &stat, class, echo, start, &opts_for, max_lines, max_bytes,
        );
    }

    let bytes = load_all(&mut file, &stat, STRONG_ETAG_MAX_BYTES)?;
    cancel.check()?;
    let etag = ops.key.strong(&bytes);
    if args.if_none_match.as_deref() == Some(etag.as_str()) {
        return Ok(ReadOutcome::Unchanged {
            unchanged: true,
            etag,
        });
    }
    if let Some(kind) = text::sniff_binary(&bytes) {
        return Err(binary_error(kind, stat.size, &etag));
    }
    let total = text::count_lines(&bytes) as u64;
    let first = if start > 0 {
        start as u64
    } else {
        total.saturating_sub(start.unsigned_abs() - 1).max(1)
    };
    let offset = line_offset(&bytes, first.saturating_sub(1) as usize);
    // A `.pem`/`KEY` block or a dotenv quoted value opened before the window
    // masks every following line, so the masker must see the whole prefix (both
    // classes are small enough for the in-memory path; `read_large` refuses
    // them above the scan cap). Other classes need one line of context before
    // the window for the flag-continuation rule.
    let context_from = if class.needs_prefix() {
        0
    } else {
        prev_line_start(&bytes, offset)
    };
    let mut masker = LineMasker::new(class);
    if offset > 0 {
        let context = &bytes[context_from..offset];
        for raw in context.split_inclusive(|b| *b == b'\n') {
            if let Ok(line) = std::str::from_utf8(strip_eol(raw)) {
                let _ = masker.scan(line);
            }
        }
    }
    let mut lines = bytes[offset..]
        .split_inclusive(|b| *b == b'\n')
        .map(|raw| Ok(raw.to_vec()));
    let window = assemble(&mut masker, &mut lines, &opts_for(first), &etag, stat.size)?;
    Ok(ReadOutcome::Content(Box::new(ReadResult {
        etag,
        size: stat.size,
        mtime: fmt::rfc3339(stat.mtime()),
        mode: fmt::mode_string(stat.mode),
        total_lines: Some(total),
        start_line: Some(window.start_line),
        end_line: Some(window.end_line),
        eol: text::detect_eol(&bytes),
        text: window.text,
        redactions: window.redactions,
        more: window.more,
        secret_file: class.is_secret(),
        resolved_path: echo,
    })))
}

/// Byte offset of the start of 0-based line `n` (`bytes.len()` past the end).
fn line_offset(bytes: &[u8], n: usize) -> usize {
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

/// Start of the line before the one starting at `offset` (`0` when none).
fn prev_line_start(bytes: &[u8], offset: usize) -> usize {
    if offset == 0 {
        return 0;
    }
    bytes[..offset - 1]
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(0, |idx| idx + 1)
}

/// Build a window from raw lines (with terminators), masking each line.
pub(crate) fn assemble(
    masker: &mut LineMasker,
    lines: &mut dyn Iterator<Item = FileResult<Vec<u8>>>,
    opts: &WindowOpts,
    etag: &str,
    size: u64,
) -> FileResult<Window> {
    let mut out = String::new();
    let mut emitted = 0_usize;
    let mut number = opts.start_line;
    let mut end_line = opts.start_line.saturating_sub(1);
    let mut more = None;
    let mut redactions = 0_u64;
    let mut pending = lines.next().transpose()?;
    while let Some(raw) = pending.take() {
        if emitted >= opts.max_lines {
            more = Some(More {
                start_line: number,
                byte_offset: None,
            });
            break;
        }
        let body = std::str::from_utf8(strip_eol(&raw))
            .map_err(|_| binary_error("unknown", size, etag))?;
        let (masked, count) = masker.mask_line_counted(body);
        let mut slice: &str = &masked;
        let mut consumed = 0_usize;
        if emitted == 0
            && let Some(offset) = opts.byte_offset
        {
            let offset = offset as usize;
            if offset > masked.len() || !masked.is_char_boundary(offset) {
                return Err(FileError::invalid(
                    "byteOffset is not a character boundary inside the line",
                ));
            }
            consumed = offset;
            slice = &masked[offset..];
        }
        let prefix = if opts.numbers {
            format!("{number}|")
        } else {
            String::new()
        };
        let separator = usize::from(!out.is_empty());
        if out.len() + separator + prefix.len() + slice.len() > opts.max_bytes {
            if emitted == 0 {
                let room = opts.max_bytes.saturating_sub(prefix.len());
                let mut cut = floor_boundary(slice, room);
                if cut == 0
                    && let Some(first) = slice.chars().next()
                {
                    cut = first.len_utf8();
                }
                out.push_str(&prefix);
                out.push_str(&slice[..cut]);
                redactions += count as u64;
                end_line = number;
                more = Some(More {
                    start_line: number,
                    byte_offset: Some((consumed + cut) as u64),
                });
            } else {
                more = Some(More {
                    start_line: number,
                    byte_offset: None,
                });
            }
            break;
        }
        if separator == 1 {
            out.push('\n');
        }
        out.push_str(&prefix);
        out.push_str(slice);
        redactions += count as u64;
        emitted += 1;
        end_line = number;
        number += 1;
        pending = lines.next().transpose()?;
    }
    if let Some(more) = &more {
        out.push_str("\n…[truncated: call again with ");
        out.push_str(&format!("startLine={}", more.start_line));
        if let Some(offset) = more.byte_offset {
            out.push_str(&format!(" byteOffset={offset}"));
        }
        out.push(']');
    }
    Ok(Window {
        text: out,
        start_line: opts.start_line,
        end_line,
        more,
        redactions,
    })
}

/// Files over 64 MiB: weak etag, no line count, no whole-file scan.
#[allow(clippy::too_many_arguments)]
fn read_large(
    ops: &FileOps,
    args: &ReadArgs,
    file: &mut std::fs::File,
    stat: &Stat,
    class: FileClass,
    echo: Option<String>,
    start: i64,
    opts_for: &dyn Fn(u64) -> WindowOpts,
    max_lines: usize,
    max_bytes: usize,
) -> FileResult<ReadOutcome> {
    let etag = ops.key.weak(&file.metadata()?);
    if args.if_none_match.as_deref() == Some(etag.as_str()) {
        return Ok(ReadOutcome::Unchanged {
            unchanged: true,
            etag,
        });
    }
    if class.needs_full_scan() {
        return Err(FileError::new(
            ErrorCode::TooLarge,
            "secret-class files over 64 MiB cannot be read (masking needs a full scan)",
        ));
    }
    let mut head = vec![0_u8; SNIFF_BYTES];
    let got = file.read_at(&mut head, 0)?;
    if let Some(kind) = text::sniff_binary(&head[..got]) {
        return Err(binary_error(kind, stat.size, &etag));
    }

    let mut masker = LineMasker::new(class);
    let (window, eol) = if start < 0 {
        tail_window(
            file,
            stat,
            &mut masker,
            start.unsigned_abs() as usize,
            max_lines,
            max_bytes,
            &etag,
        )?
    } else {
        let first = start as u64;
        let mut reader = BufReader::with_capacity(1 << 20, &mut *file);
        let mut scanned = 0_u64;
        // Feed the masker every line before the window for a class whose masking
        // can span lines; otherwise the last line is the one line of context the
        // flag-continuation rule needs.
        let context_prefix = class.needs_prefix();
        let mut context: Vec<u8> = Vec::new();
        for _ in 1..first {
            let mut buf = Vec::new();
            let n = reader.read_until(b'\n', &mut buf)?;
            if n == 0 {
                break;
            }
            scanned += n as u64;
            if scanned > STRONG_ETAG_MAX_BYTES {
                return Err(FileError::new(
                    ErrorCode::TooLarge,
                    "startLine is more than 64 MiB into the file; use a negative startLine to read the end",
                ));
            }
            if context_prefix {
                if let Ok(line) = std::str::from_utf8(strip_eol(&buf)) {
                    let _ = masker.scan(line);
                }
            } else {
                context = buf;
            }
        }
        if !context_prefix && let Ok(line) = std::str::from_utf8(strip_eol(&context)) {
            let _ = masker.scan(line);
        }
        let mut lines = std::iter::from_fn(|| {
            let mut buf = Vec::new();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => None,
                Ok(_) => Some(Ok(buf)),
                Err(err) => Some(Err(FileError::io(&err))),
            }
        });
        let window = assemble(&mut masker, &mut lines, &opts_for(first), &etag, stat.size)?;
        let eol = text::detect_eol(window.text.as_bytes());
        (window, eol)
    };
    Ok(ReadOutcome::Content(Box::new(ReadResult {
        etag,
        size: stat.size,
        mtime: fmt::rfc3339(stat.mtime()),
        mode: fmt::mode_string(stat.mode),
        total_lines: None,
        start_line: (start > 0).then_some(window.start_line),
        end_line: (start > 0).then_some(window.end_line),
        eol,
        text: window.text,
        redactions: window.redactions,
        more: window.more,
        secret_file: class.is_secret(),
        resolved_path: echo,
    })))
}

/// The last `count` lines of a huge file, without line numbers.
fn tail_window(
    file: &std::fs::File,
    stat: &Stat,
    masker: &mut LineMasker,
    count: usize,
    max_lines: usize,
    max_bytes: usize,
    etag: &str,
) -> FileResult<(Window, Eol)> {
    let chunk_len = ((max_bytes as u64) * 2 + 64 * 1024).min(stat.size);
    let mut chunk = vec![0_u8; chunk_len as usize];
    file.read_exact_at(&mut chunk, stat.size - chunk_len)?;
    let mut raw_lines: Vec<&[u8]> = chunk.split_inclusive(|b| *b == b'\n').collect();
    if chunk_len < stat.size && !raw_lines.is_empty() {
        raw_lines.remove(0); // a partial first line is unusable
    }
    let want = count.min(max_lines).min(raw_lines.len());
    if want == 0 {
        return Err(FileError::new(
            ErrorCode::TooLarge,
            "the last line is longer than the read window; read it with a positive startLine",
        ));
    }
    let first_index = raw_lines.len() - want;
    if first_index > 0
        && let Ok(line) = std::str::from_utf8(strip_eol(raw_lines[first_index - 1]))
    {
        let _ = masker.scan(line);
    }
    let mut masked: Vec<String> = Vec::with_capacity(want);
    let mut redactions: Vec<u64> = Vec::with_capacity(want);
    for raw in &raw_lines[first_index..] {
        let body = std::str::from_utf8(strip_eol(raw))
            .map_err(|_| binary_error("unknown", stat.size, etag))?;
        let (line, count) = masker.mask_line_counted(body);
        masked.push(line.into_owned());
        redactions.push(count as u64);
    }
    let mut total: usize = masked
        .iter()
        .map(|l| l.len() + 1)
        .sum::<usize>()
        .saturating_sub(1);
    let mut drop = 0;
    while total > max_bytes && drop + 1 < masked.len() {
        total -= masked[drop].len() + 1;
        drop += 1;
    }
    if total > max_bytes {
        return Err(FileError::new(
            ErrorCode::TooLarge,
            "the last line is longer than the read window; read it with a positive startLine",
        ));
    }
    let eol = text::detect_eol(&chunk);
    Ok((
        Window {
            text: masked[drop..].join("\n"),
            start_line: 0,
            end_line: 0,
            more: None,
            redactions: redactions[drop..].iter().sum(),
        },
        eol,
    ))
}
