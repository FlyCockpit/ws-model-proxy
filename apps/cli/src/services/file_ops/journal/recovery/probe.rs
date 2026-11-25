//! Private capability probes inside R, before any public effect: the
//! absent-name NOREPLACE/link ladder, the link probe that also learns the link
//! order and whether link counts can be believed, and the rename preflight.

use std::ffi::{OsStr, OsString};
use std::os::fd::{AsFd, OwnedFd};
use std::path::Path;

use nix::errno::Errno;
use nix::fcntl::{AtFlags, OFlag, openat};
use nix::sys::stat::{Mode, fstatat};
use nix::unistd::{dup, linkat};

use super::{Held, LinkOrder, Origin, PublishMethod, RecoveryDir, Slot};
use crate::services::file_ops::Step;
use crate::services::file_ops::context::OpContext;
use crate::services::file_ops::error::{FileError, FileResult};
use crate::services::file_ops::fs::resolve::Resolved;
use crate::services::file_ops::journal::exchange::{
    Primitive, is_link_unsupported, is_unsupported, link_count, no_replace, run,
};
use crate::services::file_ops::meta::Stat;

impl RecoveryDir {
    /// One absent-name ladder, shared by replacement and rename preflight.
    pub(super) fn probe_publish(
        &mut self,
        ops: &OpContext,
        slot: &mut Slot,
        identity: &mut Held,
    ) -> FileResult<PublishMethod> {
        self.probe_publish_with(ops, slot, identity, None)
    }

    fn probe_publish_with(
        &mut self,
        ops: &OpContext,
        slot: &mut Slot,
        identity: &mut Held,
        actual: Option<(&Resolved, &Held)>,
    ) -> FileResult<PublishMethod> {
        let probe = OsString::from("probe");
        match no_replace(
            self.dir.as_fd(),
            &slot.name,
            self.dir.as_fd(),
            &probe,
            Primitive::ProbeNoReplace,
        ) {
            Ok(()) => {
                self.adopt_name(slot, probe);
                return Ok(PublishMethod::NoReplace);
            }
            Err(errno) if is_unsupported(errno) => {}
            Err(errno) => {
                if matches!(
                    fstatat(
                        self.dir.as_fd(),
                        slot.name.as_os_str(),
                        AtFlags::AT_SYMLINK_NOFOLLOW
                    ),
                    Err(Errno::ENOENT)
                ) && fstatat(
                    self.dir.as_fd(),
                    probe.as_os_str(),
                    AtFlags::AT_SYMLINK_NOFOLLOW,
                )
                .is_ok()
                {
                    self.adopt_name(slot, probe);
                }
                return Err(FileError::errno(errno));
            }
        }
        if let Some((source, held)) = actual {
            self.probe_link(ops, &source.dir, &source.name, &source.full_path(), held)?;
        } else {
            let private_dir = dup(self.dir.as_fd()).map_err(FileError::errno)?;
            self.probe_link(ops, &private_dir, &slot.name, &slot.origin.path, identity)?;
        }
        Ok(PublishMethod::Link)
    }

    /// Right after a successful probe link the object has two names, so a believable
    /// count reads at least 2. A count of 1 (a filesystem such as sshfs that always
    /// reports 1) or a failed read means counts cannot be used on this mount: the guard
    /// then stays off, as in #169's replace, rather than retaining an alias after every
    /// rename or failing the probe. A believable but stale count is no worse than no
    /// guard. The guard only ever VETOES an unlink; no safety claim rests on it.
    fn calibrate_counts(&mut self, alias: &Slot) {
        self.counts_reliable = match link_count(self.dir.as_fd(), alias.name.as_os_str()) {
            Ok(count) => Some(count >= 2),
            Err(_) => None,
        };
    }

    /// Link capability depends on the actual object (protected_hardlinks,
    /// symlink restrictions and link-count limits), never just on a dummy file.
    fn probe_link(
        &mut self,
        ops: &OpContext,
        dir: &OwnedFd,
        name: &OsStr,
        path: &Path,
        identity: &Held,
    ) -> FileResult<()> {
        if !self.holds_name(dir, name, identity) {
            return Err(FileError::conflict("replaced"));
        }
        let alias = Slot {
            name: OsString::from("probe"),
            origin: Origin::new(dir, name, path).map_err(FileError::errno)?,
        };
        let linked = run(Primitive::ProbeLink, || {
            linkat(
                dir.as_fd(),
                name,
                self.dir.as_fd(),
                alias.name.as_os_str(),
                AtFlags::empty(),
            )
        });
        if let Err(errno) = linked {
            // A failed reply can leave an alias. Keep it, with the source still
            // pinned; never infer its ownership from another link's inode.
            if fstatat(
                self.dir.as_fd(),
                alias.name.as_os_str(),
                AtFlags::AT_SYMLINK_NOFOLLOW,
            )
            .is_ok()
            {
                self.keep(&alias);
                return Err(self.uncertain());
            }
            return Err(if is_link_unsupported(errno) {
                FileError::unsafe_filesystem()
            } else {
                FileError::errno(errno)
            });
        }
        self.remember(self.path.join(&alias.name));
        self.calibrate_counts(&alias);
        let seam_error = ops.hook.step(Step::LinkProbed).err();
        let raw = fstatat(
            self.dir.as_fd(),
            alias.name.as_os_str(),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        )
        .map_err(FileError::errno)?;
        let alias_stat = Stat::from_raw(&raw);
        // The first probe is the source. A test may swap `probe` at LinkProbed,
        // after count calibration, so this comparison sees that inode.
        if self.link_order.is_none() {
            let stable = identity
                .live_stat()
                .is_some_and(|live| live.same_object(&alias_stat));
            self.link_order = Some(if stable {
                LinkOrder::LinkFirst
            } else {
                LinkOrder::VacateFirst
            });
        }
        let mut held = Held::open(&self.dir, &alias.name, alias_stat)?;
        // The original proof pins its inode through alias disposal (the accepted
        // per-vnode NFS exception). The alias is proven at its OWN name on noino.
        if !self.dispose_alias(ops, &alias, &mut held) {
            return Err(self.uncertain());
        }
        if !self.holds_name(dir, name, identity) {
            return Err(FileError::conflict("replaced"));
        }
        if let Some(error) = seam_error {
            return Err(error);
        }
        Ok(())
    }

    fn dummy(&mut self, name: &str, target: &Resolved) -> FileResult<(Slot, Held)> {
        let slot = Slot {
            name: OsString::from(name),
            origin: Origin::new(&target.dir, &target.name, &target.full_path())
                .map_err(FileError::errno)?,
        };
        let fd = run(Primitive::ProbeCreate, || {
            openat(
                self.dir.as_fd(),
                slot.name.as_os_str(),
                OFlag::O_CREAT
                    | OFlag::O_EXCL
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_RDWR
                    | OFlag::O_CLOEXEC,
                Mode::S_IRUSR | Mode::S_IWUSR,
            )
        })
        .map_err(FileError::errno)?;
        self.remember(self.path.join(&slot.name));
        let held = Held::from_file(&std::fs::File::from(fd))?;
        Ok((slot, held)) // dummies never consume the two user-data slots
    }

    /// Before any public effect: exchange/NR use private dummies; link probes
    /// use S and (for overwrite) D, which must both be link-restorable.
    pub(in crate::services::file_ops) fn preflight_move(
        &mut self,
        ops: &OpContext,
        from: &Resolved,
        to: &Resolved,
        src: &Held,
        dst: Option<&Held>,
    ) -> FileResult<Option<PublishMethod>> {
        let (mut first, mut one) = self.dummy("preflight-1", to)?;
        #[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(unused_mut))]
        let mut second: Option<(Slot, Held)> = None;
        let result = (|| {
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            if dst.is_some() {
                second = Some(self.dummy("preflight-2", to)?);
                if let Some((slot, held)) = second.as_mut() {
                    match crate::services::file_ops::journal::exchange::exchange_with(
                        self.dir.as_fd(),
                        &first.name,
                        self.dir.as_fd(),
                        &slot.name,
                        Primitive::ProbeExchange,
                    ) {
                        Ok(()) => {
                            std::mem::swap(&mut one, held);
                            return Ok(None);
                        }
                        Err(errno) if is_unsupported(errno) => {}
                        Err(errno) => return Err(FileError::errno(errno)),
                    }
                }
            }
            let method = self.probe_publish_with(ops, &mut first, &mut one, Some((from, src)))?;
            if matches!(method, PublishMethod::Link)
                && let Some(dst) = dst
            {
                self.probe_link(ops, &to.dir, &to.name, &to.full_path(), dst)?;
            }
            Ok(Some(method))
        })();
        self.dispose(ops, &first, &mut one);
        if let Some((slot, mut held)) = second {
            self.dispose(ops, &slot, &mut held);
        }
        if !self.settled() {
            return Err(self.uncertain());
        }
        result
    }

    /// Private NR probe for a direct Move that returned EINVAL. `Ok(true)` means
    /// the filesystem accepts no-replace, so that EINVAL was the destination
    /// name rather than a missing flag.
    pub(in crate::services::file_ops) fn noreplace_works(
        &mut self,
        ops: &OpContext,
        anchor: &Resolved,
    ) -> FileResult<bool> {
        let (mut slot, mut held) = self.dummy("preflight-1", anchor)?;
        let probe = OsString::from("probe-nr");
        let result = match no_replace(
            self.dir.as_fd(),
            &slot.name,
            self.dir.as_fd(),
            &probe,
            Primitive::ProbeNoReplace,
        ) {
            Ok(()) => {
                self.adopt_name(&mut slot, probe);
                Ok(true)
            }
            Err(errno) if is_unsupported(errno) => Ok(false),
            Err(errno) => {
                if matches!(
                    fstatat(
                        self.dir.as_fd(),
                        slot.name.as_os_str(),
                        AtFlags::AT_SYMLINK_NOFOLLOW
                    ),
                    Err(Errno::ENOENT)
                ) && fstatat(
                    self.dir.as_fd(),
                    probe.as_os_str(),
                    AtFlags::AT_SYMLINK_NOFOLLOW,
                )
                .is_ok()
                {
                    self.adopt_name(&mut slot, probe);
                }
                Err(FileError::errno(errno))
            }
        };
        self.dispose(ops, &slot, &mut held);
        if !self.settled() {
            return Err(self.uncertain());
        }
        result
    }

    #[cfg(test)]
    pub(in crate::services::file_ops) fn set_link_order(&mut self, order: LinkOrder) {
        self.link_order = Some(order);
    }
}
