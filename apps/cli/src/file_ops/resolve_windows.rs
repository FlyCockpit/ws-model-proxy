//! Windows path resolution for the read file tools (the Unix `resolve` is the
//! fd walk). Windows has no `openat`, so resolution works on paths and every
//! verdict is taken on the **object actually opened**:
//!
//! - paths arrive and leave in a POSIX view: `C:\Users\ada\x` is
//!   `/c/Users/ada/x` (drive letter lower-cased, `/` separators), the form the
//!   node advertises its file roots in, so the server's own root check works
//!   unchanged. Anything else that could name a different object than it
//!   appears to (`.`/`..`, `\`, `:` for alternate data streams, wildcards,
//!   control characters, trailing dots or spaces, device names like `NUL`) is
//!   refused as invalid input;
//! - the path is resolved with the OS (`canonicalize`: links followed, `\\?\C:\`
//!   form); the leaf itself is not followed when the tool acts on a link
//!   (`stat`), so only its parent is resolved;
//! - the policy is applied to that physical path, as on Unix;
//! - a file is then opened and the handle's own final path
//!   (`GetFinalPathNameByHandleW`) must still be the path that passed the
//!   policy, and the handle's identity (volume serial, file index) is matched
//!   against protected files. A link swapped in after the check is opened,
//!   found to be something else, and refused.
//!
//! Residual, as on Unix: a directory renamed between the verdict and a list or
//! search walk is walked under its new place; the walk re-checks each directory
//! it enters (`walk_windows`).

use std::ffi::OsString;
use std::fs::{File, Metadata};
use std::path::{Component, Path, PathBuf, Prefix};

use super::error::{ErrorCode, FileError, FileResult};
use super::policy::{Access, Policy};

pub const MAX_PATH_BYTES: usize = 4096;

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

/// The `stat(2)`-like view of a Windows file. `mode` is synthesized (`0644`, or
/// `0444` for a read-only file; `0755` for a directory), `uid`/`gid` are 0, and
/// `dev`/`ino` are the volume serial and file index when they were read from an
/// open handle (0 otherwise).
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
    /// From metadata alone: no identity (`dev`/`ino` 0).
    pub fn from_metadata(meta: &Metadata) -> Self {
        let file_type = meta.file_type();
        let (kind_bits, perm) = if file_type.is_symlink() {
            (S_IFLNK, 0o777)
        } else if file_type.is_dir() {
            (S_IFDIR, 0o755)
        } else if file_type.is_file() {
            (
                S_IFREG,
                if meta.permissions().readonly() {
                    0o444
                } else {
                    0o644
                },
            )
        } else {
            (0, 0o644)
        };
        let since_epoch = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .unwrap_or_default();
        Self {
            mode: kind_bits | perm,
            uid: 0,
            gid: 0,
            nlink: 1,
            size: meta.len(),
            dev: 0,
            ino: 0,
            mtime_secs: i64::try_from(since_epoch.as_secs()).unwrap_or(i64::MAX),
            mtime_nanos: i64::from(since_epoch.subsec_nanos()),
        }
    }

    /// From an open handle: metadata plus the file's identity.
    pub fn of_file(file: &File) -> std::io::Result<Self> {
        let mut stat = Self::from_metadata(&file.metadata()?);
        let identity = wsmp_windows::file_identity(file)?;
        stat.dev = u64::from(identity.volume);
        stat.ino = identity.index;
        stat.nlink = u64::from(identity.links);
        Ok(stat)
    }

    /// The object at `path` itself (a link is not followed), with its
    /// identity. Opened for attributes only, which no other handle's sharing
    /// mode refuses, and without following a reparse point or fetching a cloud
    /// file's content.
    pub fn of_path(path: &Path) -> std::io::Result<Self> {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_READ_ATTRIBUTES; FILE_FLAG_BACKUP_SEMANTICS (directories open
        // too) | FILE_FLAG_OPEN_REPARSE_POINT.
        let file = std::fs::OpenOptions::new()
            .access_mode(0x0080)
            .custom_flags(0x0200_0000 | 0x0020_0000)
            .open(path)?;
        Self::of_file(&file)
    }

    pub fn kind(&self) -> Kind {
        match self.mode & 0o170_000 {
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

    #[allow(dead_code)]
    pub fn same_object(&self, other: &Stat) -> bool {
        self.dev == other.dev && self.ino == other.ino
    }
}

/// A directory the tools walk: its physical path. Windows has no directory
/// fds to hold; `walk_windows` re-checks each directory it enters.
#[derive(Debug, Clone)]
pub struct DirHandle {
    pub path: PathBuf,
}

/// A resolved path: the physical parent directory and the leaf name in it.
/// `name == "."` means the path names the directory itself (a drive root).
#[derive(Debug)]
pub struct Resolved {
    pub dir: DirHandle,
    pub dir_path: PathBuf,
    pub name: OsString,
    /// Parents `make_parents` created, outermost first (removed again when a
    /// write fails: [`Self::rollback_created`]).
    pub created: Vec<PathBuf>,
}

pub struct ResolveOpts<'a> {
    /// Follow a link in the last component. `false` for stat, rename source and
    /// delete, which act on the link itself.
    pub follow_last: bool,
    /// Create missing parents (the mode has no meaning on Windows).
    pub make_parents: Option<u32>,
    pub policy: &'a Policy,
    pub access: Access,
    /// Checked before every parent creation.
    pub cancel: Option<&'a super::Cancel>,
}

impl Resolved {
    /// The entry `name` of a directory a walk holds.
    pub fn at(parent: &DirHandle, dir_path: PathBuf, name: OsString) -> FileResult<Self> {
        Ok(Self {
            dir: parent.clone(),
            dir_path,
            name,
            created: Vec::new(),
        })
    }

    /// Remove the parents this resolution created, innermost first, each only
    /// while it is empty (a directory that is not is left as it is).
    pub fn rollback_created(&mut self) {
        while let Some(created) = self.created.pop() {
            let _ = std::fs::remove_dir(&created);
        }
    }

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

    /// `Some(physical path, in the POSIX view)` when it differs from what the
    /// caller passed.
    pub fn echo(&self, input: &str) -> Option<String> {
        let physical = posix_view(&self.full_path())?;
        (physical != input).then_some(physical)
    }

    /// The leaf itself, a link not followed; `None` when it does not exist.
    pub fn lstat(&self) -> FileResult<Option<Stat>> {
        match Stat::of_path(&self.full_path()) {
            Ok(stat) => Ok(Some(stat)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(FileError::io(&error)),
        }
    }

    /// The metadata of the directory the path names itself.
    pub fn dir_stat(&self) -> FileResult<Stat> {
        Ok(Stat::of_path(&self.full_path())?)
    }

    /// The leaf as a directory to walk: it must be one, not a link to one.
    pub fn open_dir(&self) -> FileResult<DirHandle> {
        let path = self.full_path();
        let meta = std::fs::symlink_metadata(&path)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(FileError::new(
                ErrorCode::NotADir,
                "path is not a directory",
            ));
        }
        Ok(DirHandle { path })
    }

    /// A link's text, in the POSIX view when it is an absolute drive path.
    pub fn read_link(&self) -> Option<String> {
        read_link_at(&self.dir, &self.name.to_string_lossy())
    }

    /// Open the leaf read-only as a regular file. The handle's final path must
    /// still be the one the policy passed, it must be a regular file, and its
    /// identity must not be a protected file's.
    pub fn open_regular(&self, policy: &Policy, access: Access) -> FileResult<(File, Stat)> {
        if self.is_self() {
            return Err(FileError::new(ErrorCode::NotAFile, "path is a directory"));
        }
        let full = self.full_path();
        match std::fs::symlink_metadata(&full) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(FileError::new(ErrorCode::NotFound, "no such file"));
            }
            Err(error) => return Err(FileError::io(&error)),
            Ok(meta) => check_openable(Stat::from_metadata(&meta).kind())?,
        }
        let file = File::open(&full)?;
        let opened = wsmp_windows::final_path(&file)?;
        if !same_path(&opened, &full) {
            return Err(FileError::new(
                ErrorCode::SpecialFile,
                "path changed while it was opened",
            ));
        }
        let stat = Stat::of_file(&file)?;
        check_openable(stat.kind())?;
        policy.check_path(access, &opened)?;
        policy.check_identity(access, &stat)?;
        Ok((file, stat))
    }
}

/// A link's text in the directory `parent`, in the POSIX view when it is an
/// absolute drive path; `None` when it is not a link or not readable.
pub fn read_link_at(parent: &DirHandle, name: &str) -> Option<String> {
    let target = std::fs::read_link(parent.path.join(name)).ok()?;
    if target.is_absolute() {
        return posix_view(&target);
    }
    target.to_str().map(|text| text.replace('\\', "/"))
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

/// Names Windows maps to devices in every directory, with or without an
/// extension.
const DEVICE_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// One name of a POSIX-view path: a plain Windows file name that names just
/// itself.
fn check_name(name: &str) -> FileResult<()> {
    if name == "." || name == ".." {
        return Err(FileError::invalid(
            "`.` and `..` are not allowed in a Windows path",
        ));
    }
    if name
        .chars()
        .any(|ch| ch < ' ' || matches!(ch, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err(FileError::invalid(
            "a name holds a character Windows does not allow (`\\ : * ? \" < > |` or a control)",
        ));
    }
    if name.ends_with(['.', ' ']) {
        return Err(FileError::invalid(
            "a name ends with a dot or a space, which Windows drops",
        ));
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    if DEVICE_NAMES
        .iter()
        .any(|device| stem.eq_ignore_ascii_case(device))
    {
        return Err(FileError::invalid("a name is a Windows device name"));
    }
    Ok(())
}

/// The Windows path a POSIX-view path names: `/c` is `C:\`, `/c/Users/ada` is
/// `C:\Users\ada`; `~` and `~/...` are the home directory.
pub fn expand(input: &str) -> FileResult<PathBuf> {
    if input.is_empty() || input.len() > MAX_PATH_BYTES {
        return Err(FileError::invalid("path must be 1 to 4096 bytes"));
    }
    if input.contains('\0') {
        return Err(FileError::invalid("path contains a NUL byte"));
    }
    let (base, rest) = if input == "~" || input.starts_with("~/") {
        let home = dirs::home_dir()
            .ok_or_else(|| FileError::invalid("cannot determine the home directory"))?;
        (home, input.strip_prefix('~').unwrap_or(""))
    } else {
        let mut chars = input.chars();
        let drive = match (chars.next(), chars.next(), chars.next()) {
            (Some('/'), Some(drive), None | Some('/')) if drive.is_ascii_alphabetic() => drive,
            _ => {
                return Err(FileError::invalid(
                    "path must be a drive path like /c/Users/... (or start with ~/)",
                ));
            }
        };
        (
            PathBuf::from(format!("{}:\\", drive.to_ascii_uppercase())),
            &input[2..],
        )
    };
    let mut path = base;
    for name in rest.split('/').filter(|name| !name.is_empty()) {
        check_name(name)?;
        path.push(name);
    }
    Ok(path)
}

/// `\\?\C:\Users\ada` (or `C:\Users\ada`) in the POSIX view, `/c/Users/ada`;
/// `None` for anything that is not a drive path (a share, a device).
pub fn posix_view(path: &Path) -> Option<String> {
    let mut components = path.components();
    let drive = match components.next()? {
        Component::Prefix(prefix) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive.to_ascii_lowercase(),
            _ => return None,
        },
        _ => return None,
    };
    let mut out = format!("/{}", char::from(drive));
    for component in components {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                out.push('/');
                out.push_str(name.to_str()?);
            }
            _ => return None,
        }
    }
    Some(out)
}

/// Whether two physical paths name the same place (case-insensitively, as
/// NTFS compares names; `\\?\C:\` and `C:\` alike).
pub(crate) fn same_path(a: &Path, b: &Path) -> bool {
    match (posix_view(a), posix_view(b)) {
        (Some(a), Some(b)) => a.to_lowercase() == b.to_lowercase(),
        _ => false,
    }
}

/// Canonicalize to a drive path: a link that leads to a share or a device is
/// refused.
fn physical(path: &Path) -> FileResult<PathBuf> {
    let real = std::fs::canonicalize(path)?;
    if posix_view(&real).is_none() {
        return Err(FileError::denied("the path leads off the local drives"));
    }
    Ok(real)
}

/// `parent` as a physical path. With `make_parents` the missing directories
/// are created under the deepest one that exists, each checked by the policy
/// first; they are recorded in `created` (and removed again when a later one
/// fails).
fn physical_parent(
    parent: &Path,
    opts: &ResolveOpts<'_>,
    created: &mut Vec<PathBuf>,
) -> FileResult<PathBuf> {
    match physical(parent) {
        Err(error) if error.code == ErrorCode::NotFound && opts.make_parents.is_some() => {}
        found => return found,
    }
    let mut missing = Vec::new();
    let mut base = parent;
    let existing = loop {
        let (Some(name), Some(up)) = (base.file_name(), base.parent()) else {
            return Err(FileError::new(
                ErrorCode::NotFound,
                "the drive does not exist",
            ));
        };
        missing.push(name.to_os_string());
        base = up;
        match physical(base) {
            Ok(real) => break real,
            Err(error) if error.code == ErrorCode::NotFound => {}
            Err(error) => return Err(error),
        }
    };
    let mut made = Vec::new();
    let result = (|| -> FileResult<PathBuf> {
        let mut dir = existing;
        for name in missing.into_iter().rev() {
            if let Some(cancel) = opts.cancel {
                cancel.check()?;
            }
            dir.push(name);
            opts.policy.check_path(Access::Write, &dir)?;
            match std::fs::create_dir(&dir) {
                Ok(()) => made.push(dir.clone()),
                // Made meanwhile by someone else: go on from where it really is.
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    dir = physical(&dir)?;
                }
                Err(error) => return Err(FileError::io(&error)),
            }
        }
        Ok(dir)
    })();
    match result {
        Ok(dir) => {
            created.extend(made);
            Ok(dir)
        }
        Err(error) => {
            while let Some(dir) = made.pop() {
                let _ = std::fs::remove_dir(&dir);
            }
            Err(error)
        }
    }
}

/// Resolve `input` and apply the policy to the result. This is the one
/// enforcement point for every file tool path.
pub fn resolve(input: &str, opts: &ResolveOpts<'_>) -> FileResult<Resolved> {
    let expanded = expand(input)?;
    let mut created = Vec::new();
    let resolved = match (expanded.parent(), expanded.file_name()) {
        // A drive root.
        (None, _) | (_, None) => {
            let dir_path = physical(&expanded)?;
            Resolved {
                dir: DirHandle {
                    path: dir_path.clone(),
                },
                dir_path,
                name: OsString::from("."),
                created: Vec::new(),
            }
        }
        (Some(parent), Some(leaf)) => {
            let followed = if opts.follow_last {
                match physical(&expanded) {
                    Ok(real) => Some(real),
                    Err(error) if error.code == ErrorCode::NotFound => None,
                    Err(error) => return Err(error),
                }
            } else {
                None
            };
            let (dir_path, name) = match followed {
                Some(real) => match (real.parent(), real.file_name()) {
                    (Some(parent), Some(name)) => (parent.to_path_buf(), name.to_os_string()),
                    // A link to a drive root.
                    _ => (real.clone(), OsString::from(".")),
                },
                None => (
                    physical_parent(parent, opts, &mut created)?,
                    leaf.to_os_string(),
                ),
            };
            Resolved {
                dir: DirHandle {
                    path: dir_path.clone(),
                },
                dir_path,
                name,
                created,
            }
        }
    };
    if let Err(error) = opts.policy.check_path(opts.access, &resolved.full_path()) {
        let mut resolved = resolved;
        resolved.rollback_created();
        return Err(error);
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_view_paths_map_to_drive_paths_and_back() {
        assert_eq!(expand("/c").expect("root"), PathBuf::from(r"C:\"));
        assert_eq!(
            expand("/d/Work Space//a.txt").expect("path"),
            PathBuf::from(r"D:\Work Space\a.txt")
        );
        assert_eq!(
            posix_view(Path::new(r"\\?\C:\Users\Ada\x.txt")).as_deref(),
            Some("/c/Users/Ada/x.txt")
        );
        assert_eq!(posix_view(Path::new(r"D:\")).as_deref(), Some("/d"));
        assert_eq!(posix_view(Path::new(r"\\?\UNC\server\share\x")), None);
        assert_eq!(posix_view(Path::new(r"\\server\share\x")), None);
        assert!(same_path(
            Path::new(r"\\?\C:\Users\ADA"),
            Path::new(r"c:\users\ada")
        ));
    }

    #[test]
    fn names_that_alias_another_object_are_refused() {
        for bad in [
            "C:/x",
            "c/x",
            "/cc/x",
            "/c/..",
            "/c/a/../b",
            "/c/./a",
            r"/c/a\b",
            "/c/file.txt:secret",
            "/c/a*",
            "/c/a?",
            "/c/name.",
            "/c/name ",
            "/c/NUL",
            "/c/dir/con.txt",
            "/c/Com1",
            "relative/path",
            "",
        ] {
            assert!(expand(bad).is_err(), "{bad}");
        }
        for good in [
            "/c",
            "/c/",
            "/z/a.b.c",
            "/c/null",
            "/c/console.log",
            "~",
            "~/x",
        ] {
            assert!(expand(good).is_ok(), "{good}");
        }
    }
}
