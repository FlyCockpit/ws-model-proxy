//! `forwarder_cli_file_stat`: metadata for up to 50 paths, without following a
//! final symlink.

use nix::fcntl::readlinkat;
use nix::unistd::{Uid, User};
use serde::{Deserialize, Serialize};
use std::os::fd::AsFd;

use super::error::{ErrorCode, FileError, FileResult};
use super::etag::STRONG_ETAG_MAX_BYTES;
use super::policy::Access;
use super::read::load_all;
use super::resolve::{Kind, ResolveOpts, Stat, resolve};
use super::{Cancel, FileOps, fmt};

pub const MAX_STAT_PATHS: usize = 50;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatArgs {
    pub paths: Vec<String>,
    /// Compute a strong etag for files of 64 MiB or less.
    pub hash: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatEntry {
    pub path: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    /// Symlinks: the link text and the type of what it points at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StatResult {
    pub entries: Vec<StatEntry>,
}

pub(crate) fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::File => "file",
        Kind::Dir => "dir",
        Kind::Symlink => "symlink",
        Kind::Other => "other",
    }
}

pub(crate) fn owner_name(uid: u32) -> String {
    match User::from_uid(Uid::from_raw(uid)) {
        Ok(Some(user)) => user.name,
        _ => uid.to_string(),
    }
}

pub(crate) fn stat(ops: &FileOps, args: &StatArgs, cancel: &Cancel) -> FileResult<StatResult> {
    if args.paths.is_empty() || args.paths.len() > MAX_STAT_PATHS {
        return Err(FileError::invalid(format!(
            "paths must hold 1 to {MAX_STAT_PATHS} entries"
        )));
    }
    let hash = args.hash.unwrap_or(false);
    let mut entries = Vec::with_capacity(args.paths.len());
    for path in &args.paths {
        cancel.check()?;
        entries.push(match stat_one(ops, path, hash) {
            Ok(entry) => entry,
            Err(err) => StatEntry {
                path: path.clone(),
                error: Some(err.code.as_str()),
                ..StatEntry::default()
            },
        });
    }
    Ok(StatResult { entries })
}

fn stat_one(ops: &FileOps, path: &str, hash: bool) -> FileResult<StatEntry> {
    let opts = |follow_last| ResolveOpts {
        follow_last,
        make_parents: None,
        policy: &ops.policy,
        access: Access::Read,
    };
    let resolved = resolve(path, &opts(false))?;
    if resolved.is_self() {
        let st = Stat::from_metadata(&std::fs::File::from(resolved.open_dir()?).metadata()?);
        return Ok(entry_from(path, &st, resolved.echo(path)));
    }
    let st = resolved
        .lstat()?
        .ok_or_else(|| FileError::new(ErrorCode::NotFound, "no such file or directory"))?;
    ops.policy.check_identity(Access::Read, &st)?;
    let mut entry = entry_from(path, &st, resolved.echo(path));
    match st.kind() {
        Kind::File => {
            entry.etag = Some(if hash && st.size <= STRONG_ETAG_MAX_BYTES {
                let (mut file, opened) = resolved.open_regular(&ops.policy, Access::Read)?;
                let bytes = load_all(&mut file, &opened, STRONG_ETAG_MAX_BYTES)?;
                ops.key.strong(&bytes)
            } else {
                ops.key.weak_stat(&st)
            });
        }
        Kind::Symlink => {
            entry.etag = Some(ops.key.weak_stat(&st));
            entry.target = readlinkat(resolved.dir.as_fd(), resolved.name.as_os_str())
                .ok()
                .and_then(|target| target.into_string().ok());
            entry.target_type = Some(match resolve(path, &opts(true)) {
                Ok(target) => match target.is_self() {
                    true => "dir",
                    false => match target.lstat() {
                        Ok(Some(t)) => kind_name(t.kind()),
                        _ => "missing",
                    },
                },
                Err(err) if err.code == ErrorCode::NotFound => "missing",
                Err(_) => "denied",
            });
        }
        Kind::Dir | Kind::Other => {}
    }
    Ok(entry)
}

fn entry_from(path: &str, st: &Stat, resolved_path: Option<String>) -> StatEntry {
    StatEntry {
        path: path.to_string(),
        kind: Some(kind_name(st.kind())),
        size: (st.kind() == Kind::File).then_some(st.size),
        mtime: Some(fmt::rfc3339(st.mtime())),
        mode: Some(fmt::mode_string(st.mode)),
        owner: Some(owner_name(st.uid)),
        resolved_path,
        ..StatEntry::default()
    }
}
