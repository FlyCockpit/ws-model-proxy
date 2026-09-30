//! `forwarder_cli_file_write`: create a file, or replace one wholesale.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};

use super::atomic;
use super::diff::diff_lines;
use super::error::{ErrorCode, FileError, FileResult};
use super::policy::Access;
use super::read::{current_etag, load_all};
use super::redact::{self, MASK_OPEN};
use super::resolve::{Kind, ResolveOpts, resolve};
use super::text;
use super::{Cancel, FileOps, Step, check_reason};

/// One MCP request body / relay chunk.
pub const MAX_WRITE_BYTES: usize = 1024 * 1024;
pub const DEFAULT_CREATE_MODE: u32 = 0o644;
pub const DEFAULT_PARENT_MODE: u32 = 0o755;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Encoding {
    #[default]
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "base64")]
    Base64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum IfExists {
    #[default]
    Fail,
    Replace,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteArgs {
    pub path: String,
    pub content: String,
    pub encoding: Option<Encoding>,
    pub if_exists: Option<IfExists>,
    /// Required for `ifExists: "replace"`.
    pub expected_etag: Option<String>,
    /// Octal string such as `"0755"`; create only; no setuid/setgid/sticky.
    pub mode: Option<String>,
    pub make_parents: Option<bool>,
    pub return_diff: Option<bool>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub etag: String,
    pub size: u64,
    pub created: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
}

pub(crate) fn parse_mode(mode: &str) -> FileResult<u32> {
    let digits = mode.strip_prefix("0o").unwrap_or(mode);
    if digits.is_empty() || digits.len() > 4 || !digits.chars().all(|c| ('0'..='7').contains(&c)) {
        return Err(FileError::invalid(
            "mode must be an octal string such as \"0755\"",
        ));
    }
    let value = u32::from_str_radix(digits, 8).map_err(|_| FileError::invalid("invalid mode"))?;
    if value & !0o777 != 0 {
        return Err(FileError::invalid(
            "setuid, setgid, and sticky bits cannot be set",
        ));
    }
    Ok(value)
}

pub(crate) fn decode_content(args: &WriteArgs) -> FileResult<Vec<u8>> {
    let bytes = match args.encoding.unwrap_or_default() {
        Encoding::Utf8 => args.content.clone().into_bytes(),
        Encoding::Base64 => STANDARD
            .decode(args.content.as_bytes())
            .map_err(|_| FileError::invalid("content is not valid base64"))?,
    };
    if bytes.len() > MAX_WRITE_BYTES {
        return Err(FileError::new(
            ErrorCode::TooLarge,
            "content is larger than 1 MiB",
        ));
    }
    if bytes
        .windows(MASK_OPEN.len())
        .any(|window| window == MASK_OPEN.as_bytes())
    {
        return Err(FileError::new(
            ErrorCode::RedactedSpan,
            "content contains a redaction marker; masked text cannot be written back",
        ));
    }
    Ok(bytes)
}

pub(crate) fn write(ops: &FileOps, args: &WriteArgs, cancel: &Cancel) -> FileResult<WriteResult> {
    let (content, mode, if_exists) = validate_args(args)?;
    write_validated(ops, args, &content, mode, if_exists, None, cancel)
}

pub(crate) fn write_supervised(
    ops: &FileOps,
    args: &WriteArgs,
    pin: &super::supervised::PinnedPath,
    cancel: &Cancel,
) -> FileResult<WriteResult> {
    let (content, mode, if_exists) = validate_args(args)?;
    write_validated(ops, args, &content, mode, if_exists, Some(pin), cancel)
}

pub(crate) fn validate_args(args: &WriteArgs) -> FileResult<(Vec<u8>, Option<u32>, IfExists)> {
    check_reason(&args.reason)?;
    let content = decode_content(args)?;
    let if_exists = args.if_exists.unwrap_or_default();
    let mode = args.mode.as_deref().map(parse_mode).transpose()?;
    if if_exists == IfExists::Replace {
        if args.expected_etag.is_none() {
            return Err(FileError::invalid(
                "expectedEtag is required for ifExists \"replace\"",
            ));
        }
        if mode.is_some() {
            return Err(FileError::invalid("mode applies only when creating a file"));
        }
    } else if args.expected_etag.is_some() {
        return Err(FileError::invalid(
            "expectedEtag applies only to ifExists \"replace\"",
        ));
    }

    Ok((content, mode, if_exists))
}

fn write_validated(
    ops: &FileOps,
    args: &WriteArgs,
    content: &[u8],
    mode: Option<u32>,
    if_exists: IfExists,
    pin: Option<&super::supervised::PinnedPath>,
    cancel: &Cancel,
) -> FileResult<WriteResult> {
    let _namespace = ops.namespace_shared(cancel)?;
    let mut resolved = resolve(
        &args.path,
        &ResolveOpts {
            follow_last: true,
            make_parents: args
                .make_parents
                .unwrap_or(false)
                .then_some(DEFAULT_PARENT_MODE),
            policy: &ops.policy,
            access: Access::Write,
            preview_missing: false,
            pin: pin.map(|pin| &pin.ancestor),
            cancel: Some(cancel),
        },
    )?;
    let outcome = write_resolved(
        ops,
        args,
        content,
        (mode, if_exists),
        &mut resolved,
        pin,
        cancel,
    );
    if outcome.is_err() {
        resolved.rollback_created();
    }
    outcome
}

fn write_resolved(
    ops: &FileOps,
    args: &WriteArgs,
    content: &[u8],
    create: (Option<u32>, IfExists),
    resolved: &mut super::resolve::Resolved,
    pin: Option<&super::supervised::PinnedPath>,
    cancel: &Cancel,
) -> FileResult<WriteResult> {
    let (mode, if_exists) = create;
    if resolved.is_self() {
        return Err(FileError::invalid("path names a directory"));
    }
    let full = resolved.full_path();
    let _lock = ops.lock_path(full.clone(), cancel)?;
    if let Some(pin) = pin {
        ops.step(Step::SupervisedBeforePin)?;
        pin.verify(ops, resolved, Access::Write, cancel)?;
        ops.step(Step::SupervisedPinVerified)?;
    }
    let echo = resolved.echo(&args.path);
    let existing = resolved.lstat()?;

    let Some(existing) = existing else {
        if if_exists == IfExists::Replace {
            return Err(FileError::new(
                ErrorCode::NotFound,
                "nothing to replace: the file does not exist",
            ));
        }
        ops.step(Step::EtagRechecked)?;
        if let Some(pin) = pin {
            pin.verify(ops, resolved, Access::Write, cancel)?;
        }
        cancel.check()?;
        let created = atomic::create_new(
            &resolved.dir,
            &resolved.name,
            content,
            mode.unwrap_or(DEFAULT_CREATE_MODE),
        )?;
        resolved.created.clear(); // committed: parents stay
        return Ok(WriteResult {
            etag: ops.key.strong(&created, content),
            size: content.len() as u64,
            created: true,
            added: None,
            removed: None,
            diff: None,
            resolved_path: echo,
        });
    };

    if if_exists == IfExists::Fail {
        return Err(FileError::new(ErrorCode::Exists, "the file already exists"));
    }
    if existing.kind() != Kind::File {
        return Err(FileError::new(
            if existing.kind() == Kind::Dir {
                ErrorCode::NotAFile
            } else {
                ErrorCode::SpecialFile
            },
            "path is not a regular file",
        ));
    }
    if pin.is_some() {
        ops.step(Step::SupervisedBeforeOpen)?;
    }
    let (mut file, stat) = resolved.open_regular(&ops.policy, Access::Write)?;
    // The atomic recheck binds this fd to the named object, and verify_at
    // binds that object to the preview. No early return can report success
    // before those checks on the replace path.
    let previous_etag = current_etag(ops, &mut file, &stat, cancel)?;
    if args.expected_etag.as_deref() != Some(previous_etag.as_str()) {
        return Err(FileError::conflict(&previous_etag));
    }
    let class = redact::classify(&full);
    if class.is_secret() {
        return Err(secret_refusal());
    }
    let mut before_text: Option<String> = None;
    if stat.size <= super::etag::STRONG_ETAG_MAX_BYTES {
        use std::io::Seek;
        file.rewind()?;
        let bytes = load_all(&mut file, &stat, super::etag::STRONG_ETAG_MAX_BYTES, cancel)?;
        if text::sniff_binary(&bytes).is_none()
            && let Ok(text) = String::from_utf8(bytes)
        {
            if redact::mask(class, &text).redactions() > 0 {
                return Err(secret_refusal());
            }
            before_text = Some(text);
        }
    }
    atomic::check_replaceable(ops, &stat)?;
    cancel.check()?;
    let new_stat = match pin {
        Some(pin) => atomic::replace_supervised(
            ops,
            &resolved.dir,
            &resolved.name,
            &mut file,
            &stat,
            &previous_etag,
            content,
            pin,
            cancel,
        )?,
        None => atomic::replace(
            ops,
            &resolved.dir,
            &resolved.name,
            &mut file,
            &stat,
            &previous_etag,
            content,
            cancel,
        )?,
    };

    let mut result = WriteResult {
        etag: ops.key.strong(&new_stat, content),
        size: content.len() as u64,
        created: false,
        added: None,
        removed: None,
        diff: None,
        resolved_path: echo,
    };
    if args.return_diff.unwrap_or(false)
        && let (Some(before), Ok(after)) = (before_text, std::str::from_utf8(content))
    {
        let summary = diff_lines(
            &redact::mask(class, &before).text,
            &redact::mask(class, after).text,
        );
        result.added = Some(summary.added);
        result.removed = Some(summary.removed);
        result.diff = Some(summary.diff);
    }
    Ok(result)
}

fn secret_refusal() -> FileError {
    FileError::new(
        ErrorCode::SecretFile,
        "the file holds secret values that are not shown; replacing it would destroy them (use file_edit)",
    )
}
