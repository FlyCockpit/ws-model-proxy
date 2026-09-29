//! fd-based, component-by-component path resolution (plan section 3.2).
//!
//! `resolve` walks from `/` one component at a time on directory fds:
//!
//! - every intermediate component is opened with
//!   `openat(dirfd, name, O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)`;
//! - when that fails because the component is a symlink, the link is read with
//!   `readlinkat` and its target is spliced into the remaining components (at
//!   most [`MAX_SYMLINK_HOPS`] times), so symlinks are followed but only by us,
//!   one step at a time, on fds;
//! - `..` is `openat(dirfd, "..")` on the held fd, i.e. it is resolved against
//!   the **physical** directory reached so far, never lexically;
//! - the leaf is returned as (held parent fd, name), never opened by path, so
//!   the caller opens it with `O_NOFOLLOW` and then checks the fd it holds.
//!
//! The path policy is applied to the physical path of the held parent fd (read
//! from `/proc/self/fd` on Linux, which reflects the directory actually held
//! even if a name was swapped after the walk; on other Unixes the path built
//! from the names walked is used).

use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::fs::{File, Metadata};
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use nix::errno::Errno;
use nix::fcntl::{OFlag, openat, readlinkat};
use nix::sys::stat::{Mode, fstatat, mkdirat};
use nix::unistd::{UnlinkatFlags, unlinkat};

use super::atomic::perm_mode;
use super::error::{ErrorCode, FileError, FileResult};
use super::policy::{Access, Policy};

pub const MAX_SYMLINK_HOPS: usize = 40;
pub const MAX_PATH_BYTES: usize = 4096;

const S_IFMT: u32 = 0o170_000;
const S_IFREG: u32 = 0o100_000;
const S_IFDIR: u32 = 0o040_000;
const S_IFLNK: u32 = 0o120_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Symlink,
    Other,
}

/// Portable subset of `stat(2)`.
#[derive(Debug, Clone, Copy)]
pub struct Stat {
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub nlink: u64,
    pub size: u64,
    pub dev: u64,
    pub ino: u64,
    pub mtime_secs: i64,
    pub mtime_nanos: i64,
}

impl Stat {
    pub fn from_metadata(meta: &Metadata) -> Self {
        Self {
            mode: meta.mode(),
            uid: meta.uid(),
            gid: meta.gid(),
            nlink: meta.nlink(),
            size: meta.len(),
            dev: meta.dev(),
            ino: meta.ino(),
            mtime_secs: meta.mtime(),
            mtime_nanos: meta.mtime_nsec(),
        }
    }

    #[allow(clippy::unnecessary_cast, clippy::useless_conversion)]
    pub(crate) fn from_raw(st: &nix::sys::stat::FileStat) -> Self {
        Self {
            mode: st.st_mode as u32,
            uid: st.st_uid as u32,
            gid: st.st_gid as u32,
            nlink: st.st_nlink as u64,
            size: st.st_size.max(0) as u64,
            dev: st.st_dev as u64,
            ino: st.st_ino as u64,
            mtime_secs: st.st_mtime as i64,
            mtime_nanos: st.st_mtime_nsec as i64,
        }
    }

    pub fn kind(&self) -> Kind {
        match self.mode & S_IFMT {
            S_IFREG => Kind::File,
            S_IFDIR => Kind::Dir,
            S_IFLNK => Kind::Symlink,
            _ => Kind::Other,
        }
    }

    pub fn mtime(&self) -> std::time::SystemTime {
        let secs = self.mtime_secs.max(0) as u64;
        std::time::UNIX_EPOCH
            + std::time::Duration::new(secs, self.mtime_nanos.clamp(0, 999_999_999) as u32)
    }

    pub fn same_object(&self, other: &Stat) -> bool {
        self.dev == other.dev && self.ino == other.ino
    }
}

/// A directory created by `makeParents`, kept so a failed write can undo it.
#[derive(Debug)]
pub struct CreatedDir {
    pub parent: OwnedFd,
    pub name: OsString,
}

/// A resolved path: a held directory fd plus the leaf name inside it.
/// `name == "."` means the path names the directory `dir` itself.
#[derive(Debug)]
pub struct Resolved {
    pub dir: OwnedFd,
    pub dir_path: PathBuf,
    pub name: OsString,
    pub created: Vec<CreatedDir>,
}

pub struct ResolveOpts<'a> {
    /// Follow a symlink in the last component. `false` for stat, rename source,
    /// and delete, which act on the link itself.
    pub follow_last: bool,
    /// Create missing intermediate directories with this mode.
    pub make_parents: Option<u32>,
    pub policy: &'a Policy,
    pub access: Access,
}

impl Resolved {
    pub fn is_self(&self) -> bool {
        self.name == "."
    }

    /// The physical path of the object.
    pub fn full_path(&self) -> PathBuf {
        if self.is_self() {
            self.dir_path.clone()
        } else {
            self.dir_path.join(&self.name)
        }
    }

    /// `Some(physical path)` when it differs from what the caller passed.
    pub fn echo(&self, input: &str) -> Option<String> {
        let physical = self.full_path();
        let physical = physical.to_str()?;
        (physical != input).then(|| physical.to_string())
    }

    /// `fstatat(dir, name, NOFOLLOW)`; `None` when the leaf does not exist.
    pub fn lstat(&self) -> FileResult<Option<Stat>> {
        match fstatat(
            self.dir.as_fd(),
            self.name.as_os_str(),
            nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW,
        ) {
            Ok(st) => Ok(Some(Stat::from_raw(&st))),
            Err(Errno::ENOENT) => Ok(None),
            Err(errno) => Err(FileError::errno(errno)),
        }
    }

    /// Open the leaf as a directory (the held dir itself for `.`).
    pub fn open_dir(&self) -> FileResult<OwnedFd> {
        openat(
            self.dir.as_fd(),
            self.name.as_os_str(),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|errno| match errno {
            Errno::ENOTDIR | Errno::ELOOP => {
                FileError::new(ErrorCode::NotADir, "path is not a directory")
            }
            other => FileError::errno(other),
        })
    }

    /// Open the leaf read-only as a regular file: the fd is fstat'ed after the
    /// open and must be a regular file that is not a protected inode.
    pub fn open_regular(&self, policy: &Policy, access: Access) -> FileResult<(File, Stat)> {
        if self.is_self() {
            return Err(FileError::new(ErrorCode::NotAFile, "path is a directory"));
        }
        match self.lstat()? {
            None => return Err(FileError::new(ErrorCode::NotFound, "no such file")),
            Some(st) => check_openable(st.kind())?,
        }
        let fd = openat(
            self.dir.as_fd(),
            self.name.as_os_str(),
            OFlag::O_RDONLY
                | OFlag::O_NOFOLLOW
                | OFlag::O_NONBLOCK
                | OFlag::O_CLOEXEC
                | OFlag::O_NOCTTY,
            Mode::empty(),
        )
        .map_err(|errno| match errno {
            Errno::ELOOP => FileError::new(ErrorCode::SpecialFile, "path changed to a symlink"),
            other => FileError::errno(other),
        })?;
        let file = File::from(fd);
        let stat = Stat::from_metadata(&file.metadata()?);
        check_openable(stat.kind())?;
        policy.check_identity(access, &stat)?;
        Ok((file, stat))
    }

    /// Undo directories created by `makeParents` (newest first).
    pub fn rollback_created(&mut self) {
        while let Some(created) = self.created.pop() {
            let _ = unlinkat(
                created.parent.as_fd(),
                created.name.as_os_str(),
                UnlinkatFlags::RemoveDir,
            );
        }
    }
}

fn check_openable(kind: Kind) -> FileResult<()> {
    match kind {
        Kind::File => Ok(()),
        Kind::Dir => Err(FileError::new(ErrorCode::NotAFile, "path is a directory")),
        Kind::Symlink | Kind::Other => Err(FileError::new(
            ErrorCode::SpecialFile,
            "path is not a regular file",
        )),
    }
}

/// Validate and expand `~`: absolute or `~/...`, no NUL, at most 4096 bytes.
pub fn expand(input: &str) -> FileResult<PathBuf> {
    if input.is_empty() || input.len() > MAX_PATH_BYTES {
        return Err(FileError::invalid("path must be 1 to 4096 bytes"));
    }
    if input.contains('\0') {
        return Err(FileError::invalid("path contains a NUL byte"));
    }
    if input == "~" || input.starts_with("~/") {
        let home = dirs::home_dir()
            .ok_or_else(|| FileError::invalid("cannot determine the home directory"))?;
        let rest = input.strip_prefix("~/").unwrap_or("");
        return Ok(home.join(rest));
    }
    if input.starts_with('/') {
        return Ok(PathBuf::from(input));
    }
    Err(FileError::invalid("path must be absolute or start with ~/"))
}

fn split_components(path: &OsStr) -> VecDeque<OsString> {
    path.as_bytes()
        .split(|b| *b == b'/')
        .filter(|c| !c.is_empty() && *c != b".")
        .map(|c| OsString::from_vec(c.to_vec()))
        .collect()
}

fn open_root() -> FileResult<OwnedFd> {
    openat(
        nix::fcntl::AT_FDCWD,
        "/",
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(FileError::errno)
}

fn open_dir_at(dir: &OwnedFd, name: &OsStr) -> Result<OwnedFd, Errno> {
    openat(
        dir.as_fd(),
        name,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
}

/// The physical path of a directory fd, when the OS can tell us.
fn fd_path(fd: &OwnedFd) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let path = std::fs::read_link(format!("/proc/self/fd/{}", fd.as_raw_fd())).ok()?;
        // A directory unlinked after the walk reads as "<path> (deleted)".
        if path.as_os_str().as_bytes().ends_with(b" (deleted)") {
            return None;
        }
        Some(path)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = fd;
        None
    }
}

/// Resolve `input` and apply the policy to the result. This is the one
/// enforcement point for every file tool path.
pub fn resolve(input: &str, opts: &ResolveOpts<'_>) -> FileResult<Resolved> {
    let expanded = expand(input)?;
    let mut remaining = split_components(expanded.as_os_str());
    let mut cur = open_root()?;
    let mut names: Vec<OsString> = Vec::new();
    let mut hops = 0_usize;
    let mut created: Vec<CreatedDir> = Vec::new();
    let mut leaf: Option<OsString> = None;

    let result = (|| -> FileResult<()> {
        while let Some(comp) = remaining.pop_front() {
            if comp == ".." {
                cur = open_dir_at(&cur, OsStr::new("..")).map_err(FileError::errno)?;
                names.pop();
                continue;
            }
            let is_last = remaining.is_empty();
            if is_last {
                match fstatat(
                    cur.as_fd(),
                    comp.as_os_str(),
                    nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW,
                ) {
                    Ok(st) if opts.follow_last && Stat::from_raw(&st).kind() == Kind::Symlink => {
                        splice_link(&mut cur, &comp, &mut remaining, &mut names, &mut hops)?;
                        continue;
                    }
                    Ok(_) | Err(Errno::ENOENT) => {
                        leaf = Some(comp);
                        break;
                    }
                    Err(errno) => return Err(FileError::errno(errno)),
                }
            }
            match open_dir_at(&cur, &comp) {
                Ok(fd) => {
                    cur = fd;
                    names.push(comp);
                }
                Err(Errno::ELOOP | Errno::ENOTDIR) => {
                    splice_link(&mut cur, &comp, &mut remaining, &mut names, &mut hops)?;
                }
                Err(Errno::ENOENT) if opts.make_parents.is_some() => {
                    let mode = opts.make_parents.unwrap_or(0o755);
                    let here = fd_path(&cur).unwrap_or_else(|| join_names(&names));
                    opts.policy.check_path(Access::Write, &here.join(&comp))?;
                    mkdirat(cur.as_fd(), comp.as_os_str(), perm_mode(mode))
                        .map_err(FileError::errno)?;
                    let parent = cur.try_clone()?;
                    created.push(CreatedDir {
                        parent,
                        name: comp.clone(),
                    });
                    cur = open_dir_at(&cur, &comp).map_err(FileError::errno)?;
                    names.push(comp);
                }
                Err(errno) => return Err(FileError::errno(errno)),
            }
        }
        Ok(())
    })();

    let dir_path = fd_path(&cur).unwrap_or_else(|| join_names(&names));
    let mut resolved = Resolved {
        dir: cur,
        dir_path,
        name: leaf.unwrap_or_else(|| OsString::from(".")),
        created,
    };
    let checked = result.and_then(|()| {
        if fd_path(&resolved.dir).is_none() && cfg!(target_os = "linux") {
            return Err(FileError::new(ErrorCode::NotFound, "directory was removed"));
        }
        opts.policy.check_path(opts.access, &resolved.full_path())
    });
    if let Err(err) = checked {
        resolved.rollback_created();
        return Err(err);
    }
    Ok(resolved)
}

fn splice_link(
    cur: &mut OwnedFd,
    comp: &OsStr,
    remaining: &mut VecDeque<OsString>,
    names: &mut Vec<OsString>,
    hops: &mut usize,
) -> FileResult<()> {
    let target = match readlinkat(cur.as_fd(), comp) {
        Ok(target) => target,
        Err(Errno::EINVAL) => {
            return Err(FileError::new(
                ErrorCode::NotADir,
                "a path component is not a directory",
            ));
        }
        Err(errno) => return Err(FileError::errno(errno)),
    };
    *hops += 1;
    if *hops > MAX_SYMLINK_HOPS {
        return Err(FileError::new(ErrorCode::IoError, "ELOOP"));
    }
    if target.as_bytes().contains(&0) {
        return Err(FileError::invalid("symlink target contains a NUL byte"));
    }
    if target.to_str().is_none() {
        return Err(FileError::invalid("symlink target is not valid UTF-8"));
    }
    if target.as_bytes().first() == Some(&b'/') {
        *cur = open_root()?;
        names.clear();
    }
    for part in split_components(target.as_os_str()).into_iter().rev() {
        remaining.push_front(part);
    }
    Ok(())
}

fn join_names(names: &[OsString]) -> PathBuf {
    let mut path = PathBuf::from("/");
    for name in names {
        path.push(name);
    }
    path
}

/// `unlinkat` a leaf that this call created (used to roll back a failed create).
pub fn unlink_created(dir: &OwnedFd, name: &OsStr) {
    let _ = unlinkat(dir.as_fd(), name, UnlinkatFlags::NoRemoveDir);
}

pub fn path_of(dir_path: &Path, name: &OsStr) -> PathBuf {
    dir_path.join(name)
}
