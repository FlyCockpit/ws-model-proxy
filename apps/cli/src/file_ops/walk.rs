//! Sorted, fd-based directory walk shared by `dir_list` and `file_search`.
//!
//! Children are opened relative to the held parent fd with `O_NOFOLLOW`, so the
//! walk never follows a symlink and a directory swapped for a symlink mid-walk
//! is refused instead of followed. Special trees (`/proc`, `/sys`, `/dev`) and
//! read-denied protected paths are never descended into.

use std::ffi::OsString;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

use nix::dir::Dir;
use nix::fcntl::{AtFlags, OFlag, openat};
use nix::sys::stat::{Mode, fstatat};

use super::error::{FileError, FileResult};
use super::policy::Policy;
use super::resolve::{Kind, Stat};

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

/// Walk below `root` (already resolved and held) up to `max_depth` levels.
pub fn walk(
    policy: &Policy,
    root: &OwnedFd,
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
    dir: &OwnedFd,
    dir_path: &Path,
    rel: &mut String,
    depth: usize,
    max_depth: usize,
    visit: &mut dyn FnMut(&Entry<'_>) -> FileResult<Flow>,
    stats: &mut WalkStats,
) -> FileResult<()> {
    let mut names = read_names(dir)?;
    names.sort();
    for raw in names {
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
        match flow {
            Flow::Stop => {
                stats.stopped = true;
                return Ok(());
            }
            Flow::SkipDescend => {}
            Flow::Continue => {
                if st.kind() == Kind::Dir
                    && depth < max_depth
                    && !policy.hidden_from_walk(&full)
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

fn read_names(dir: &OwnedFd) -> FileResult<Vec<OsString>> {
    let mut handle = Dir::from_fd(dir.try_clone()?).map_err(FileError::errno)?;
    let mut names = Vec::new();
    for entry in handle.iter() {
        let entry = entry.map_err(FileError::errno)?;
        let name = entry.file_name().to_bytes();
        if name == b"." || name == b".." {
            continue;
        }
        names.push(OsString::from_vec(name.to_vec()));
    }
    Ok(names)
}

pub fn dir_join(path: &Path, name: &str) -> PathBuf {
    path.join(name)
}
