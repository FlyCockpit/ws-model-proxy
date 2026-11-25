//! `forwarder_cli_dir_list`: compact sorted listing, one entry per line.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

use super::glob::Glob;
use super::text::name_for_display;
use crate::file_ops::context::OpContext;
use crate::file_ops::error::{FileError, FileResult};
use crate::file_ops::fs::meta::Kind;
use crate::file_ops::fs::policy::Access;
use crate::file_ops::fs::resolve::{ResolveOpts, resolve};
use crate::file_ops::fs::walk::{Flow, walk};
use crate::file_ops::{Cancel, fmt};

pub const DEFAULT_ENTRIES: u32 = 200;
pub const MAX_ENTRIES: u32 = 2000;
pub const MAX_DEPTH: u32 = 4;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
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

pub(crate) fn list(ops: &OpContext, args: &ListArgs, cancel: &Cancel) -> FileResult<ListResult> {
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
            cancel: None,
        },
    )?;
    let root = resolved.open_dir()?;
    let root_path = resolved.full_path();
    let prefix = name_for_display(args.path.trim_end_matches('/'));

    let mut lines: Vec<String> = Vec::new();
    let mut last_rel = String::new();
    let mut more = None;
    let mut visit = |entry: &crate::file_ops::fs::walk::Entry<'_>| -> FileResult<Flow> {
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
        let shown = format!("{prefix}/{}", name_for_display(entry.rel));
        lines.push(match entry.kind {
            Kind::Dir => format!("d {shown}/"),
            Kind::File => format!(
                "f {} {} {shown}",
                fmt::human_size(entry.stat.size),
                fmt::date_only(entry.stat.mtime())
            ),
            Kind::Symlink => {
                let target = crate::file_ops::fs::resolve::read_link_at(entry.parent, entry.name)
                    .unwrap_or_default();
                format!("l {shown} -> {}", name_for_display(&target))
            }
            Kind::Other => format!("o {shown}"),
        });
        last_rel = entry.rel.to_string();
        Ok(Flow::Continue)
    };
    let stats = walk(
        &ops.policy,
        &root,
        &root_path,
        depth,
        &mut || cancel.check(),
        &mut visit,
    )?;
    if stats.truncated_dirs > 0 && more.is_none() {
        more = Some(ListMore {
            cursor: URL_SAFE_NO_PAD.encode(&last_rel),
        });
    }
    Ok(ListResult {
        count: lines.len(),
        entries: lines.join("\n"),
        more,
        resolved_path: resolved.echo(&args.path),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_ops::fs::walk::test_support::{truncated_tree, with_directory_limit};

    #[test]
    fn list_reports_nested_directory_truncation_through_more() {
        let (_dir, ops, root) = truncated_tree();
        let args = ListArgs {
            path: crate::file_ops::display_path(&root).expect("display path"),
            depth: Some(2),
            glob: Some("*.txt".into()),
            ..ListArgs::default()
        };
        let result = with_directory_limit(2, || ops.dir_list(&args, &Cancel::new()))
            .expect("partial listing");
        assert_eq!(result.count, 2); // directory plus the untruncated sibling
        assert!(result.entries.ends_with("z-sibling.txt"));
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(result.more.expect("incomplete").cursor)
                .expect("cursor"),
            b"z-sibling.txt"
        );
        assert!(
            ops.dir_list(&args, &Cancel::new())
                .expect("complete listing")
                .more
                .is_none()
        );
    }

    #[test]
    fn list_truncation_preserves_the_pagination_cursor() {
        let (_dir, ops, root) = truncated_tree();
        let args = ListArgs {
            path: crate::file_ops::display_path(&root).expect("display path"),
            depth: Some(2),
            max_entries: Some(1),
            ..ListArgs::default()
        };
        let result =
            with_directory_limit(2, || ops.dir_list(&args, &Cancel::new())).expect("first page");
        assert_eq!(result.count, 1);
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(result.more.expect("next page").cursor)
                .expect("cursor"),
            b"a-large"
        );
    }
}
