//! Non-mutating supervised previews and immutable prepared apply requests.
//!
//! Accepted state grammar:
//! 1. Strictly parse one of edit/write/rename/mkdir/delete before disk state.
//! 2. Reject dryRun, inline write bodies, unknown fields, and malformed values.
//! 3. Resolve physical paths without creating parents; enforce path policy.
//! 4. Snapshot the deepest ancestor plus object identity/content or absence.
//! 5. Convert every later state/planning failure into a blocked preview.
//! 6. Bind normalized child args, body, paths and snapshot under request key K.
//! 7. Keep daemon-key args, body and pins only in opaque PreparedSupervised.
//! 8. Apply consumes it, rechecks policy/pins inside path locks and commits once.

use std::os::fd::AsFd;
use std::os::fd::OwnedFd;
use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use nix::sys::stat::fstat;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::atomic;
use super::diff::consent_diff;
use super::edit::{self, EditArgs};
use super::error::{ErrorCode, FileError, FileResult};
use super::mutate::{DeleteArgs, MkdirArgs, RenameArgs};
use super::policy::Access;
use super::read::load_all;
use super::redact;
use super::resolve::{Kind, ResolveOpts, ResolvePin, Resolved, Stat, resolve};
use super::stat::kind_name;
use super::text;
use super::write::{self, Encoding, IfExists, WriteArgs};
use super::{Cancel, EtagKey, FileOps, Step, check_reason};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupervisedPreview {
    Allowed(AllowedPreview),
    Blocked {
        code: ErrorCode,
        operation: String,
        paths: Vec<String>,
        preview_etag: String,
    },
}

impl SupervisedPreview {
    pub fn preview_etag(&self) -> &str {
        match self {
            Self::Allowed(preview) => &preview.preview_etag,
            Self::Blocked { preview_etag, .. } => preview_etag,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowedPreview {
    pub operation: String,
    pub paths: Vec<(String, String)>,
    pub description: Vec<String>,
    pub diff: Vec<String>,
    pub preview_etag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupervisedChildInput {
    pub op: String,
    pub args: Value,
    pub preview_etag: String,
    pub roots: super::RootSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<ErrorCode>,
}

#[derive(Debug, Clone)]
pub(crate) struct PinnedObject {
    pub(crate) stat: Stat,
    pub(crate) etag: Option<String>,
    request_etag: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PinnedPath {
    pub physical: PathBuf,
    pub ancestor: ResolvePin,
    pub(crate) object: Option<PinnedObject>,
    route_leaf: Option<(PathBuf, Stat, PathBuf)>,
}

impl PinnedPath {
    pub(crate) fn expected_etag(&self) -> Option<&str> {
        self.object
            .as_ref()
            .and_then(|object| object.etag.as_deref())
    }

    pub(crate) fn verify(
        &self,
        ops: &FileOps,
        resolved: &Resolved,
        access: Access,
        cancel: &Cancel,
    ) -> FileResult<()> {
        // The ancestor pin binds the parent; bind the leaf name separately.
        // An inode moved within that parent and reached through a new symlink
        // must not turn the approved physical path into another path.
        if self
            .physical
            .file_name()
            .is_some_and(|name| name != resolved.name)
        {
            return Err(FileError::conflict("replaced"));
        }
        match (&self.object, resolved.lstat()?) {
            (None, None) => Ok(()),
            (Some(expected), Some(now)) if expected.stat.same_object(&now) => {
                if let Some(etag) = &expected.etag {
                    let current = match now.kind() {
                        Kind::File => {
                            ops.step(Step::PinBeforeOpen)?;
                            let (mut file, opened) = resolved.open_regular(&ops.policy, access)?;
                            ops.step(Step::PinOpened)?;
                            atomic::check_replaceable(ops, &opened)?;
                            if !opened.same_object(&expected.stat) {
                                return Err(FileError::conflict("replaced"));
                            }
                            super::read::current_etag(ops, &mut file, &opened, cancel)?
                        }
                        Kind::Symlink => ops.key.weak_stat(&now),
                        Kind::Dir | Kind::Other => String::new(),
                    };
                    if &current != etag {
                        return Err(FileError::conflict(&current));
                    }
                }
                Ok(())
            }
            _ => Err(FileError::conflict("replaced")),
        }?;
        if let Some((path, expected, target)) = &self.route_leaf {
            let metadata =
                std::fs::symlink_metadata(path).map_err(|_| FileError::conflict("replaced"))?;
            let current_target =
                std::fs::read_link(path).map_err(|_| FileError::conflict("replaced"))?;
            if !Stat::from_metadata(&metadata).same_object(expected) || &current_target != target {
                return Err(FileError::conflict("replaced"));
            }
        }
        // Re-resolve the pinned physical ancestor after every observable race
        // seam. A held directory fd alone remains usable after its name moves.
        resolve(
            &path_text(&self.physical)?,
            &ResolveOpts {
                follow_last: false,
                make_parents: None,
                policy: &ops.policy,
                access,
                preview_missing: true,
                pin: Some(&ResolvePin {
                    path: self.ancestor.path.clone(),
                    stat: self.ancestor.stat,
                    missing_paths: Vec::new(),
                }),
                cancel: Some(cancel),
            },
        )?;
        // PinOpened is the last hook in this verifier. Check the name again:
        // the fd can still hold the approved bytes after its name was swapped.
        match (&self.object, resolved.lstat()?) {
            (None, None) => Ok(()),
            (Some(expected), Some(now)) if expected.stat.same_object(&now) => Ok(()),
            _ => Err(FileError::conflict("replaced")),
        }
    }

    pub(crate) fn verify_opened(&self, stat: &Stat) -> FileResult<()> {
        match &self.object {
            Some(expected) if expected.stat.same_object(stat) => Ok(()),
            _ => Err(FileError::conflict("replaced")),
        }
    }

    pub(crate) fn verify_at(
        &self,
        ops: &FileOps,
        dir: &OwnedFd,
        name: &std::ffi::OsStr,
        access: Access,
        cancel: &Cancel,
    ) -> FileResult<()> {
        let parent = self
            .physical
            .parent()
            .ok_or_else(|| FileError::conflict("replaced"))?
            .to_path_buf();
        let resolved = Resolved {
            dir: dir.try_clone()?,
            dir_path: parent,
            name: name.to_os_string(),
            created: Vec::new(),
            missing_suffix: Vec::new(),
        };
        self.verify(ops, &resolved, access, cancel)
    }
}

#[derive(Debug)]
enum PreparedOp {
    Edit(EditArgs, PinnedPath),
    Write(WriteArgs, PinnedPath),
    Rename(RenameArgs, PinnedPath, Box<PinnedPath>),
    Mkdir(MkdirArgs, PinnedPath),
    Delete(DeleteArgs, PinnedPath),
}

#[derive(Debug)]
pub struct PreparedSupervised {
    child: SupervisedChildInput,
    apply: Option<PreparedOp>,
}

impl PreparedSupervised {
    pub fn child_input(&self) -> &SupervisedChildInput {
        &self.child
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SupervisedWriteArgs {
    path: String,
    if_exists: Option<IfExists>,
    expected_etag: Option<String>,
    mode: Option<String>,
    make_parents: Option<bool>,
    return_diff: Option<bool>,
    reason: Option<String>,
}

fn parse<T: serde::de::DeserializeOwned>(args: Value) -> FileResult<T> {
    serde_json::from_value(args)
        .map_err(|error| FileError::invalid(format!("bad arguments: {error}")))
}

fn value<T: Serialize>(args: &T) -> FileResult<Value> {
    serde_json::to_value(args)
        .map_err(|error| FileError::new(ErrorCode::IoError, format!("argument encoding: {error}")))
}

fn path_text(path: &std::path::Path) -> FileResult<String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| FileError::invalid("path is not valid UTF-8"))
}

fn snapshot(
    ops: &FileOps,
    path: &str,
    access: Access,
    follow_last: bool,
    token_key: &EtagKey,
    cancel: &Cancel,
) -> FileResult<(PinnedPath, Vec<u8>)> {
    let expanded = super::resolve::expand(path)?;
    let route_leaf = match std::fs::symlink_metadata(&expanded) {
        Ok(metadata) if metadata.file_type().is_symlink() => Some((
            expanded.clone(),
            Stat::from_metadata(&metadata),
            std::fs::read_link(&expanded)?,
        )),
        Ok(_) | Err(_) => None,
    };
    let resolved = resolve(
        path,
        &ResolveOpts {
            follow_last,
            make_parents: None,
            policy: &ops.policy,
            access,
            preview_missing: true,
            pin: None,
            cancel: Some(cancel),
        },
    )?;
    let ancestor_stat = Stat::from_raw(&fstat(resolved.dir.as_fd()).map_err(FileError::errno)?);
    let mut missing_paths = Vec::new();
    if !resolved.missing_suffix.is_empty() {
        let mut missing = resolved.dir_path.join(&resolved.name);
        missing_paths.push(missing.clone());
        for component in &resolved.missing_suffix {
            missing.push(component);
            missing_paths.push(missing.clone());
        }
    }
    let ancestor = ResolvePin {
        path: resolved.dir_path.clone(),
        stat: ancestor_stat,
        missing_paths,
    };
    let physical = resolved.full_path();
    let current = resolved.lstat()?;
    let mut fingerprint = Vec::new();
    fingerprint.extend_from_slice(path_text(&physical)?.as_bytes());
    fingerprint.extend_from_slice(&ancestor_stat.dev.to_le_bytes());
    fingerprint.extend_from_slice(&ancestor_stat.ino.to_le_bytes());
    let object = match current {
        None => {
            fingerprint.push(0);
            None
        }
        Some(mut stat) => {
            fingerprint.push(1);
            let (etag, request_etag) = match stat.kind() {
                Kind::File => {
                    let (mut file, opened) = resolved.open_regular(&ops.policy, access)?;
                    if !opened.same_object(&stat) {
                        return Err(FileError::conflict("replaced"));
                    }
                    stat = opened;
                    atomic::check_replaceable(ops, &stat)?;
                    if stat.size <= super::etag::STRONG_ETAG_MAX_BYTES {
                        let bytes =
                            load_all(&mut file, &stat, super::etag::STRONG_ETAG_MAX_BYTES, cancel)?;
                        ops.step(Step::SupervisedSnapshotRead)?;
                        (
                            Some(ops.key.strong(&stat, &bytes)),
                            Some(token_key.strong(&stat, &bytes)),
                        )
                    } else {
                        (
                            Some(ops.key.weak_stat(&stat)),
                            Some(token_key.weak_stat(&stat)),
                        )
                    }
                }
                Kind::Symlink => (
                    Some(ops.key.weak_stat(&stat)),
                    Some(token_key.weak_stat(&stat)),
                ),
                Kind::Dir | Kind::Other => (None, None),
            };
            for part in [stat.dev, stat.ino, stat.nlink, stat.size] {
                fingerprint.extend_from_slice(&part.to_le_bytes());
            }
            fingerprint.extend_from_slice(&stat.mode.to_le_bytes());
            fingerprint.extend_from_slice(&stat.uid.to_le_bytes());
            fingerprint.extend_from_slice(&stat.gid.to_le_bytes());
            fingerprint.extend_from_slice(&stat.mtime_secs.to_le_bytes());
            fingerprint.extend_from_slice(&stat.mtime_nanos.to_le_bytes());
            if let Some(request_etag) = &request_etag {
                fingerprint.extend_from_slice(request_etag.as_bytes());
            }
            Some(PinnedObject {
                stat,
                etag,
                request_etag,
            })
        }
    };
    Ok((
        PinnedPath {
            physical,
            ancestor,
            object,
            route_leaf,
        },
        fingerprint,
    ))
}

fn token(
    key: &EtagKey,
    op: &str,
    args: &Value,
    body: Option<&[u8]>,
    fingerprints: &[Vec<u8>],
) -> FileResult<String> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(op.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(&serde_json::to_vec(args).map_err(|error| {
        FileError::new(ErrorCode::IoError, format!("argument encoding: {error}"))
    })?);
    if let Some(body) = body {
        bytes.extend_from_slice(key.supervised_token(body).as_bytes());
    }
    for fingerprint in fingerprints {
        bytes.extend_from_slice(&(fingerprint.len() as u64).to_le_bytes());
        bytes.extend_from_slice(fingerprint);
    }
    Ok(key.supervised_token(&bytes))
}

struct Built {
    paths: Vec<(String, String)>,
    description: Vec<String>,
    diff: Vec<String>,
    fingerprints: Vec<Vec<u8>>,
    apply: PreparedOp,
}

struct Material {
    args: Value,
    paths: Vec<(String, String)>,
    fingerprints: Vec<Vec<u8>>,
}

/// Below the 128 KiB per-variable exec limit (`NAME=value\0` counts in full on
/// Linux), so an accepted argument set always starts the confirm child.
const MAX_CHILD_ARGS_BYTES: usize = 128 * 1024 - 256;

fn check_args_size(args: &Value) -> FileResult<()> {
    if serde_json::to_vec(args)
        .map_err(|error| FileError::invalid(format!("argument encoding: {error}")))?
        .len()
        > MAX_CHILD_ARGS_BYTES
    {
        return Err(FileError::new(
            ErrorCode::TooLarge,
            "supervised arguments exceed 128 KiB",
        ));
    }
    Ok(())
}

fn static_validate(op: &str, raw: Value, body: Option<&[u8]>) -> FileResult<()> {
    // Only server-supplied bytes may cause an immediate size refusal.
    check_args_size(&raw)?;
    match op {
        "edit" if body.is_none() => {
            let args: EditArgs = parse(raw)?;
            if args.dry_run == Some(true) {
                return Err(FileError::invalid(
                    "dryRun is not allowed for supervised edits",
                ));
            }
            edit::validate_args(&args)
        }
        "write" => {
            let supplied: SupervisedWriteArgs = parse(raw)?;
            let body = body.ok_or_else(|| FileError::invalid("write body is missing"))?;
            write::validate_args(&WriteArgs {
                path: supplied.path,
                content: STANDARD.encode(body),
                encoding: Some(Encoding::Base64),
                if_exists: supplied.if_exists,
                expected_etag: supplied.expected_etag,
                mode: supplied.mode,
                make_parents: supplied.make_parents,
                return_diff: Some(false),
                reason: supplied.reason,
            })
            .map(|_| ())
        }
        "rename" if body.is_none() => {
            let args: RenameArgs = parse(raw)?;
            check_reason(&args.reason)?;
            if args.overwrite.unwrap_or(false) && args.expected_etag.is_none() {
                return Err(FileError::invalid("expectedEtag is required for overwrite"));
            }
            Ok(())
        }
        "mkdir" if body.is_none() => {
            let args: MkdirArgs = parse(raw)?;
            check_reason(&args.reason)?;
            args.mode.as_deref().map(write::parse_mode).transpose()?;
            Ok(())
        }
        "delete" if body.is_none() => {
            let args: DeleteArgs = parse(raw)?;
            check_reason(&args.reason)
        }
        "edit" | "rename" | "mkdir" | "delete" => {
            Err(FileError::invalid("only write accepts a body"))
        }
        _ => Err(FileError::invalid("unsupported supervised file operation")),
    }
}

fn path_specs(op: &str, raw: Value) -> FileResult<Vec<(String, Access, bool)>> {
    Ok(match op {
        "edit" => vec![(parse::<EditArgs>(raw)?.path, Access::Write, true)],
        "write" => vec![(parse::<SupervisedWriteArgs>(raw)?.path, Access::Write, true)],
        "rename" => {
            let args: RenameArgs = parse(raw)?;
            vec![
                (args.from, Access::Remove, false),
                (args.to, Access::Write, false),
            ]
        }
        "mkdir" => vec![(parse::<MkdirArgs>(raw)?.path, Access::Write, true)],
        "delete" => vec![(parse::<DeleteArgs>(raw)?.path, Access::Remove, false)],
        _ => return Err(FileError::invalid("unsupported supervised file operation")),
    })
}

fn precheck_paths(ops: &FileOps, op: &str, raw: Value) -> FileResult<()> {
    ops.policy.check_process()?;
    for (path, access, _) in path_specs(op, raw)? {
        let path = super::resolve::expand(&path)?;
        // Physical resolution and inode policy belong on the blocked screen.
        // Only lexical path refusals can precede the person's dismissal key.
        ops.policy.check_path_lexical(access, &path)?;
    }
    Ok(())
}

fn fallback_material(op: &str, raw: Value) -> FileResult<Material> {
    let paths = path_specs(op, raw.clone())?
        .into_iter()
        .enumerate()
        .map(|(index, (path, _, _))| {
            let label = if op == "rename" && index == 0 {
                "source"
            } else if op == "rename" {
                "destination"
            } else {
                "path"
            };
            (label.to_string(), path)
        })
        .collect();
    Ok(Material {
        args: raw,
        paths,
        fingerprints: Vec::new(),
    })
}

fn object(pin: &PinnedPath, missing: ErrorCode) -> FileResult<&PinnedObject> {
    pin.object
        .as_ref()
        .ok_or_else(|| FileError::new(missing, "path does not exist"))
}

fn require_agent_etag(agent: Option<&str>, current: Option<&str>) -> FileResult<()> {
    if let Some(agent) = agent
        && Some(agent) != current
    {
        return Err(FileError::conflict(current.unwrap_or("gone")));
    }
    Ok(())
}

fn build_edit(ops: &FileOps, raw: Value, key: &EtagKey, cancel: &Cancel) -> FileResult<Built> {
    let mut args: EditArgs = parse(raw)?;
    // Entry points already ran static_validate before any disk access.
    edit::validate_args(&args)?;
    let agent_etag = args.expected_etag.clone();
    let (pin, fingerprint) = snapshot(ops, &args.path, Access::Write, true, key, cancel)?;
    let current = object(&pin, ErrorCode::NotFound)?;
    if current.stat.kind() == Kind::File {
        atomic::check_replaceable(ops, &current.stat)?;
    }
    require_agent_etag(agent_etag.as_deref(), current.etag.as_deref())?;
    args.path = path_text(&pin.physical)?;
    args.expected_etag = current.etag.clone();
    args.dry_run = Some(true);
    args.return_diff = Some(true);
    let (result, after_bytes) = edit::consent_preview(ops, &args, cancel)?;
    let diff = result
        .diff
        .unwrap_or_default()
        .split_terminator('\n')
        .map(str::to_string)
        .collect();
    args.dry_run = Some(false);
    args.return_diff = Some(false);
    Ok(Built {
        paths: vec![("path".to_string(), args.path.clone())],
        description: vec![
            format!("{} edit(s)", args.edits.len()),
            format!("mode: {:04o} (preserved)", current.stat.mode & 0o7777),
            format!(
                "before: {} bytes; after: {} bytes",
                current.stat.size, after_bytes
            ),
        ],
        diff,
        fingerprints: vec![fingerprint],
        apply: PreparedOp::Edit(args, pin),
    })
}

fn build_write(
    ops: &FileOps,
    raw: Value,
    body: Option<&[u8]>,
    key: &EtagKey,
    cancel: &Cancel,
) -> FileResult<Built> {
    let supplied: SupervisedWriteArgs = parse(raw)?;
    let body = body.ok_or_else(|| FileError::invalid("write body is missing"))?;
    let mut args = WriteArgs {
        path: supplied.path,
        content: STANDARD.encode(body),
        encoding: Some(Encoding::Base64),
        if_exists: supplied.if_exists,
        expected_etag: supplied.expected_etag,
        mode: supplied.mode,
        make_parents: supplied.make_parents,
        return_diff: Some(false),
        reason: supplied.reason,
    };
    let (content, mode, if_exists) = write::validate_args(&args)?;
    if text::sniff_binary(&content).is_some() || std::str::from_utf8(&content).is_err() {
        return Err(FileError::new(
            ErrorCode::BinaryFile,
            "binary content cannot be displayed for supervised approval",
        ));
    }
    let agent_etag = args.expected_etag.clone();
    let (pin, fingerprint) = snapshot(ops, &args.path, Access::Write, true, key, cancel)?;
    args.path = path_text(&pin.physical)?;
    let mut before = String::new();
    match (&pin.object, if_exists) {
        (None, IfExists::Replace) => {
            return Err(FileError::new(ErrorCode::NotFound, "nothing to replace"));
        }
        (None, IfExists::Fail) => {
            if pin.physical.parent() != Some(pin.ancestor.path.as_path())
                && !args.make_parents.unwrap_or(false)
            {
                return Err(FileError::new(
                    ErrorCode::NotFound,
                    "a parent directory does not exist",
                ));
            }
        }
        (Some(_), IfExists::Fail) => {
            return Err(FileError::new(ErrorCode::Exists, "the file already exists"));
        }
        (Some(object), IfExists::Replace) => {
            if object.stat.kind() != Kind::File {
                return Err(FileError::new(
                    if object.stat.kind() == Kind::Dir {
                        ErrorCode::NotAFile
                    } else {
                        ErrorCode::SpecialFile
                    },
                    "path is not a regular file",
                ));
            }
            require_agent_etag(agent_etag.as_deref(), object.etag.as_deref())?;
            let resolved = resolve(
                &args.path,
                &ResolveOpts {
                    follow_last: true,
                    make_parents: None,
                    policy: &ops.policy,
                    access: Access::Write,
                    preview_missing: false,
                    pin: None,
                    cancel: Some(cancel),
                },
            )?;
            ops.step(Step::SupervisedPreviewRead)?;
            let (mut file, stat) = resolved.open_regular(&ops.policy, Access::Write)?;
            pin.verify_opened(&stat)?;
            atomic::check_replaceable(ops, &stat)?;
            if stat.size > super::etag::STRONG_ETAG_MAX_BYTES {
                return Err(FileError::new(
                    ErrorCode::TooLarge,
                    "the existing file is too large to preview",
                ));
            }
            let bytes = load_all(&mut file, &stat, super::etag::STRONG_ETAG_MAX_BYTES, cancel)?;
            if object.etag.as_deref() != Some(ops.key.strong(&stat, &bytes).as_str()) {
                return Err(FileError::conflict("replaced"));
            }
            if text::sniff_binary(&bytes).is_some() {
                return Err(FileError::new(
                    ErrorCode::BinaryFile,
                    "binary content cannot be displayed for supervised approval",
                ));
            }
            before = String::from_utf8(bytes).map_err(|_| {
                FileError::new(
                    ErrorCode::BinaryFile,
                    "binary content cannot be displayed for supervised approval",
                )
            })?;
            if redact::mask(redact::classify(&pin.physical), &before).redactions() > 0 {
                return Err(FileError::new(
                    ErrorCode::SecretFile,
                    "masked files are not replaced",
                ));
            }
            args.expected_etag = object.etag.clone();
        }
    }
    let after = std::str::from_utf8(&content).map_err(|_| {
        FileError::new(
            ErrorCode::BinaryFile,
            "write content cannot be fully displayed",
        )
    })?;
    let class = redact::classify(&pin.physical);
    let mut consent = super::diff::ConsentText::new(&before);
    consent.push_agent(after);
    let diff = consent_diff(&consent, class)?
        .split_terminator('\n')
        .map(str::to_string)
        .collect();
    Ok(Built {
        paths: vec![("path".to_string(), args.path.clone())],
        description: vec![
            format!(
                "before: {} bytes; after: {} bytes",
                before.len(),
                content.len()
            ),
            format!(
                "mode: {:04o}{}",
                mode.unwrap_or_else(|| pin
                    .object
                    .as_ref()
                    .map_or(write::DEFAULT_CREATE_MODE, |object| object.stat.mode
                        & 0o7777)),
                if if_exists == IfExists::Replace {
                    " (preserved)"
                } else {
                    ""
                }
            ),
            format!(
                "ifExists: {}",
                if if_exists == IfExists::Replace {
                    "replace"
                } else {
                    "fail"
                }
            ),
            format!(
                "creates missing parent directories: {}",
                args.make_parents.unwrap_or(false)
            ),
            format!("parent mode: {:04o}", write::DEFAULT_PARENT_MODE),
            "creation permissions are reduced by the local umask".to_string(),
        ],
        diff,
        fingerprints: vec![fingerprint],
        apply: PreparedOp::Write(args, pin),
    })
}

fn request_etag(pin: &PinnedPath) -> Option<String> {
    pin.object
        .as_ref()
        .and_then(|object| object.request_etag.clone())
}

fn bounded_material(
    ops: &FileOps,
    op: &str,
    raw: Value,
    body: Option<&[u8]>,
    key: &EtagKey,
    cancel: &Cancel,
) -> FileResult<Material> {
    let material = material(ops, op, raw, body, key, cancel)?;
    // Physical path growth is disk state. Both daemon and child turn this
    // into the same minimal blocked input, never a pre-display rejection.
    check_args_size(&material.args)?;
    Ok(material)
}

fn material(
    ops: &FileOps,
    op: &str,
    raw: Value,
    body: Option<&[u8]>,
    key: &EtagKey,
    cancel: &Cancel,
) -> FileResult<Material> {
    ops.policy.check_process()?;
    match op {
        "edit" if body.is_none() => {
            let mut args: EditArgs = parse(raw)?;
            // Entry points already ran static_validate before any disk access.
            edit::validate_args(&args)?;
            let (pin, fingerprint) = snapshot(ops, &args.path, Access::Write, true, key, cancel)?;
            args.path = path_text(&pin.physical)?;
            if let Some(etag) = request_etag(&pin) {
                args.expected_etag = Some(etag);
            }
            args.dry_run = Some(false);
            args.return_diff = Some(false);
            Ok(Material {
                args: value(&args)?,
                paths: vec![("path".to_string(), args.path)],
                fingerprints: vec![fingerprint],
            })
        }
        "write" => {
            let supplied: SupervisedWriteArgs = parse(raw)?;
            let body = body.ok_or_else(|| FileError::invalid("write body is missing"))?;
            let validate = WriteArgs {
                path: supplied.path.clone(),
                content: STANDARD.encode(body),
                encoding: Some(Encoding::Base64),
                if_exists: supplied.if_exists,
                expected_etag: supplied.expected_etag.clone(),
                mode: supplied.mode.clone(),
                make_parents: supplied.make_parents,
                return_diff: Some(false),
                reason: supplied.reason.clone(),
            };
            write::validate_args(&validate)?;
            let (pin, fingerprint) =
                snapshot(ops, &supplied.path, Access::Write, true, key, cancel)?;
            let normalized = SupervisedWriteArgs {
                path: path_text(&pin.physical)?,
                expected_etag: if supplied.if_exists == Some(IfExists::Replace) {
                    request_etag(&pin).or(supplied.expected_etag)
                } else {
                    None
                },
                return_diff: Some(false),
                ..supplied
            };
            Ok(Material {
                paths: vec![("path".to_string(), normalized.path.clone())],
                args: value(&normalized)?,
                fingerprints: vec![fingerprint],
            })
        }
        "rename" if body.is_none() => {
            let mut args: RenameArgs = parse(raw)?;
            check_reason(&args.reason)?;
            if args.overwrite.unwrap_or(false) && args.expected_etag.is_none() {
                return Err(FileError::invalid("expectedEtag is required for overwrite"));
            }
            let (from, from_fp) = snapshot(ops, &args.from, Access::Remove, false, key, cancel)?;
            let (to, to_fp) = snapshot(ops, &args.to, Access::Write, false, key, cancel)?;
            args.from = path_text(&from.physical)?;
            args.to = path_text(&to.physical)?;
            args.expected_etag = if args.overwrite.unwrap_or(false) {
                request_etag(&to).or(args.expected_etag)
            } else {
                request_etag(&from).or(args.expected_etag)
            };
            Ok(Material {
                paths: vec![
                    ("source".to_string(), args.from.clone()),
                    ("destination".to_string(), args.to.clone()),
                ],
                args: value(&args)?,
                fingerprints: vec![from_fp, to_fp],
            })
        }
        "mkdir" if body.is_none() => {
            let mut args: MkdirArgs = parse(raw)?;
            check_reason(&args.reason)?;
            if let Some(mode) = &args.mode {
                write::parse_mode(mode)?;
            }
            let (pin, fingerprint) = snapshot(ops, &args.path, Access::Write, true, key, cancel)?;
            args.path = path_text(&pin.physical)?;
            Ok(Material {
                paths: vec![("path".to_string(), args.path.clone())],
                args: value(&args)?,
                fingerprints: vec![fingerprint],
            })
        }
        "delete" if body.is_none() => {
            let mut args: DeleteArgs = parse(raw)?;
            check_reason(&args.reason)?;
            let (pin, fingerprint) = snapshot(ops, &args.path, Access::Remove, false, key, cancel)?;
            args.path = path_text(&pin.physical)?;
            if let Some(etag) = request_etag(&pin) {
                args.expected_etag = Some(etag);
            }
            Ok(Material {
                paths: vec![("path".to_string(), args.path.clone())],
                args: value(&args)?,
                fingerprints: vec![fingerprint],
            })
        }
        "edit" | "rename" | "mkdir" | "delete" => {
            Err(FileError::invalid("only write accepts a body"))
        }
        _ => Err(FileError::invalid("unsupported supervised file operation")),
    }
}

fn build_rename(ops: &FileOps, raw: Value, key: &EtagKey, cancel: &Cancel) -> FileResult<Built> {
    let mut args: RenameArgs = parse(raw)?;
    check_reason(&args.reason)?;
    let overwrite = args.overwrite.unwrap_or(false);
    if overwrite && args.expected_etag.is_none() {
        return Err(FileError::invalid("expectedEtag is required for overwrite"));
    }
    let agent_etag = args.expected_etag.clone();
    let (from, from_fp) = snapshot(ops, &args.from, Access::Remove, false, key, cancel)?;
    let (to, to_fp) = snapshot(ops, &args.to, Access::Write, false, key, cancel)?;
    if from.physical == to.physical {
        return Err(FileError::invalid(
            "source and destination are the same path",
        ));
    }
    let src = object(&from, ErrorCode::NotFound)?;
    if to.object.is_none() && to.physical.parent() != Some(to.ancestor.path.as_path()) {
        return Err(FileError::new(
            ErrorCode::NotFound,
            "the destination parent does not exist",
        ));
    }
    if src.stat.kind() == Kind::Other {
        return Err(FileError::new(
            ErrorCode::SpecialFile,
            "special files are not moved",
        ));
    }
    ops.policy.check_identity(Access::Remove, &src.stat)?;
    if overwrite {
        if let Some(dst) = &to.object {
            if dst.stat.kind() != src.stat.kind()
                || matches!(dst.stat.kind(), Kind::Dir | Kind::Other)
            {
                return Err(FileError::new(
                    ErrorCode::Exists,
                    "destination kind cannot be overwritten",
                ));
            }
            ops.policy.check_identity(Access::Write, &dst.stat)?;
            require_agent_etag(agent_etag.as_deref(), dst.etag.as_deref())?;
        }
    } else {
        if to.object.is_some() {
            return Err(FileError::new(
                ErrorCode::Exists,
                "the destination already exists",
            ));
        }
        require_agent_etag(agent_etag.as_deref(), src.etag.as_deref())?;
    }
    super::mutate::check_supervised_rename_capability(
        ops.rename_atomic_capability(),
        src.stat.kind(),
        overwrite,
        to.object.is_some(),
    )?;
    args.from = path_text(&from.physical)?;
    args.to = path_text(&to.physical)?;
    if overwrite {
        args.expected_etag = to.expected_etag().map(str::to_string);
        if args.expected_etag.is_none() {
            args.expected_etag = agent_etag;
        }
    } else {
        args.expected_etag = from.expected_etag().map(str::to_string);
    }
    Ok(Built {
        paths: vec![
            ("source".to_string(), args.from.clone()),
            ("destination".to_string(), args.to.clone()),
        ],
        description: rename_description(
            overwrite,
            &src.stat,
            to.object.as_ref().map(|dst| &dst.stat),
            (&from.ancestor.stat, from.physical.file_name()),
            (&to.ancestor.stat, to.physical.file_name()),
        ),
        diff: Vec::new(),
        fingerprints: vec![from_fp, to_fp],
        apply: PreparedOp::Rename(args, from, Box::new(to)),
    })
}

/// The confirm-screen lines of a rename. On a case-insensitive volume a
/// case-only respelling of one file names the file itself as the destination;
/// apply renames it in place (`mutate::same_object_rename`), so the screen must
/// not call it an overwrite: nothing else is replaced.
fn rename_description(
    overwrite: bool,
    src: &Stat,
    dst: Option<&Stat>,
    (from_dir, from_name): (&Stat, Option<&std::ffi::OsStr>),
    (to_dir, to_name): (&Stat, Option<&std::ffi::OsStr>),
) -> Vec<String> {
    let case_only = overwrite
        && matches!(
            (dst, from_name, to_name),
            (Some(dst), Some(from_name), Some(to_name))
                if super::mutate::same_object_rename(src, dst, from_dir, from_name, to_dir, to_name)
                    == super::mutate::SameObjectRename::CaseOnlyRename
        );
    let mut lines = if case_only {
        vec![
            "overwrite: false (case-only rename: the destination is this same file, nothing is replaced)"
                .to_string(),
            format!("size: {} bytes", src.size),
        ]
    } else {
        vec![
            format!("overwrite: {overwrite}"),
            format!(
                "source: {} bytes; destination: {} bytes",
                src.size,
                dst.map_or(0, |dst| dst.size)
            ),
        ]
    };
    lines.push(format!("mode: {:04o} (preserved)", src.mode & 0o7777));
    lines
}

fn build_mkdir(ops: &FileOps, raw: Value, key: &EtagKey, cancel: &Cancel) -> FileResult<Built> {
    let mut args: MkdirArgs = parse(raw)?;
    check_reason(&args.reason)?;
    if let Some(mode) = &args.mode {
        write::parse_mode(mode)?;
    }
    let (pin, fingerprint) = snapshot(ops, &args.path, Access::Write, true, key, cancel)?;
    if pin.object.is_none()
        && pin.physical.parent() != Some(pin.ancestor.path.as_path())
        && !args.parents.unwrap_or(true)
    {
        return Err(FileError::new(
            ErrorCode::NotFound,
            "a parent directory does not exist",
        ));
    }
    if let Some(object) = &pin.object
        && object.stat.kind() != Kind::Dir
    {
        return Err(FileError::new(
            ErrorCode::Exists,
            "a file already exists at this path",
        ));
    }
    args.path = path_text(&pin.physical)?;
    Ok(Built {
        paths: vec![("path".to_string(), args.path.clone())],
        description: vec![
            format!(
                "creates missing parent directories: {}",
                args.parents.unwrap_or(true)
            ),
            format!(
                "mode: {:04o}",
                args.mode
                    .as_deref()
                    .map(write::parse_mode)
                    .transpose()?
                    .unwrap_or(write::DEFAULT_PARENT_MODE)
            ),
            "creation permissions are reduced by the local umask".to_string(),
        ],
        diff: Vec::new(),
        fingerprints: vec![fingerprint],
        apply: PreparedOp::Mkdir(args, pin),
    })
}

fn build_delete(ops: &FileOps, raw: Value, key: &EtagKey, cancel: &Cancel) -> FileResult<Built> {
    let mut args: DeleteArgs = parse(raw)?;
    check_reason(&args.reason)?;
    let agent_etag = args.expected_etag.clone();
    let (pin, fingerprint) = snapshot(ops, &args.path, Access::Remove, false, key, cancel)?;
    let object = object(&pin, ErrorCode::NotFound)?;
    if object.stat.kind() == Kind::Other {
        return Err(FileError::new(
            ErrorCode::SpecialFile,
            "special files are not deleted",
        ));
    }
    if object.stat.kind() == Kind::Dir {
        let mut entries = std::fs::read_dir(&pin.physical)?;
        if entries.next().transpose()?.is_some() {
            return Err(FileError::invalid("directory is not empty"));
        }
    }
    ops.policy.check_identity(Access::Remove, &object.stat)?;
    require_agent_etag(agent_etag.as_deref(), object.etag.as_deref())?;
    args.path = path_text(&pin.physical)?;
    args.expected_etag = object.etag.clone();
    let description = vec![
        format!("type: {}", kind_name(object.stat.kind())),
        format!("size: {}", object.stat.size),
        format!("etag: {}", object.etag.as_deref().unwrap_or("none")),
    ];
    Ok(Built {
        paths: vec![("path".to_string(), args.path.clone())],
        description,
        diff: Vec::new(),
        fingerprints: vec![fingerprint],
        apply: PreparedOp::Delete(args, pin),
    })
}

fn build(
    ops: &FileOps,
    op: &str,
    args: Value,
    body: Option<&[u8]>,
    key: &EtagKey,
    cancel: &Cancel,
) -> FileResult<Built> {
    ops.policy.check_process()?;
    // Every consent screen goes through this builder. Edit/write content must
    // use consent_diff; the other operations disclose metadata without content.
    match op {
        "edit" if body.is_none() => build_edit(ops, args, key, cancel),
        "write" => build_write(ops, args, body, key, cancel),
        "rename" if body.is_none() => build_rename(ops, args, key, cancel),
        "mkdir" if body.is_none() => build_mkdir(ops, args, key, cancel),
        "delete" if body.is_none() => build_delete(ops, args, key, cancel),
        "edit" | "rename" | "mkdir" | "delete" => {
            Err(FileError::invalid("only write accepts a body"))
        }
        _ => Err(FileError::invalid("unsupported supervised file operation")),
    }
}

impl FileOps {
    pub fn prepare_supervised(
        &self,
        op: &str,
        args: Value,
        body: Option<Vec<u8>>,
        preview_key: &EtagKey,
        cancel: &Cancel,
    ) -> FileResult<PreparedSupervised> {
        static_validate(op, args.clone(), body.as_deref())?;
        precheck_paths(self, op, args.clone())?;
        let material =
            match bounded_material(self, op, args.clone(), body.as_deref(), preview_key, cancel) {
                Ok(material) => material,
                Err(error) => {
                    let material = fallback_material(op, args)?;
                    let preview_etag = token(
                        preview_key,
                        op,
                        &material.args,
                        body.as_deref(),
                        &material.fingerprints,
                    )?;
                    let child = SupervisedChildInput {
                        roots: self.policy.root_snapshot(),
                        op: op.to_string(),
                        args: material.args,
                        preview_etag,
                        blocked: Some(error.code),
                    };
                    return Ok(PreparedSupervised { child, apply: None });
                }
            };
        match build(self, op, args, body.as_deref(), preview_key, cancel) {
            Ok(built) => {
                if built.fingerprints != material.fingerprints {
                    let preview_etag = token(
                        preview_key,
                        op,
                        &material.args,
                        body.as_deref(),
                        &material.fingerprints,
                    )?;
                    let child = SupervisedChildInput {
                        roots: self.policy.root_snapshot(),
                        op: op.to_string(),
                        args: material.args,
                        preview_etag,
                        blocked: Some(ErrorCode::Conflict),
                    };
                    return Ok(PreparedSupervised { child, apply: None });
                }
                let preview_etag = token(
                    preview_key,
                    op,
                    &material.args,
                    body.as_deref(),
                    &material.fingerprints,
                )?;
                let child = SupervisedChildInput {
                    roots: self.policy.root_snapshot(),
                    op: op.to_string(),
                    args: material.args,
                    preview_etag,
                    blocked: None,
                };
                Ok(PreparedSupervised {
                    child,
                    apply: Some(built.apply),
                })
            }
            Err(error) => {
                let preview_etag = token(
                    preview_key,
                    op,
                    &material.args,
                    body.as_deref(),
                    &material.fingerprints,
                )?;
                let child = SupervisedChildInput {
                    roots: self.policy.root_snapshot(),
                    op: op.to_string(),
                    args: material.args,
                    preview_etag,
                    blocked: Some(error.code),
                };
                Ok(PreparedSupervised { child, apply: None })
            }
        }
    }

    pub fn preview_supervised(
        &self,
        op: &str,
        args: Value,
        body: Option<&[u8]>,
        preview_key: &EtagKey,
        cancel: &Cancel,
    ) -> FileResult<SupervisedPreview> {
        let mut preview_ops = FileOps::new(self.policy.clone(), preview_key.clone());
        preview_ops.hook.clone_from(&self.hook);
        #[cfg(test)]
        preview_ops.set_rename_atomic_capability(self.rename_atomic_capability());
        static_validate(op, args.clone(), body)?;
        precheck_paths(&preview_ops, op, args.clone())?;
        let material =
            match bounded_material(&preview_ops, op, args.clone(), body, preview_key, cancel) {
                Ok(material) => material,
                Err(error) => {
                    let material = fallback_material(op, args)?;
                    let preview_etag = token(
                        preview_key,
                        op,
                        &material.args,
                        body,
                        &material.fingerprints,
                    )?;
                    return Ok(SupervisedPreview::Blocked {
                        code: error.code,
                        operation: op.to_string(),
                        paths: material.paths.into_iter().map(|(_, path)| path).collect(),
                        preview_etag,
                    });
                }
            };
        match build(&preview_ops, op, args, body, preview_key, cancel) {
            Ok(built) => {
                if built.fingerprints != material.fingerprints {
                    let preview_etag = token(
                        preview_key,
                        op,
                        &material.args,
                        body,
                        &material.fingerprints,
                    )?;
                    return Ok(SupervisedPreview::Blocked {
                        code: ErrorCode::Conflict,
                        operation: op.to_string(),
                        paths: material.paths.into_iter().map(|(_, path)| path).collect(),
                        preview_etag,
                    });
                }
                let preview_etag = token(
                    preview_key,
                    op,
                    &material.args,
                    body,
                    &material.fingerprints,
                )?;
                Ok(SupervisedPreview::Allowed(AllowedPreview {
                    operation: op.to_string(),
                    paths: built.paths,
                    description: built.description,
                    diff: built.diff,
                    preview_etag,
                }))
            }
            Err(error) => {
                let preview_etag = token(
                    preview_key,
                    op,
                    &material.args,
                    body,
                    &material.fingerprints,
                )?;
                Ok(SupervisedPreview::Blocked {
                    code: error.code,
                    operation: op.to_string(),
                    paths: material.paths.into_iter().map(|(_, path)| path).collect(),
                    preview_etag,
                })
            }
        }
    }

    pub fn execute_supervised(
        &self,
        prepared: PreparedSupervised,
        cancel: &Cancel,
    ) -> FileResult<Value> {
        self.policy.check_process()?;
        let op = prepared
            .apply
            .ok_or_else(|| FileError::new(ErrorCode::Conflict, "request was blocked at preview"))?;
        let result = match op {
            PreparedOp::Edit(args, pin) => {
                serde_json::to_value(edit::edit_supervised(self, &args, &pin, cancel)?)
            }
            PreparedOp::Write(args, pin) => {
                serde_json::to_value(write::write_supervised(self, &args, &pin, cancel)?)
            }
            PreparedOp::Rename(args, from, to) => serde_json::to_value(
                super::mutate::rename_supervised(self, &args, &from, &to, cancel)?,
            ),
            PreparedOp::Mkdir(args, pin) => {
                serde_json::to_value(super::mutate::mkdir_supervised(self, &args, &pin, cancel)?)
            }
            PreparedOp::Delete(args, pin) => {
                serde_json::to_value(super::mutate::delete_supervised(self, &args, &pin, cancel)?)
            }
        }
        .map_err(|error| FileError::new(ErrorCode::IoError, format!("result encoding: {error}")))?;
        Ok(result)
    }
}

pub fn preview_supervised_child(
    op: &str,
    args: Value,
    body: Option<&[u8]>,
    preview_key: &EtagKey,
    allow_root: bool,
    roots: super::RootSnapshot,
) -> FileResult<SupervisedPreview> {
    let ops = FileOps::new(
        super::Policy::from_root_snapshot(roots, allow_root),
        preview_key.clone(),
    );
    ops.preview_supervised(op, args, body, preview_key, &Cancel::new())
}

#[cfg(test)]
mod argument_size_tests {
    use super::*;

    #[test]
    fn child_args_accept_exact_cap_and_refuse_one_more_byte() {
        // Empty string JSON is two bytes; exercise serialized size, not characters.
        for (bytes, allowed) in [
            (MAX_CHILD_ARGS_BYTES, true),
            (MAX_CHILD_ARGS_BYTES + 1, false),
        ] {
            let args = Value::String("x".repeat(bytes - 2));
            assert_eq!(serde_json::to_vec(&args).unwrap().len(), bytes);
            let result = check_args_size(&args);
            if allowed {
                result.expect("the exact cap is allowed");
            } else {
                assert_eq!(result.unwrap_err().code, ErrorCode::TooLarge);
            }
        }
    }

    #[test]
    fn child_args_cap_reserves_linux_exec_name_equals_and_terminator() {
        assert_eq!(MAX_CHILD_ARGS_BYTES, 128 * 1024 - 256);
        assert!(include_str!("../sessions/supervised_pty.rs").contains(
            "pub(crate) const SUPERVISED_ENV_FILE_ARGS: &str = \"WSMP_SUPERVISED_FILE_ARGS\";"
        ));
        let full_string = "WSMP_SUPERVISED_FILE_ARGS".len() + 1 + MAX_CHILD_ARGS_BYTES + 1;
        assert!(
            full_string < 131_072,
            "exec string occupies {full_string} bytes"
        );
    }
}

#[cfg(test)]
mod rename_description_tests {
    use std::ffi::OsStr;

    use super::*;

    fn file(ino: u64, size: u64) -> Stat {
        Stat {
            mode: 0o100_640,
            uid: 1000,
            gid: 1000,
            nlink: 1,
            size,
            dev: 1,
            ino,
            mtime_secs: 0,
            mtime_nanos: 0,
        }
    }

    /// label, overwrite, destination, from name, to name, expected first line
    type Case<'a> = (&'a str, bool, Option<&'a Stat>, &'a str, &'a str, &'a str);

    fn dir() -> Stat {
        Stat {
            mode: 0o040_700,
            ino: 20,
            ..file(0, 0)
        }
    }

    fn describe(
        overwrite: bool,
        src: &Stat,
        dst: Option<&Stat>,
        from_name: &str,
        to_name: &str,
    ) -> Vec<String> {
        let dir = dir();
        rename_description(
            overwrite,
            src,
            dst,
            (&dir, Some(OsStr::new(from_name))),
            (&dir, Some(OsStr::new(to_name))),
        )
    }

    /// C7b-1: on a case-insensitive volume the destination of a case-only
    /// respelling is the source itself, and apply renames it in place. The confirm
    /// screen must not call that an overwrite; every genuine overwrite still says so.
    #[test]
    fn case_only_respelling_is_not_labelled_an_overwrite() {
        let src = file(10, 4);
        let other = file(11, 9);
        let mut aliased_links = file(10, 4);
        aliased_links.nlink = 2;
        let mut other_volume = file(10, 4);
        other_volume.dev = 2;
        let cases: [Case<'_>; 8] = [
            (
                "case-only same file",
                true,
                Some(&src),
                "a.txt",
                "A.TXT",
                "overwrite: false (case-only",
            ),
            (
                "case-only but a hard-linked file is refused at apply, not relabelled",
                true,
                Some(&aliased_links),
                "a.txt",
                "A.TXT",
                "overwrite: true",
            ),
            (
                "same inode on another device is another file",
                true,
                Some(&other_volume),
                "a.txt",
                "A.TXT",
                "overwrite: true",
            ),
            (
                "same name spelling is not a respelling",
                true,
                Some(&src),
                "a.txt",
                "a.txt",
                "overwrite: true",
            ),
            (
                "different names, same inode (alias)",
                true,
                Some(&src),
                "a.txt",
                "b.txt",
                "overwrite: true",
            ),
            (
                "overwriting a different file",
                true,
                Some(&other),
                "a.txt",
                "A.TXT",
                "overwrite: true",
            ),
            (
                "no destination",
                true,
                None,
                "a.txt",
                "A.TXT",
                "overwrite: true",
            ),
            (
                "overwrite off",
                false,
                Some(&src),
                "a.txt",
                "A.TXT",
                "overwrite: false",
            ),
        ];
        for (label, overwrite, dst, from, to, expected) in cases {
            let lines = describe(overwrite, &src, dst, from, to);
            assert!(lines[0].starts_with(expected), "{label}: {lines:?}");
            let case_only = expected.contains("case-only");
            assert_eq!(
                lines[1].starts_with("size: "),
                case_only,
                "{label}: {lines:?}"
            );
            assert_eq!(
                lines.last().map(String::as_str),
                Some("mode: 0640 (preserved)"),
                "{label}"
            );
        }
        assert_eq!(
            describe(true, &src, Some(&other), "a.txt", "b.txt")[1],
            "source: 4 bytes; destination: 9 bytes"
        );
    }
}
