//! Safe atomic exchange on held directory descriptors.

use std::ffi::OsStr;
use std::os::fd::AsFd;

use nix::errno::Errno;

// Test seam: make the next exchange on THIS thread fail with an errno, so the
// callers' handling of each errno class is exercised on any platform.
#[cfg(test)]
thread_local! {
    pub(super) static INJECTED: std::cell::Cell<Option<Errno>> = const { std::cell::Cell::new(None) };
}

pub(super) fn exchange(
    dir_from: impl AsFd,
    from: &OsStr,
    dir_to: impl AsFd,
    to: &OsStr,
) -> Result<(), Errno> {
    #[cfg(test)]
    if let Some(errno) = INJECTED.with(std::cell::Cell::take) {
        return Err(errno);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The set of errors that mean "this filesystem has no exchange". Every other
    /// error must stay an error: a silent fallback would be a plain overwrite.
    #[test]
    fn only_exchange_less_errors_are_unsupported() {
        for errno in [Errno::EINVAL, Errno::ENOSYS] {
            assert!(is_unsupported(errno), "{errno}");
        }
        assert_eq!(
            is_unsupported(Errno::ENOTSUP),
            cfg!(target_os = "macos"),
            "ENOTSUP is the macOS swap-unsupported errno"
        );
        for errno in [
            Errno::ENOENT,
            Errno::EPERM,
            Errno::EACCES,
            Errno::EXDEV,
            Errno::EIO,
            Errno::EBUSY,
            Errno::EISDIR,
        ] {
            assert!(!is_unsupported(errno), "{errno}");
        }
    }
}
