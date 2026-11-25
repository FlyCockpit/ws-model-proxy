//! What every layer of the file tools knows about a file object: [`Stat`], the
//! portable subset of `stat(2)`, and its [`Kind`]. Shared vocabulary beside
//! `error`, below every layer: it names nothing else in `file_ops`, so `fs`, the
//! journal and the tools all build on it.
//!
//! On Windows the view is synthesized: `mode` is `0644`, or `0444` for a
//! read-only file, `0755` for a directory; `uid`/`gid` are 0, and `dev`/`ino`
//! are the volume serial and file index when they were read from an open handle
//! (0 otherwise).

#[cfg(windows)]
use std::fs::File;
use std::fs::Metadata;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

#[cfg(unix)]
use nix::sys::stat::{Mode, mode_t};

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

#[cfg(unix)]
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

    /// The object at `path`, links followed (what a protected entry names).
    pub fn of_path(path: &std::path::Path) -> std::io::Result<Self> {
        Ok(Self::from_metadata(&std::fs::metadata(path)?))
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
}

#[cfg(windows)]
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
    pub fn of_path(path: &std::path::Path) -> std::io::Result<Self> {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_READ_ATTRIBUTES; FILE_FLAG_BACKUP_SEMANTICS (directories open
        // too) | FILE_FLAG_OPEN_REPARSE_POINT.
        let file = std::fs::OpenOptions::new()
            .access_mode(0x0080)
            .custom_flags(0x0200_0000 | 0x0020_0000)
            .open(path)?;
        Self::of_file(&file)
    }
}

impl Stat {
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

    #[cfg_attr(windows, allow(dead_code))]
    pub fn same_object(&self, other: &Stat) -> bool {
        self.dev == other.dev && self.ino == other.ino
    }
}

pub(crate) fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::File => "file",
        Kind::Dir => "dir",
        Kind::Symlink => "symlink",
        Kind::Other => "other",
    }
}

/// Permission bits as a [`Mode`]. `mode_t` is `u32` on Linux and `u16` on macOS,
/// so the cast is what makes `Mode::from_bits_truncate` portable.
#[cfg(unix)]
#[allow(clippy::unnecessary_cast)]
pub(crate) fn perm_mode(bits: u32) -> Mode {
    Mode::from_bits_truncate(bits as mode_t)
}
