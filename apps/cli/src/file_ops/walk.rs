//! Sorted, fd-based directory walk shared by `dir_list` and `file_search`.
//!
//! Children are opened relative to the held parent fd with `O_NOFOLLOW`, so the
//! walk never follows a symlink and a directory swapped for a symlink mid-walk
//! is refused instead of followed. Special trees (`/proc`, `/sys`, `/dev`) and
//! read-denied protected paths are never descended into.

use std::ffi::OsString;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use nix::dir::Dir;
use nix::fcntl::{AtFlags, OFlag, openat};
use nix::sys::stat::{Mode, fstatat};

use super::error::{ErrorCode, FileError, FileResult};
use super::meta::{Kind, Stat};
use super::policy::Policy;

/// Bound collection before sorting, independently of result pagination limits.
const MAX_DIRECTORY_ENTRIES: usize = 100_000;

#[cfg(test)]
#[path = "walk_test_support.rs"]
pub(super) mod test_support;

pub struct Entry<'a> {
    pub name: &'a str,
    /// Path relative to the walk root, `/`-separated, without a leading slash.
    pub rel: &'a str,
    pub kind: Kind,
    pub stat: Stat,
    /// The held directory containing this entry.
    pub parent: &'a OwnedFd,
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

/// Walk below `root` (already resolved and held) up to `max_depth` levels.
pub fn walk(
    policy: &Policy,
    root: &OwnedFd,
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
    dir: &OwnedFd,
    dir_path: &Path,
    rel: &mut String,
    depth: usize,
    max_depth: usize,
    directory_limit: usize,
    check: &mut dyn FnMut() -> FileResult<()>,
    visit: &mut dyn FnMut(&Entry<'_>) -> FileResult<Flow>,
    stats: &mut WalkStats,
) -> FileResult<()> {
    let mut names = read_names(dir, check, directory_limit, depth == 1, stats)?;
    check()?;
    names.sort();
    for raw in names {
        check()?;
        if stats.stopped {
            return Ok(());
        }
        let Ok(name) = String::from_utf8(raw.clone().into_vec()) else {
            stats.skipped_non_utf8 += 1;
            continue;
        };
        let st = match fstatat(dir.as_fd(), raw.as_os_str(), AtFlags::AT_SYMLINK_NOFOLLOW) {
            Ok(st) => Stat::from_raw(&st),
            // Removed while walking.
            Err(nix::errno::Errno::ENOENT) => continue,
            Err(errno) => return Err(FileError::errno(errno)),
        };
        let full = dir_path.join(&raw);
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
                if st.kind() == Kind::Dir
                    && depth < max_depth
                    && !hidden
                    && let Ok(child) = openat(
                        dir.as_fd(),
                        raw.as_os_str(),
                        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                        Mode::empty(),
                    )
                {
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
                // A failed open (swapped for a symlink, removed, unreadable) skips it.
            }
        }
        rel.truncate(mark);
    }
    Ok(())
}

fn read_names(
    dir: &OwnedFd,
    check: &mut dyn FnMut() -> FileResult<()>,
    limit: usize,
    is_root: bool,
    stats: &mut WalkStats,
) -> FileResult<Vec<OsString>> {
    check()?;
    let mut handle = Dir::from_fd(dir.try_clone()?).map_err(FileError::errno)?;
    let mut names = Vec::new();
    for entry in handle.iter() {
        check()?;
        let entry = entry.map_err(FileError::errno)?;
        let name = entry.file_name().to_bytes();
        if name == b"." || name == b".." {
            continue;
        }
        if names.len() >= limit {
            if is_root {
                return Err(FileError::new(
                    ErrorCode::Limit,
                    "directory entry limit reached; narrow root",
                ));
            }
            stats.truncated_dirs += 1;
            break;
        }
        names.push(OsString::from_vec(name.to_vec()));
    }
    Ok(names)
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
        let root = || -> OwnedFd { std::fs::File::open(dir.path()).expect("directory").into() };
        assert_eq!(
            read_names(&root(), &mut || Ok(()), 3, true, &mut WalkStats::default())
                .expect("at cap")
                .len(),
            3
        );
        assert_eq!(
            read_names(&root(), &mut || Ok(()), 2, true, &mut WalkStats::default())
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
        let root: OwnedFd = std::fs::File::open(dir.path()).expect("directory").into();
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
        let root: OwnedFd = std::fs::File::open(dir.path()).expect("directory").into();
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
        let root = || -> OwnedFd { std::fs::File::open(dir.path()).expect("directory").into() };
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
            read_names(
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
        let root = || -> OwnedFd { std::fs::File::open(dir.path()).expect("directory").into() };
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
