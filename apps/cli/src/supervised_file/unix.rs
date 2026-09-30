//! Unix implementation of the authoritative local-disk file preview.
//!
//! The daemon supplies strict normalized arguments, a private write-body path,
//! and a per-request preview key. This child reopens the real filesystem and
//! independently computes the masked preview. It never invokes a mutating file
//! operation: Enter only emits `accepted` and waits for the daemon's `go`.

use std::fs::File;
use std::io::Read;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use anyhow::{Context, Result};
use nix::fcntl::{AtFlags, OFlag, openat};
use nix::sys::stat::{Mode, SFlag, fstat, fstatat};
use nix::unistd::{UnlinkatFlags, unlinkat};
use serde_json::Value;

use crate::file_ops::{ErrorCode, EtagKey, SupervisedPreview, preview_supervised_child};
use crate::sessions::{
    SUPERVISED_ENV_FILE_ALLOW_ROOT, SUPERVISED_ENV_FILE_ARGS, SUPERVISED_ENV_FILE_BLOCKED,
    SUPERVISED_ENV_FILE_BODY, SUPERVISED_ENV_FILE_ETAG_KEY, SUPERVISED_ENV_FILE_OP,
    SUPERVISED_ENV_FILE_PREIMAGE, SUPERVISED_ENV_MARKER, SUPERVISED_ENV_REQUESTER,
};
use crate::supervised_run::{field, wrap_words};
use crate::supervised_screen::{ConfirmAction, ConfirmOutcome, Screen, interact};

const MAX_ENV_BYTES: usize = 128 * 1024;
const MAX_BODY_BYTES: u64 = 1024 * 1024;
const APPLY_PROMPT: &str = "Ctrl-C, Ctrl-D or q to decline · Enter to apply";
const DISMISS_PROMPT: &str = "Enter, Ctrl-C, Ctrl-D or q to dismiss";

#[derive(Debug)]
struct ChildInput {
    op: String,
    args: Value,
    body: Option<Vec<u8>>,
    key: EtagKey,
    preimage: String,
    requester: String,
    marker: String,
    allow_root: bool,
    blocked: Option<ErrorCode>,
}

#[derive(Debug)]
enum Display {
    Allowed {
        operation: String,
        paths: Vec<(String, String)>,
        description: Vec<String>,
        diff: Vec<String>,
    },
    Blocked {
        code: String,
        operation: String,
        paths: Vec<String>,
    },
}

fn env_value(name: &str, required: bool) -> Result<Option<String>> {
    let value = match std::env::var(name) {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) if !required => return Ok(None),
        Err(std::env::VarError::NotPresent) => {
            anyhow::bail!("`{name}` is not set; supervised-file is daemon-only")
        }
        Err(std::env::VarError::NotUnicode(_)) => {
            anyhow::bail!("`{name}` is not valid UTF-8")
        }
    };
    if value.len() > MAX_ENV_BYTES {
        anyhow::bail!("`{name}` is larger than 128 KiB")
    }
    Ok(Some(value))
}

fn required_env(name: &str) -> Result<String> {
    env_value(name, true)?.ok_or_else(|| anyhow::anyhow!("`{name}` is not set"))
}

fn lower_hex<const N: usize>(name: &str, value: &str) -> Result<[u8; N]> {
    if value.len() != N * 2
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        anyhow::bail!(
            "`{name}` must be exactly {} lowercase hex characters",
            N * 2
        )
    }
    let mut out = [0_u8; N];
    for (index, byte) in out.iter_mut().enumerate() {
        let pair = &value[index * 2..index * 2 + 2];
        *byte = u8::from_str_radix(pair, 16).context("decoding supervised preview key")?;
    }
    Ok(out)
}

fn same_object(left: &nix::sys::stat::FileStat, right: &nix::sys::stat::FileStat) -> bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino
}

fn error_code(value: &str) -> Option<ErrorCode> {
    Some(match value {
        "path_denied" => ErrorCode::PathDenied,
        "secret_file" => ErrorCode::SecretFile,
        "not_found" => ErrorCode::NotFound,
        "not_a_file" => ErrorCode::NotAFile,
        "not_a_dir" => ErrorCode::NotADir,
        "binary_file" => ErrorCode::BinaryFile,
        "too_large" => ErrorCode::TooLarge,
        "conflict" => ErrorCode::Conflict,
        "match_count" => ErrorCode::MatchCount,
        "no_match" => ErrorCode::NoMatch,
        "redacted_span" => ErrorCode::RedactedSpan,
        "exists" => ErrorCode::Exists,
        "hard_linked" => ErrorCode::HardLinked,
        "owner_mismatch" => ErrorCode::OwnerMismatch,
        "setuid" => ErrorCode::Setuid,
        "special_file" => ErrorCode::SpecialFile,
        "io_error" => ErrorCode::IoError,
        "timeout" => ErrorCode::Timeout,
        "invalid_input" => ErrorCode::InvalidInput,
        "unsupported" => ErrorCode::Unsupported,
        "cancelled" => ErrorCode::Cancelled,
        "limit" => ErrorCode::Limit,
        _ => return None,
    })
}

/// Open a registry-created body without following names, validate its
/// ownership/mode/type/link/size, unlink that exact name, then read it.
pub(crate) fn read_private_body(path: &Path) -> Result<Vec<u8>> {
    read_private_body_with(path, || Ok(()))
}

fn read_private_body_with(path: &Path, after_stat: impl FnOnce() -> Result<()>) -> Result<Vec<u8>> {
    if !path.is_absolute() {
        anyhow::bail!("supervised write body path is not absolute")
    }
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("supervised write body has no parent"))?;
    let name = path
        .file_name()
        .filter(|name| !name.as_bytes().is_empty())
        .ok_or_else(|| anyhow::anyhow!("supervised write body has no file name"))?;
    let parent_fd: OwnedFd = openat(
        nix::fcntl::AT_FDCWD,
        parent,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .context("opening supervised write body directory")?;
    let parent_stat = fstat(&parent_fd).context("checking supervised write body directory")?;
    if parent_stat.st_uid != nix::unistd::geteuid().as_raw()
        || parent_stat.st_mode & 0o7777 != 0o700
    {
        anyhow::bail!("supervised write body directory is not private")
    }

    let fd: OwnedFd = openat(
        parent_fd.as_fd(),
        name,
        OFlag::O_RDONLY | OFlag::O_NONBLOCK | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .context("opening supervised write body")?;
    let stat = fstat(&fd).context("checking supervised write body")?;
    if SFlag::from_bits_truncate(stat.st_mode) != SFlag::S_IFREG {
        anyhow::bail!("supervised write body is not a regular file")
    }
    if stat.st_nlink != 1 {
        anyhow::bail!("supervised write body has more than one link")
    }
    if stat.st_uid != nix::unistd::geteuid().as_raw() {
        anyhow::bail!("supervised write body has the wrong owner")
    }
    if stat.st_mode & 0o7777 != 0o600 {
        anyhow::bail!("supervised write body mode is not 0600")
    }
    if stat.st_size < 0 || stat.st_size as u64 > MAX_BODY_BYTES {
        anyhow::bail!("supervised write body is larger than 1 MiB")
    }
    after_stat()?;
    let named = fstatat(parent_fd.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW)
        .context("rechecking supervised write body name")?;
    if !same_object(&stat, &named) {
        anyhow::bail!("supervised write body changed before it was opened")
    }
    unlinkat(parent_fd.as_fd(), name, UnlinkatFlags::NoRemoveDir)
        .context("unlinking supervised write body")?;

    let mut file = File::from(fd);
    let mut body = Vec::with_capacity(usize::try_from(stat.st_size).unwrap_or(0));
    Read::by_ref(&mut file)
        .take(MAX_BODY_BYTES + 1)
        .read_to_end(&mut body)
        .context("reading supervised write body")?;
    if body.len() as u64 > MAX_BODY_BYTES {
        anyhow::bail!("supervised write body grew larger than 1 MiB")
    }
    Ok(body)
}

fn load() -> Result<ChildInput> {
    let op = required_env(SUPERVISED_ENV_FILE_OP)?;
    if !matches!(
        op.as_str(),
        "edit" | "write" | "rename" | "mkdir" | "delete"
    ) {
        anyhow::bail!("`{SUPERVISED_ENV_FILE_OP}` is not a supported mutating operation")
    }
    let raw_args = required_env(SUPERVISED_ENV_FILE_ARGS)?;
    let args: Value = serde_json::from_str(&raw_args).context("parsing supervised file args")?;
    if !args.is_object() {
        anyhow::bail!("`{SUPERVISED_ENV_FILE_ARGS}` must be a JSON object")
    }
    let body_path = env_value(SUPERVISED_ENV_FILE_BODY, false)?;
    let body = match (op.as_str(), body_path) {
        ("write", Some(path)) => Some(read_private_body(Path::new(&path))?),
        ("write", None) => anyhow::bail!("supervised write body path is missing"),
        (_, Some(_)) => anyhow::bail!("only supervised write accepts a body"),
        (_, None) => None,
    };
    let key_hex = required_env(SUPERVISED_ENV_FILE_ETAG_KEY)?;
    let key = EtagKey::from_bytes(lower_hex(SUPERVISED_ENV_FILE_ETAG_KEY, &key_hex)?);
    let preimage = required_env(SUPERVISED_ENV_FILE_PREIMAGE)?;
    if preimage.is_empty() || !preimage.bytes().all(|byte| byte.is_ascii_graphic()) {
        anyhow::bail!("`{SUPERVISED_ENV_FILE_PREIMAGE}` is malformed")
    }
    let requester = required_env(SUPERVISED_ENV_REQUESTER)?;
    if requester.chars().count() > 100 || requester.contains('\0') {
        anyhow::bail!("`{SUPERVISED_ENV_REQUESTER}` is malformed")
    }
    let marker = required_env(SUPERVISED_ENV_MARKER)?;
    let _: [u8; 16] = lower_hex(SUPERVISED_ENV_MARKER, &marker)?;
    let allow_root = match required_env(SUPERVISED_ENV_FILE_ALLOW_ROOT)?.as_str() {
        "0" => false,
        "1" => true,
        _ => anyhow::bail!("`{SUPERVISED_ENV_FILE_ALLOW_ROOT}` must be `0` or `1`"),
    };
    let blocked = env_value(SUPERVISED_ENV_FILE_BLOCKED, false)?
        .map(|value| {
            error_code(&value)
                .ok_or_else(|| anyhow::anyhow!("`{SUPERVISED_ENV_FILE_BLOCKED}` is malformed"))
        })
        .transpose()?;
    Ok(ChildInput {
        op,
        args,
        body,
        key,
        preimage,
        requester,
        marker,
        allow_root,
        blocked,
    })
}

fn reason(args: &Value) -> Result<&str> {
    match args.get("reason") {
        None | Some(Value::Null) => Ok(""),
        Some(Value::String(reason)) if reason.chars().count() <= 500 => Ok(reason),
        Some(Value::String(_)) => anyhow::bail!("file reason is longer than 500 characters"),
        Some(_) => anyhow::bail!("file reason is not a string"),
    }
}

fn fallback_paths(args: &Value) -> Vec<String> {
    ["path", "from", "to"]
        .iter()
        .filter_map(|name| args.get(name).and_then(Value::as_str).map(str::to_owned))
        .collect()
}

fn body_rows(display: &Display, requester: &str, reason: &str, width: usize) -> Vec<String> {
    let mut rows = Vec::new();
    let title = match display {
        Display::Allowed { .. } => "WS Model Proxy: an agent asks to change a file",
        Display::Blocked { .. } => "WS Model Proxy: this file request cannot be applied",
    };
    wrap_words(&mut rows, title, width);
    rows.push(String::new());
    field(&mut rows, "Requested by: ", requester, width);
    field(
        &mut rows,
        "Reason (written by the agent): ",
        if reason.is_empty() { "(none)" } else { reason },
        width,
    );
    let (operation, paths) = match display {
        Display::Allowed {
            operation, paths, ..
        } => (operation.as_str(), paths.clone()),
        Display::Blocked {
            operation, paths, ..
        } => (
            operation.as_str(),
            paths
                .iter()
                .map(|path| ("Path".to_owned(), path.clone()))
                .collect(),
        ),
    };
    field(&mut rows, "Operation: ", operation, width);
    for (label, path) in paths {
        let label = format!("{label}: ");
        field(&mut rows, &label, &path, width);
    }
    rows.push(String::new());
    match display {
        Display::Allowed {
            description, diff, ..
        } => {
            for detail in description {
                field(&mut rows, "Details: ", detail, width);
            }
            if !diff.is_empty() {
                wrap_words(&mut rows, "Unified diff (disk content masked):", width);
                for line in diff {
                    field(&mut rows, "    ", line.trim_end_matches('\n'), width);
                }
            }
        }
        Display::Blocked { code, .. } => {
            wrap_words(
                &mut rows,
                "The file state prevents this request from being applied safely.",
                width,
            );
            field(&mut rows, "Error code: ", code, width);
        }
    }
    rows
}

fn footer_rows(
    prompt: &str,
    offset: usize,
    height: usize,
    total: usize,
    width: usize,
) -> Vec<String> {
    let mut rows = Vec::new();
    if height < total {
        let status = if height == 0 {
            "Too small to show this request; enlarge the terminal to review it.".to_owned()
        } else {
            format!(
                "Showing rows {}-{} of {total}; the rest is not shown. Scroll with ↑↓ PgUp PgDn Home End.",
                offset + 1,
                offset + height
            )
        };
        wrap_words(&mut rows, &status, width);
    }
    wrap_words(&mut rows, prompt, width);
    rows
}

fn layout(
    display: &Display,
    requester: &str,
    reason: &str,
    cols: usize,
    rows: usize,
    offset: usize,
) -> Screen {
    let width = cols.saturating_sub(1).max(2);
    let rows = rows.max(1);
    let body = body_rows(display, requester, reason, width);
    let prompt = match display {
        Display::Allowed { .. } => APPLY_PROMPT,
        Display::Blocked { .. } => DISMISS_PROMPT,
    };
    let fitting_footer = footer_rows(prompt, 0, body.len(), body.len(), width);
    if body.len() + fitting_footer.len() <= rows {
        let mut all = body;
        let height = all.len();
        all.extend(fitting_footer);
        return Screen {
            rows: all,
            offset: 0,
            max_offset: 0,
            height,
        };
    }
    let total = body.len();
    let mut height = rows.saturating_sub(footer_rows(prompt, 0, total, total, width).len());
    let (offset, footer) = loop {
        let height_now = height.min(total);
        let offset = offset.min(total - height_now);
        let footer = footer_rows(prompt, offset, height_now, total, width);
        if height_now + footer.len() <= rows || height_now == 0 {
            height = height_now;
            break (offset, footer);
        }
        height = rows.saturating_sub(footer.len());
    };
    let mut drawn = body[offset..offset + height].to_vec();
    drawn.extend(footer);
    if drawn.len() > rows {
        drawn.drain(..drawn.len() - rows);
    }
    Screen {
        rows: drawn,
        offset,
        max_offset: total - height,
        height,
    }
}

fn preview(input: &ChildInput) -> Result<Display> {
    preview_with_euid(input, nix::unistd::geteuid().as_raw())
}

fn preview_with_euid(input: &ChildInput, euid: u32) -> Result<Display> {
    if euid == 0 && !input.allow_root {
        anyhow::bail!("supervised file preview is disabled while running as root")
    }
    let preview = match preview_supervised_child(
        &input.op,
        input.args.clone(),
        input.body.as_deref(),
        &input.key,
        input.allow_root,
    ) {
        Ok(preview) => preview,
        Err(error) => {
            return Ok(Display::Blocked {
                code: error.code.as_str().to_owned(),
                operation: input.op.clone(),
                paths: fallback_paths(&input.args),
            });
        }
    };
    let actual_preimage = preview.preview_etag();
    let (operation, paths) = match &preview {
        SupervisedPreview::Allowed(preview) => (
            preview.operation.clone(),
            preview.paths.iter().map(|(_, path)| path.clone()).collect(),
        ),
        SupervisedPreview::Blocked {
            operation, paths, ..
        } => (operation.clone(), paths.clone()),
    };
    if actual_preimage != input.preimage {
        return Ok(Display::Blocked {
            code: ErrorCode::Conflict.as_str().to_owned(),
            operation,
            paths,
        });
    }
    if let Some(code) = input.blocked {
        return Ok(Display::Blocked {
            code: code.as_str().to_owned(),
            operation,
            paths,
        });
    }
    Ok(match preview {
        SupervisedPreview::Allowed(preview) => {
            let mut description = preview.description;
            if input.op == "write"
                && input
                    .body
                    .as_deref()
                    .is_some_and(|body| crate::file_ops::text::sniff_binary(body).is_some())
            {
                description.push("binary content; no textual diff is available".to_owned());
            }
            Display::Allowed {
                operation: preview.operation,
                paths: preview.paths,
                description,
                diff: preview.diff,
            }
        }
        SupervisedPreview::Blocked {
            code,
            operation,
            paths,
            ..
        } => Display::Blocked {
            code: code.as_str().to_owned(),
            operation,
            paths,
        },
    })
}

fn show(display: &Display, requester: &str, reason: &str, marker: &str) -> Result<()> {
    let action = match display {
        Display::Allowed { .. } => ConfirmAction::Apply,
        Display::Blocked { code, .. } => ConfirmAction::Blocked(code),
    };
    let outcome = interact(marker, action, |cols, rows, offset| {
        layout(display, requester, reason, cols, rows, offset)
    })?;
    match (action, outcome) {
        (ConfirmAction::Apply, ConfirmOutcome::Accepted | ConfirmOutcome::Declined)
        | (ConfirmAction::Blocked(_), ConfirmOutcome::Dismissed) => Ok(()),
        _ => anyhow::bail!("supervised file screen returned an invalid decision"),
    }
}

pub(super) fn run() -> Result<()> {
    let input = load()?;
    let reason = reason(&input.args)?.to_owned();
    let display = preview(&input)?;
    show(&display, &input.requester, &reason, &input.marker)
}

/// Render exactly the environment passed to the real child, without changing
/// process-global environment or requiring a second binary in library tests.
#[cfg(test)]
pub(crate) fn screen_from_registry_env(env: &[(String, String)]) -> Result<String> {
    let get = |name: &str| {
        env.iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    let required = |name: &str| get(name).ok_or_else(|| anyhow::anyhow!("missing {name}"));
    let input = ChildInput {
        op: required(SUPERVISED_ENV_FILE_OP)?.to_owned(),
        args: serde_json::from_str(required(SUPERVISED_ENV_FILE_ARGS)?)?,
        body: get(SUPERVISED_ENV_FILE_BODY)
            .map(|path| read_private_body(Path::new(path)))
            .transpose()?,
        key: EtagKey::from_bytes(lower_hex::<32>(
            "key",
            required(SUPERVISED_ENV_FILE_ETAG_KEY)?,
        )?),
        preimage: required(SUPERVISED_ENV_FILE_PREIMAGE)?.to_owned(),
        requester: required(SUPERVISED_ENV_REQUESTER)?.to_owned(),
        marker: required(SUPERVISED_ENV_MARKER)?.to_owned(),
        allow_root: required(SUPERVISED_ENV_FILE_ALLOW_ROOT)? == "1",
        blocked: get(SUPERVISED_ENV_FILE_BLOCKED)
            .map(|code| error_code(code).expect("registry code")),
    };
    Ok(layout(
        &preview(&input)?,
        &input.requester,
        reason(&input.args)?,
        160,
        60,
        0,
    )
    .rows
    .join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervised_body_boundaries_and_races() {
        use std::os::unix::fs::PermissionsExt;
        for case in ["max", "over", "grows", "swapped", "parent-mode"] {
            let dir = tempfile::tempdir().unwrap();
            std::fs::set_permissions(
                dir.path(),
                std::fs::Permissions::from_mode(if case == "parent-mode" { 0o755 } else { 0o700 }),
            )
            .unwrap();
            let path = dir.path().join("body");
            let size = MAX_BODY_BYTES as usize + usize::from(case == "over");
            std::fs::write(&path, vec![b'x'; size]).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            let result = read_private_body_with(&path, || {
                if case == "grows" {
                    use std::io::Write;
                    std::fs::OpenOptions::new()
                        .append(true)
                        .open(&path)?
                        .write_all(b"x")?;
                } else if case == "swapped" {
                    std::fs::rename(&path, dir.path().join("opened-original"))?;
                    std::fs::write(&path, b"replacement")?;
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
                }
                Ok(())
            });
            if case == "max" {
                assert_eq!(result.unwrap(), vec![b'x'; size]);
                assert!(!path.exists());
                continue;
            }
            let error = match result {
                Ok(body) => panic!("unsafe body was accepted ({} bytes)", body.len()),
                Err(error) => error.to_string(),
            };
            match case {
                "over" => {
                    assert!(error.contains("is larger"));
                    assert!(path.exists(), "refuse before unlink");
                }
                "grows" => {
                    assert!(error.contains("grew larger"));
                    assert!(!path.exists());
                }
                "swapped" => {
                    assert!(error.contains("changed before"));
                    assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
                    assert_eq!(
                        std::fs::read(dir.path().join("opened-original"))
                            .unwrap()
                            .len(),
                        size
                    );
                }
                _ => {
                    assert!(error.contains("directory is not private"));
                    assert!(path.exists());
                }
            }
        }
    }

    #[test]
    fn supervised_child_root_gate_is_a_refusal_before_preview() {
        let input = ChildInput {
            op: "mkdir".to_owned(),
            args: serde_json::json!({"path":"/missing-test-path"}),
            body: None,
            key: EtagKey::from_bytes([19; 32]),
            preimage: "unused".to_owned(),
            requester: "agent".to_owned(),
            marker: "00".repeat(16),
            allow_root: false,
            blocked: None,
        };
        assert!(
            preview_with_euid(&input, 0)
                .unwrap_err()
                .to_string()
                .contains("disabled while running as root")
        );
        assert!(preview_with_euid(&input, 1000).is_ok());
        assert!(
            preview_with_euid(
                &ChildInput {
                    allow_root: true,
                    ..input
                },
                0
            )
            .is_ok()
        );
    }

    #[test]
    fn supervised_blocked_code_uses_the_same_escape_path_as_other_fields() {
        let display = Display::Blocked {
            code: "conflict\x1b]7717;accepted\x07\u{202e}\rspoof".to_owned(),
            operation: "edit".to_owned(),
            paths: vec!["/tmp/example".to_owned()],
        };
        let text = layout(&display, "agent", "", 200, 40, 0).rows.join("\n");
        assert!(
            text.contains("Error code: conflict\\u{1b}]7717;accepted\\u{7}\\u{202e}\\u{d}spoof"),
            "{text}"
        );
        for control in ['\x1b', '\x07', '\r', '\u{202e}'] {
            assert!(!text.contains(control));
        }
    }

    fn allowed(diff: Vec<String>) -> Display {
        Display::Allowed {
            operation: "write".to_owned(),
            paths: vec![("Path".to_owned(), "/tmp/a\x1b]7717;fake\u{202e}".to_owned())],
            description: vec!["replace 3 bytes".to_owned()],
            diff,
        }
    }

    #[test]
    fn layout_escapes_every_untrusted_field_and_diff_line() {
        let display = allowed(vec![
            "+x\x1b]7717;wsmp-supervised;accepted;fake\x07\n".to_owned(),
        ]);
        let screen = layout(&display, "agent\x1b", "why\u{202e}\nnext", 80, 24, 0);
        let text = screen.rows.join("\n");
        assert!(!text.contains('\x1b'));
        assert!(text.contains("\\u{1b}]7717;fake\\u{202e}"), "{text}");
        assert!(text.contains("+x\\u{1b}]7717;wsmp-supervised"), "{text}");
        assert_eq!(screen.paint().matches('\x1b').count(), 2);
    }

    #[test]
    fn scrolling_and_tiny_layout_keep_the_decision_prompt() {
        let display = allowed((0..200).map(|n| format!("+line {n}")).collect());
        let first = layout(&display, "agent", "reason", 40, 8, 0);
        assert!(first.max_offset > 0);
        assert!(first.rows.join(" ").contains("Enter to apply"));
        let end = layout(&display, "agent", "reason", 40, 8, usize::MAX);
        assert_eq!(end.offset, end.max_offset);
        for (cols, rows) in [(20, 4), (3, 2), (1, 1)] {
            let screen = layout(&display, "agent", "reason", cols, rows, 0);
            assert!(screen.rows.len() <= rows.max(1));
            assert!(screen.rows.iter().all(|row| !row.contains('\x1b')));
        }
    }

    #[test]
    fn private_body_is_opened_unlinked_and_bounded() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))
            .expect("private dir");
        let body = dir.path().join("body");
        std::fs::write(&body, b"hello").expect("body");
        std::fs::set_permissions(&body, std::fs::Permissions::from_mode(0o600))
            .expect("private body");
        assert_eq!(read_private_body(&body).expect("read"), b"hello");
        assert!(!body.exists(), "body must be unlinked after open");

        let bad = dir.path().join("bad");
        std::fs::write(&bad, b"no").expect("bad body");
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o644)).expect("bad mode");
        assert!(read_private_body(&bad).is_err());

        let large = dir.path().join("large");
        std::fs::write(&large, vec![b'x'; MAX_BODY_BYTES as usize + 1]).expect("large body");
        std::fs::set_permissions(&large, std::fs::Permissions::from_mode(0o600))
            .expect("large mode");
        assert!(read_private_body(&large).is_err());

        let original = dir.path().join("original");
        std::fs::write(&original, b"content").expect("original");
        std::fs::set_permissions(&original, std::fs::Permissions::from_mode(0o600))
            .expect("original mode");
        let link = dir.path().join("link");
        symlink(&original, &link).expect("symlink");
        let error = read_private_body(&link).expect_err("never open a symlink body");
        assert_eq!(
            error.downcast_ref::<nix::errno::Errno>(),
            Some(&nix::errno::Errno::ELOOP)
        );
        let hardlink = dir.path().join("hardlink");
        std::fs::hard_link(&original, &hardlink).expect("hard link");
        assert!(read_private_body(&hardlink).is_err());

        let fifo = dir.path().join("fifo");
        nix::unistd::mkfifo(&fifo, Mode::S_IRUSR | Mode::S_IWUSR).expect("fifo");
        let started = std::time::Instant::now();
        assert!(read_private_body(&fifo).is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn strict_hex_rejects_uppercase_and_wrong_lengths() {
        assert!(lower_hex::<2>("KEY", "00ff").is_ok());
        assert!(lower_hex::<2>("KEY", "00FF").is_err());
        assert!(lower_hex::<2>("KEY", "00f").is_err());
    }

    #[test]
    fn blocked_layout_has_no_apply_prompt() {
        let display = Display::Blocked {
            code: ErrorCode::Conflict.as_str().to_owned(),
            operation: "edit".to_owned(),
            paths: vec!["/tmp/a".to_owned()],
        };
        let screen = layout(&display, "agent", "", 80, 24, 0);
        let text = screen.rows.join("\n");
        assert!(text.contains("conflict"));
        assert!(text.contains("to dismiss"));
        assert!(!text.contains("Enter to apply"));
    }

    #[test]
    fn production_path_has_no_mutating_fileops_call() {
        let source = include_str!("unix.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("production source");
        for forbidden in [
            ".execute(",
            ".execute_supervised(",
            ".edit(",
            ".rename(",
            ".dir_create(",
            ".delete(",
        ] {
            assert!(!production.contains(forbidden), "found {forbidden}");
        }
    }
}
