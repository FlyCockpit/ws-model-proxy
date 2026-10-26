//! Sorted directory walk shared by `dir_list` and `file_search` (Windows; the
//! Unix walk holds directory fds).
//!
//! The walk never follows a link or a junction: it lists them, and before it
//! enters a directory it checks that the directory still resolves to its own
//! path, so one swapped for a junction mid-walk is skipped, not followed.
//! Read-denied protected paths are listed by name but never entered.

use std::path::Path;

use super::error::{FileError, FileResult};
use super::policy::Policy;
use super::resolve::{DirHandle, Kind, Stat};

pub struct Entry<'a> {
    pub name: &'a str,
    /// Path relative to the walk root, `/`-separated, without a leading slash.
    pub rel: &'a str,
    pub kind: Kind,
    pub stat: Stat,
    /// The directory containing this entry.
    pub parent: &'a DirHandle,
    pub full: &'a Path,
    /// Depth below the root: direct children are 1.
    #[allow(dead_code)]
    pub depth: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    Continue,
    /// Do not descend into this directory.
    SkipDescend,
    Stop,
}

#[derive(Debug, Default)]
pub struct WalkStats {
    pub skipped_non_utf8: usize,
    pub stopped: bool,
}

/// Walk below `root` (already resolved) up to `max_depth` levels.
pub fn walk(
    policy: &Policy,
    root: &DirHandle,
    root_path: &Path,
    max_depth: usize,
    visit: &mut dyn FnMut(&Entry<'_>) -> FileResult<Flow>,
) -> FileResult<WalkStats> {
    let mut stats = WalkStats::default();
    let mut rel = String::new();
    walk_dir(
        policy, root, root_path, &mut rel, 1, max_depth, visit, &mut stats,
    )?;
    Ok(stats)
}

#[allow(clippy::too_many_arguments)]
fn walk_dir(
    policy: &Policy,
    dir: &DirHandle,
    dir_path: &Path,
    rel: &mut String,
    depth: usize,
    max_depth: usize,
    visit: &mut dyn FnMut(&Entry<'_>) -> FileResult<Flow>,
    stats: &mut WalkStats,
) -> FileResult<()> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir.path).map_err(|error| FileError::io(&error))? {
        let entry = entry.map_err(|error| FileError::io(&error))?;
        match entry.file_name().into_string() {
            Ok(name) => entries.push((name, entry)),
            Err(_) => stats.skipped_non_utf8 += 1,
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, entry) in entries {
        if stats.stopped {
            return Ok(());
        }
        // The entry itself: a link or junction is not followed.
        let st = match entry.metadata() {
            Ok(meta) => Stat::from_metadata(&meta),
            // Removed while walking.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(FileError::io(&error)),
        };
        let full = dir_path.join(&name);
        let mark = rel.len();
        if !rel.is_empty() {
            rel.push('/');
        }
        rel.push_str(&name);
        let entry = Entry {
            name: &name,
            rel,
            kind: st.kind(),
            stat: st,
            parent: dir,
            full: &full,
            depth,
        };
        let flow = visit(&entry)?;
        // Hidden (read-denied protected) directories are listed by name so the
        // operator can see they exist, but are never entered.
        let hidden = policy.hidden_from_walk(&full);
        match flow {
            Flow::Stop => {
                stats.stopped = true;
                return Ok(());
            }
            Flow::SkipDescend => {}
            Flow::Continue => {
                if st.kind() == Kind::Dir && depth < max_depth && !hidden && still_itself(&full) {
                    let child = DirHandle { path: full.clone() };
                    walk_dir(
                        policy,
                        &child,
                        &full,
                        rel,
                        depth + 1,
                        max_depth,
                        visit,
                        stats,
                    )?;
                }
                // A directory swapped for a junction, removed or unreadable is skipped.
            }
        }
        rel.truncate(mark);
    }
    Ok(())
}

/// Whether `path` is still a directory that resolves to itself (not a link or
/// junction swapped in since it was listed).
fn still_itself(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return false;
    }
    std::fs::canonicalize(path).is_ok_and(|real| {
        let lower = |p: &Path| {
            p.to_string_lossy()
                .trim_start_matches(r"\\?\")
                .to_lowercase()
        };
        lower(&real) == lower(path)
    })
}
