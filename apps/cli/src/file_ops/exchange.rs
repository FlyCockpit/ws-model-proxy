//! Safe atomic exchange on held directory descriptors.

use std::ffi::OsStr;
use std::os::fd::AsFd;

use nix::errno::Errno;

pub(super) fn exchange(
    dir_from: impl AsFd,
    from: &OsStr,
    dir_to: impl AsFd,
    to: &OsStr,
) -> Result<(), Errno> {
    #[cfg(target_os = "linux")]
    {
        use nix::fcntl::{RenameFlags, renameat2};
        renameat2(dir_from, from, dir_to, to, RenameFlags::RENAME_EXCHANGE)
    }
    #[cfg(target_os = "macos")]
    {
        use rustix::fs::{RenameFlags, renameat_with};
        renameat_with(dir_from, from, dir_to, to, RenameFlags::EXCHANGE)
            .map_err(|errno| Errno::from_raw(errno.raw_os_error()))
    }
}

/// Only these errors permit the caller's unsupported-exchange policy.
pub(super) fn is_unsupported(errno: Errno) -> bool {
    matches!(errno, Errno::EINVAL | Errno::ENOSYS)
        || (cfg!(target_os = "macos") && errno == Errno::ENOTSUP)
}
