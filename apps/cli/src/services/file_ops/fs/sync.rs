//! The directory fsync barrier: proving a directory accepts fsync before an
//! effect that needs it, and what a failed directory sync means.

use std::os::fd::{AsFd, OwnedFd};

use nix::errno::Errno;

use crate::services::file_ops::error::{FileError, FileResult};

/// Prove the directory accepts fsync BEFORE an unjournaled public effect
/// (create, mkdir, rmdir, case-only rename). An unsupported directory sync
/// then refuses as `unsafe_filesystem` with nothing changed.
pub(crate) fn probe_dir_barrier(dir: &OwnedFd) -> FileResult<()> {
    nix::unistd::fsync(dir.as_fd()).map_err(barrier_error)
}

/// A directory that cannot be fsynced at all cannot carry a crash journal:
/// that is an unsafe filesystem, not a transient I/O error.
pub(in crate::services::file_ops) fn barrier_error(errno: Errno) -> FileError {
    match errno {
        Errno::EINVAL | Errno::ENOTSUP => FileError::unsafe_filesystem(),
        errno => FileError::errno(errno),
    }
}
