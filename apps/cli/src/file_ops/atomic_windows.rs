//! Atomic replace and exclusive create on Windows (the Unix `atomic` works on
//! held directory fds and a crash-recovery journal; this one works on paths).
//!
//! Replace:
//! 1. create a staging file beside the target, `.<name>.wsmp-<10 alphanumerics>`
//!    (a name the policy keeps every other tool call away from), and check the
//!    handle's final path is that name in the target's directory;
//! 2. write the content and flush it to disk;
//! 3. re-check that the name still opens the file that was read (volume serial
//!    and file index) and that it still holds the bytes the content was derived
//!    from;
//! 4. honor cancellation (the last point where it is honored);
//! 5. rename the staging file over the target (one `MoveFileEx`-style rename
//!    with replace: readers see the old file or the new one, never a mix).
//!
//! Any failure before the rename removes the staging file. What this does not
//! do yet, unlike Unix: a crash between 1 and 5 leaves the staging file behind
//! (nothing reports or removes it), and a writer that replaces the target
//! between 3 and 5 is overwritten. The new file takes the directory's inherited
//! ACL and default attributes: an explicit ACL or the hidden or system attribute
//! of the replaced file is not carried over.
//!
//! Refused up front: hard-linked files (the rename would break the link) and
//! read-only files.

use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use rand::distr::{Alphanumeric, SampleString};

use super::error::{ErrorCode, FileError, FileResult};
use super::read::current_etag;
use super::resolve::{DirHandle, Stat};
use super::{Cancel, FileOps, Step};

/// Refuse files an atomic replace would damage.
pub(crate) fn check_replaceable(_ops: &FileOps, stat: &Stat) -> FileResult<()> {
    if stat.nlink > 1 {
        return Err(FileError::new(
            ErrorCode::HardLinked,
            "the file has several hard links; replacing it would break them (use the shell)",
        ));
    }
    if stat.mode & 0o222 == 0 {
        return Err(FileError::denied("the file is read-only"));
    }
    Ok(())
}

/// A file this call created, removed on drop unless it was published.
struct Staged {
    path: PathBuf,
    armed: bool,
}

impl Drop for Staged {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Create `path` (it must not exist) and check the handle opened that very
/// name, not a place a link swapped into the path after it was resolved.
fn create_exclusive(path: &Path) -> FileResult<(File, Staged)> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists => {
                FileError::new(ErrorCode::Exists, "the file already exists")
            }
            _ => FileError::io(&error),
        })?;
    let staged = Staged {
        path: path.to_path_buf(),
        armed: true,
    };
    let opened = wsmp_windows::final_path(&file)?;
    if !super::resolve::same_path(&opened, path) {
        return Err(FileError::new(
            ErrorCode::SpecialFile,
            "path changed while it was created",
        ));
    }
    Ok((file, staged))
}

/// Replace `name` in `dir` with `content`. `orig` is the open original (closed
/// before the rename) and `orig_etag` the etag of the bytes the new content was
/// derived from. Nothing is ever recovered here: the list is always empty.
#[allow(clippy::too_many_arguments)]
pub(crate) fn replace(
    ops: &FileOps,
    _dir: &DirHandle,
    name: &OsStr,
    dir_path: &Path,
    mut orig: File,
    orig_stat: &Stat,
    orig_etag: &str,
    content: &[u8],
    cancel: &Cancel,
) -> FileResult<(Stat, Vec<String>)> {
    check_replaceable(ops, orig_stat)?;
    let target = dir_path.join(name);
    let staging = dir_path.join(format!(
        ".{}.wsmp-{}",
        name.to_string_lossy(),
        Alphanumeric.sample_string(&mut rand::rng(), 10)
    ));
    let (mut tmp, mut staged) = create_exclusive(&staging)?;
    ops.step(Step::TempCreated)?;
    tmp.write_all(content)?;
    ops.step(Step::TempWritten)?;
    tmp.sync_all()?;
    ops.step(Step::TempSynced)?;
    drop(tmp);
    recheck(ops, &target, &mut orig, orig_stat, orig_etag, cancel)?;
    ops.step(Step::EtagRechecked)?;
    cancel.check()?;
    drop(orig);
    std::fs::rename(&staging, &target).map_err(|error| FileError::io(&error))?;
    staged.armed = false;
    let _ = ops.step(Step::Renamed);
    Ok((Stat::of_path(&target)?, Vec::new()))
}

/// The name must still open the file we read, and that file must still hold
/// the bytes the edit was computed from.
fn recheck(
    ops: &FileOps,
    target: &Path,
    orig: &mut File,
    orig_stat: &Stat,
    orig_etag: &str,
    cancel: &Cancel,
) -> FileResult<()> {
    let named = match Stat::of_path(target) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(FileError::conflict("gone"));
        }
        Err(error) => return Err(FileError::io(&error)),
    };
    if !named.same_object(orig_stat) {
        return Err(FileError::conflict("replaced"));
    }
    use std::io::Seek;
    orig.rewind()?;
    let now = Stat::of_file(orig)?;
    let current = current_etag(ops, orig, &now, cancel)?;
    if current != orig_etag {
        return Err(FileError::conflict(&current));
    }
    Ok(())
}

/// Exclusive create. A failed write removes the file it created. `mode` has no
/// meaning on Windows; callers refuse one before they get here.
pub(crate) fn create_new(
    ops: &FileOps,
    _dir: &DirHandle,
    dir_path: &Path,
    name: &OsStr,
    content: &[u8],
    _mode: u32,
) -> FileResult<(Stat, Vec<String>)> {
    let (mut file, mut staged) = create_exclusive(&dir_path.join(name))?;
    ops.step(Step::Created)?;
    file.write_all(content)?;
    file.sync_all()?;
    let stat = Stat::of_file(&file)?;
    staged.armed = false;
    Ok((stat, Vec::new()))
}
