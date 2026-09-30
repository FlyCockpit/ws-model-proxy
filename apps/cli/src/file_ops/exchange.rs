//! Safe atomic exchange on held directory descriptors.

use std::ffi::OsStr;
use std::os::fd::AsFd;

use nix::errno::Errno;

/// Faults are thread-local, indexed by the Nth call of each primitive. Production
/// calls are no-ops. A test scope resets counts and faults on entry and exit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Primitive {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    Exchange,
    Capture,
    Restore,
    RestoreLink,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    Move,
    Unlink,
    Rmdir,
}

#[cfg(test)]
type FaultState = (Vec<(Primitive, usize, Errno)>, Vec<Primitive>);

#[cfg(test)]
thread_local! {
    static FAULTS: std::cell::RefCell<FaultState> = const {
        std::cell::RefCell::new((Vec::new(), Vec::new()))
    };
}

pub(super) fn fault(primitive: Primitive) -> Result<(), Errno> {
    #[cfg(not(test))]
    let _ = primitive;
    #[cfg(test)]
    return FAULTS.with(|state| {
        let mut state = state.borrow_mut();
        state.1.push(primitive);
        let nth = state.1.iter().filter(|p| **p == primitive).count();
        match state
            .0
            .iter()
            .find(|(p, n, _)| *p == primitive && *n == nth)
        {
            Some((_, _, errno)) => Err(*errno),
            None => Ok(()),
        }
    });
    #[cfg(not(test))]
    Ok(())
}

#[cfg(test)]
pub(super) struct FaultScope;

#[cfg(test)]
impl FaultScope {
    pub(super) fn new(faults: &[(Primitive, usize, Errno)]) -> Self {
        FAULTS.with(|state| *state.borrow_mut() = (faults.to_vec(), Vec::new()));
        Self
    }
}

#[cfg(test)]
impl Drop for FaultScope {
    fn drop(&mut self) {
        FAULTS.with(|state| *state.borrow_mut() = (Vec::new(), Vec::new()));
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn exchange(
    dir_from: impl AsFd,
    from: &OsStr,
    dir_to: impl AsFd,
    to: &OsStr,
) -> Result<(), Errno> {
    fault(Primitive::Exchange)?;
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

/// NOREPLACE primitive; callers own the capture/restore fallback policy.
pub(super) fn no_replace(
    dir_from: impl AsFd,
    from: &OsStr,
    dir_to: impl AsFd,
    to: &OsStr,
    primitive: Primitive,
) -> Result<(), Errno> {
    fault(primitive)?;
    #[cfg(target_os = "linux")]
    {
        use nix::fcntl::{RenameFlags, renameat2};
        renameat2(dir_from, from, dir_to, to, RenameFlags::RENAME_NOREPLACE)
    }
    #[cfg(target_os = "macos")]
    {
        use rustix::fs::{RenameFlags, renameat_with};
        renameat_with(dir_from, from, dir_to, to, RenameFlags::NOREPLACE)
            .map_err(|errno| Errno::from_raw(errno.raw_os_error()))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (dir_from, from, dir_to, to);
        Err(Errno::ENOSYS)
    }
}

/// Only these errors permit the caller's unsupported-exchange policy.
pub(super) fn is_unsupported(errno: Errno) -> bool {
    matches!(errno, Errno::EINVAL | Errno::ENOSYS)
        || (cfg!(target_os = "macos") && errno == Errno::ENOTSUP)
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
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
