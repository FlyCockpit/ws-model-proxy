//! Sorted directory walk shared by `dir_list` and `file_search` (Windows; the
//! Unix walk holds directory fds).
//!
//! The walk never follows a link or a junction: it lists them, and before it
//! enters a directory it checks that the directory still resolves to its own
//! path, so one swapped for a junction mid-walk is skipped, not followed.
//! Read-denied protected paths are listed by name but never entered.

use std::path::Path;

use super::meta::{Kind, Stat};
use super::policy::Policy;
use super::resolve::DirHandle;
use crate::file_ops::error::{ErrorCode, FileError, FileResult};

/// Bound collection before sorting, independently of result pagination limits.
const MAX_DIRECTORY_ENTRIES: usize = 100_000;

#[cfg(test)]
#[path = "walk_test_support.rs"]
pub(in crate::file_ops) mod test_support;

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
    pub truncated_dirs: usize,
    pub stopped: bool,
}

/// Walk below `root` (already resolved) up to `max_depth` levels.
pub fn walk(
    policy: &Policy,
    root: &DirHandle,
    root_path: &Path,
    max_depth: usize,
    check: &mut dyn FnMut() -> FileResult<()>,
    visit: &mut dyn FnMut(&Entry<'_>) -> FileResult<Flow>,
) -> FileResult<WalkStats> {
    let mut stats = WalkStats::default();
    let mut rel = String::new();
    #[cfg(test)]
    let directory_limit = test_support::directory_limit();
    #[cfg(not(test))]
    let directory_limit = MAX_DIRECTORY_ENTRIES;
    walk_dir(
        policy,
        root,
        root_path,
        &mut rel,
        1,
        max_depth,
        directory_limit,
        check,
        visit,
        &mut stats,
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
    directory_limit: usize,
    check: &mut dyn FnMut() -> FileResult<()>,
    visit: &mut dyn FnMut(&Entry<'_>) -> FileResult<Flow>,
    stats: &mut WalkStats,
) -> FileResult<()> {
    let mut entries = read_entries(dir, check, directory_limit, depth == 1, stats)?;
    check()?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, entry) in entries {
        check()?;
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
                        directory_limit,
                        check,
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

fn read_entries(
    dir: &DirHandle,
    check: &mut dyn FnMut() -> FileResult<()>,
    limit: usize,
    is_root: bool,
    stats: &mut WalkStats,
) -> FileResult<Vec<(String, std::fs::DirEntry)>> {
    check()?;
    let mut entries = Vec::new();
    for (count, entry) in std::fs::read_dir(&dir.path)
        .map_err(|error| FileError::io(&error))?
        .enumerate()
    {
        check()?;
        let entry = entry.map_err(|error| FileError::io(&error))?;
        if count >= limit {
            if is_root {
                return Err(FileError::new(
                    ErrorCode::Limit,
                    "directory entry limit reached; narrow root",
                ));
            }
            stats.truncated_dirs += 1;
            break;
        }
        match entry.file_name().into_string() {
            Ok(name) => entries.push((name, entry)),
            Err(_) => stats.skipped_non_utf8 += 1,
        }
    }
    Ok(entries)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_enumeration_enforces_the_entry_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["a", "b", "c"] {
            std::fs::write(dir.path().join(name), b"").expect("file");
        }
        let root = || DirHandle {
            path: dir.path().to_path_buf(),
        };
        assert_eq!(
            read_entries(&root(), &mut || Ok(()), 3, true, &mut WalkStats::default())
                .expect("at cap")
                .len(),
            3
        );
        assert_eq!(
            read_entries(&root(), &mut || Ok(()), 2, true, &mut WalkStats::default())
                .expect_err("over cap")
                .code,
            ErrorCode::Limit
        );
    }

    #[test]
    fn nested_directory_cap_truncates_and_continues_with_siblings() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(dir.path().join("a-large")).expect("nested dir");
        for name in ["one", "two", "three"] {
            std::fs::write(dir.path().join("a-large").join(name), b"").expect("file");
        }
        std::fs::create_dir(dir.path().join("z-sibling")).expect("sibling dir");
        std::fs::write(dir.path().join("z-sibling/keep"), b"").expect("sibling file");
        let root = DirHandle {
            path: dir.path().to_path_buf(),
        };
        let policy = Policy::new(vec![], vec![], true);
        let mut stats = WalkStats::default();
        let mut visited = Vec::new();
        walk_dir(
            &policy,
            &root,
            dir.path(),
            &mut String::new(),
            1,
            3,
            2,
            &mut || Ok(()),
            &mut |entry| {
                visited.push(entry.rel.to_string());
                Ok(Flow::Continue)
            },
            &mut stats,
        )
        .expect("partial walk");
        assert_eq!(stats.truncated_dirs, 1);
        assert!(!stats.stopped);
        assert_eq!(
            visited
                .iter()
                .filter(|rel| rel.starts_with("a-large/"))
                .count(),
            2
        );
        assert!(visited.iter().any(|rel| rel == "z-sibling/keep"));
        assert_eq!(visited.len(), 5);
    }

    #[test]
    fn root_directory_cap_still_fails_before_visiting_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["a", "b", "c"] {
            std::fs::write(dir.path().join(name), b"").expect("file");
        }
        let root = DirHandle {
            path: dir.path().to_path_buf(),
        };
        let policy = Policy::new(vec![], vec![], true);
        let mut stats = WalkStats::default();
        let mut visited = 0;
        let error = walk_dir(
            &policy,
            &root,
            dir.path(),
            &mut String::new(),
            1,
            3,
            2,
            &mut || Ok(()),
            &mut |_| {
                visited += 1;
                Ok(Flow::Continue)
            },
            &mut stats,
        )
        .expect_err("root over cap");
        assert_eq!(error.code, ErrorCode::Limit);
        assert_eq!(visited, 0);
        assert_eq!(stats.truncated_dirs, 0);
    }

    #[test]
    fn directory_enumeration_checks_cancellation_while_reading_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        for n in 0..10 {
            std::fs::write(dir.path().join(n.to_string()), b"").expect("file");
        }
        let root = || DirHandle {
            path: dir.path().to_path_buf(),
        };
        let mut calls = 0;
        let mut check = || {
            calls += 1;
            if calls == 3 {
                Err(FileError::cancelled())
            } else {
                Ok(())
            }
        };
        assert_eq!(
            read_entries(
                &root(),
                &mut check,
                MAX_DIRECTORY_ENTRIES,
                true,
                &mut WalkStats::default()
            )
            .expect_err("cancel during enumeration")
            .code,
            ErrorCode::Cancelled
        );
        assert_eq!(calls, 3);
    }

    #[test]
    fn walk_deadline_stops_enumeration_before_visiting_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("a"), b"").expect("file");
        let root = || DirHandle {
            path: dir.path().to_path_buf(),
        };
        let policy = Policy::new(vec![], vec![], true);
        let mut visited = 0;
        let mut checked = 0;
        let error = walk(
            &policy,
            &root(),
            dir.path(),
            1,
            &mut || {
                checked += 1;
                if checked == 2 {
                    Err(FileError::new(ErrorCode::Timeout, "deadline"))
                } else {
                    Ok(())
                }
            },
            &mut |_| {
                visited += 1;
                Ok(Flow::Continue)
            },
        )
        .expect_err("deadline");
        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(visited, 0);
        assert_eq!(checked, 2);
    }
}
