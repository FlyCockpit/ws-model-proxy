//! Safe atomic exchange on held directory descriptors.

use std::ffi::OsStr;
use std::os::fd::AsFd;

use nix::errno::Errno;

/// Faults are thread-local, indexed by the Nth call of each primitive. Production
/// calls execute only the syscall. A test scope resets counts and faults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Primitive {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    Exchange,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    ProbeExchange,
    ProbeCreate,
    PublishPrepare,
    ProbeNoReplace,
    ProbeLink,
    Publish,
    PublishLink,
    Capture,
    Restore,
    RestoreLink,
    Move,
    Hold,
    Identity,
    Mkdir,
    Unlink,
    Rmdir,
    LinkCount,
}

#[cfg(test)]
#[derive(Clone, Copy)]
enum FaultMode {
    Before,
    AfterEffect,
}

#[cfg(test)]
type FaultState = (Vec<(Primitive, usize, Errno, FaultMode)>, Vec<Primitive>);

#[cfg(test)]
thread_local! {
    static FAULTS: std::cell::RefCell<FaultState> = const {
        std::cell::RefCell::new((Vec::new(), Vec::new()))
    };
    // Observe descriptor ownership at the actual unlink/rmdir boundary.
    pub(super) static RMDIR_PROBE: std::cell::RefCell<Option<Box<dyn Fn()>>> =
        const { std::cell::RefCell::new(None) };
    pub(super) static UNLINK_PROBE: std::cell::RefCell<Option<Box<dyn Fn()>>> =
        const { std::cell::RefCell::new(None) };
}

/// Register one call and return an optional error to inject AFTER a successful
/// syscall. Keeping this separate from the syscall avoids counting it twice.
fn begin(primitive: Primitive) -> Result<Option<Errno>, Errno> {
    #[cfg(not(test))]
    let _ = primitive;
    #[cfg(test)]
    {
        match primitive {
            Primitive::Rmdir => RMDIR_PROBE.with(|probe| {
                if let Some(probe) = probe.borrow().as_ref() {
                    probe();
                }
            }),
            Primitive::Unlink => UNLINK_PROBE.with(|probe| {
                if let Some(probe) = probe.borrow().as_ref() {
                    probe();
                }
            }),
            _ => {}
        }
        FAULTS.with(|state| {
            let mut state = state.borrow_mut();
            state.1.push(primitive);
            let nth = state.1.iter().filter(|p| **p == primitive).count();
            match state
                .0
                .iter()
                .find(|(p, n, _, _)| *p == primitive && *n == nth)
            {
                Some((_, _, errno, FaultMode::Before)) => Err(*errno),
                Some((_, _, errno, FaultMode::AfterEffect)) => Ok(Some(*errno)),
                None => Ok(None),
            }
        })
    }
    #[cfg(not(test))]
    Ok(None)
}

pub(super) fn fault(primitive: Primitive) -> Result<(), Errno> {
    begin(primitive).map(|_| ())
}

pub(super) fn run<T>(
    primitive: Primitive,
    syscall: impl FnOnce() -> Result<T, Errno>,
) -> Result<T, Errno> {
    let after = begin(primitive)?;
    let result = syscall()?;
    match after {
        Some(errno) => Err(errno),
        None => Ok(result),
    }
}

#[cfg(test)]
pub(super) struct FaultScope;

#[cfg(test)]
impl FaultScope {
    pub(super) fn new(faults: &[(Primitive, usize, Errno)]) -> Self {
        Self::with_after_effects(faults, &[])
    }

    pub(super) fn with_after_effects(
        before: &[(Primitive, usize, Errno)],
        after: &[(Primitive, usize, Errno)],
    ) -> Self {
        let faults = before
            .iter()
            .map(|&(p, n, e)| (p, n, e, FaultMode::Before))
            .chain(
                after
                    .iter()
                    .map(|&(p, n, e)| (p, n, e, FaultMode::AfterEffect)),
            )
            .collect();
        FAULTS.with(|state| *state.borrow_mut() = (faults, Vec::new()));
        Self
    }

    pub(super) fn after_effect(faults: &[(Primitive, usize, Errno)]) -> Self {
        Self::with_after_effects(&[], faults)
    }

    pub(super) fn calls() -> Vec<Primitive> {
        FAULTS.with(|state| state.borrow().1.clone())
    }
}

#[cfg(test)]
impl Drop for FaultScope {
    fn drop(&mut self) {
        FAULTS.with(|state| *state.borrow_mut() = (Vec::new(), Vec::new()));
        RMDIR_PROBE.with(|probe| *probe.borrow_mut() = None);
        UNLINK_PROBE.with(|probe| *probe.borrow_mut() = None);
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn exchange(
    dir_from: impl AsFd,
    from: &OsStr,
    dir_to: impl AsFd,
    to: &OsStr,
) -> Result<(), Errno> {
    exchange_with(dir_from, from, dir_to, to, Primitive::Exchange)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn exchange_with(
    dir_from: impl AsFd,
    from: &OsStr,
    dir_to: impl AsFd,
    to: &OsStr,
    primitive: Primitive,
) -> Result<(), Errno> {
    run(primitive, || {
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
    })
}

/// NOREPLACE primitive; callers own the capture/restore fallback policy.
pub(super) fn no_replace(
    dir_from: impl AsFd,
    from: &OsStr,
    dir_to: impl AsFd,
    to: &OsStr,
    primitive: Primitive,
) -> Result<(), Errno> {
    run(primitive, || {
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
    })
}

/// The link count of `name` under `dir`, read from the filesystem itself.
///
/// A plain stat answers from the kernel's attribute cache. FUSE (default one-second
/// attribute timeout), NFS and SMB then report a count that is stale in BOTH
/// directions (and, without stable inode numbers, every name has its own cached
/// attributes), so a guard built on it can delete an object's last name or retain a
/// clean alias every time. Linux therefore asks for `statx` with
/// `AT_STATX_FORCE_SYNC` (a kernel without statx falls back to the plain stat). Other
/// Unix systems have no such flag and get the plain stat. The count is never a proof:
/// `RecoveryDir::calibrate_counts` decides per operation whether it can veto an unlink
/// at all, and an unreadable count under a believable mount keeps the alias.
pub(super) fn link_count(dir: impl AsFd, name: &OsStr) -> Result<u64, Errno> {
    run(Primitive::LinkCount, || {
        #[cfg(target_os = "linux")]
        {
            use rustix::fs::{AtFlags, StatxFlags, statx};
            match statx(
                &dir,
                name,
                AtFlags::SYMLINK_NOFOLLOW | AtFlags::STATX_FORCE_SYNC,
                StatxFlags::NLINK,
            ) {
                Ok(stat) => return Ok(u64::from(stat.stx_nlink)),
                // A kernel without statx: the cached count is all there is.
                Err(rustix::io::Errno::NOSYS) => {}
                Err(errno) => return Err(Errno::from_raw(errno.raw_os_error())),
            }
        }
        nix::sys::stat::fstatat(dir, name, nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW)
            .map(|raw| super::resolve::Stat::from_raw(&raw).nlink)
    })
}

/// Linux ENOTSUP aliases EOPNOTSUPP; macOS uses ENOTSUP for unsupported SWAP
/// (its distinct EOPNOTSUPP stays an ordinary error).
pub(super) fn is_unsupported(errno: Errno) -> bool {
    matches!(errno, Errno::EINVAL | Errno::ENOSYS | Errno::ENOTSUP)
}

/// Only capability errors from link permit a definitive unsafe-fs refusal.
/// EMLINK, space/quota errors and access errors describe this attempt instead.
pub(super) fn is_link_unsupported(errno: Errno) -> bool {
    is_unsupported(errno) || matches!(errno, Errno::EPERM | Errno::EOPNOTSUPP)
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use super::*;

    #[test]
    fn only_exchange_less_errors_are_unsupported() {
        for errno in [Errno::EINVAL, Errno::ENOSYS, Errno::ENOTSUP] {
            assert!(is_unsupported(errno), "{errno}");
        }
        assert_eq!(is_unsupported(Errno::EOPNOTSUPP), cfg!(target_os = "linux"));
        #[cfg(target_os = "linux")]
        assert_eq!(Errno::ENOTSUP, Errno::EOPNOTSUPP);
        #[cfg(target_os = "macos")]
        assert_ne!(Errno::ENOTSUP, Errno::EOPNOTSUPP);
        for errno in [
            Errno::ENOENT,
            Errno::EPERM,
            Errno::EACCES,
            Errno::EXDEV,
            Errno::EIO,
            Errno::EBUSY,
            Errno::EISDIR,
            Errno::EMLINK,
        ] {
            assert!(!is_unsupported(errno), "{errno}");
        }
    }

    #[test]
    fn after_effect_runs_once_before_reporting_the_fault() {
        let _scope = FaultScope::after_effect(&[(Primitive::Publish, 1, Errno::EIO)]);
        let ran = std::cell::Cell::new(0);
        let result = run(Primitive::Publish, || {
            ran.set(ran.get() + 1);
            Ok(())
        });
        assert_eq!(result, Err(Errno::EIO));
        assert_eq!(ran.get(), 1);
        assert_eq!(FaultScope::calls(), [Primitive::Publish]);
    }

    #[test]
    fn link_capability_errors_do_not_include_attempt_failures() {
        for errno in [
            Errno::EINVAL,
            Errno::ENOSYS,
            Errno::ENOTSUP,
            Errno::EOPNOTSUPP,
            Errno::EPERM,
        ] {
            assert!(is_link_unsupported(errno), "{errno}");
        }
        for errno in [
            Errno::EMLINK,
            Errno::ENOSPC,
            Errno::EDQUOT,
            Errno::EROFS,
            Errno::EACCES,
            Errno::EIO,
            Errno::EXDEV,
        ] {
            assert!(!is_link_unsupported(errno), "{errno}");
        }
    }
}
