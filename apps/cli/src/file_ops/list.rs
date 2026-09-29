//! `forwarder_cli_dir_list`: compact sorted listing, one entry per line.

use std::os::fd::AsFd;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use nix::fcntl::readlinkat;
use serde::{Deserialize, Serialize};

use super::error::{FileError, FileResult};
use super::glob::Glob;
use super::policy::Access;
use super::resolve::{Kind, ResolveOpts, resolve};
use super::walk::{Flow, walk};
use super::{Cancel, FileOps, fmt};

pub const DEFAULT_ENTRIES: u32 = 200;
pub const MAX_ENTRIES: u32 = 2000;
pub const MAX_DEPTH: u32 = 4;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListArgs {
    pub path: String,
    /// 1..4; 1 lists the direct children.
    pub depth: Option<u32>,
    pub glob: Option<String>,
    pub include_hidden: Option<bool>,
    pub max_entries: Option<u32>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListMore {
    pub cursor: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    /// `d path/`, `f size date path`, `l path -> target`, `o path`, per line.
    pub entries: String,
    pub count: usize,
    pub more: Option<ListMore>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
}

pub fn list(ops: &FileOps, args: &ListArgs, cancel: &Cancel) -> FileResult<ListResult> {
    let depth = args.depth.unwrap_or(1).clamp(1, MAX_DEPTH) as usize;
    let max_entries = args
        .max_entries
        .unwrap_or(DEFAULT_ENTRIES)
        .clamp(1, MAX_ENTRIES) as usize;
    let include_hidden = args.include_hidden.unwrap_or(false);
    let glob = args
        .glob
        .as_deref()
        .map(Glob::new)
        .transpose()
        .map_err(FileError::invalid)?;
    let cursor: Option<Vec<String>> = match &args.cursor {
        None => None,
        Some(token) => {
            let bytes = URL_SAFE_NO_PAD
                .decode(token)
                .map_err(|_| FileError::invalid("cursor is not valid"))?;
            let text =
                String::from_utf8(bytes).map_err(|_| FileError::invalid("cursor is not valid"))?;
            Some(text.split('/').map(str::to_string).collect())
        }
    };

    let resolved = resolve(
        &args.path,
        &ResolveOpts {
            follow_last: true,
            make_parents: None,
            policy: &ops.policy,
            access: Access::Read,
        },
    )?;
    let root = resolved.open_dir()?;
    let root_path = resolved.full_path();
    let prefix = args.path.trim_end_matches('/').to_string();

    let mut lines: Vec<String> = Vec::new();
    let mut last_rel = String::new();
    let mut more = None;
    let mut visit = |entry: &super::walk::Entry<'_>| -> FileResult<Flow> {
        cancel.check()?;
        if !include_hidden && entry.name.starts_with('.') {
            return Ok(Flow::SkipDescend);
        }
        let is_dir = entry.kind == Kind::Dir;
        if let Some(cursor) = &cursor {
            let comps: Vec<String> = entry.rel.split('/').map(str::to_string).collect();
            match comps.cmp(cursor) {
                std::cmp::Ordering::Less => {
                    return Ok(if is_dir && cursor.starts_with(&comps) {
                        Flow::Continue
                    } else {
                        Flow::SkipDescend
                    });
                }
                std::cmp::Ordering::Equal => return Ok(Flow::Continue),
                std::cmp::Ordering::Greater => {}
            }
        }
        if !is_dir
            && let Some(glob) = &glob
            && !glob.matches(entry.name, entry.rel)
        {
            return Ok(Flow::Continue);
        }
        if lines.len() >= max_entries {
            more = Some(ListMore {
                cursor: URL_SAFE_NO_PAD.encode(&last_rel),
            });
            return Ok(Flow::Stop);
        }
        let shown = format!("{prefix}/{}", entry.rel);
        lines.push(match entry.kind {
            Kind::Dir => format!("d {shown}/"),
            Kind::File => format!(
                "f {} {} {shown}",
                fmt::human_size(entry.stat.size),
                fmt::date_only(entry.stat.mtime())
            ),
            Kind::Symlink => {
                let target = readlinkat(entry.parent.as_fd(), entry.name)
                    .ok()
                    .and_then(|t| t.into_string().ok())
                    .unwrap_or_default();
                format!("l {shown} -> {target}")
            }
            Kind::Other => format!("o {shown}"),
        });
        last_rel = entry.rel.to_string();
        Ok(Flow::Continue)
    };
    walk(&ops.policy, &root, &root_path, depth, &mut visit)?;
    Ok(ListResult {
        count: lines.len(),
        entries: lines.join("\n"),
        more,
        resolved_path: resolved.echo(&args.path),
    })
}
