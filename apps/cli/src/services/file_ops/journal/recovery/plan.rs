//! The crash plan written before the first public effect: the rename's
//! INTENT, the hardlink anchors that pin each recorded identity across a
//! restart, and the registry entry, all fsynced before any public name moves.

use std::ffi::OsStr;
use std::os::fd::{AsFd, OwnedFd};
use std::path::Path;

use nix::fcntl::{AtFlags, OFlag};
use nix::sys::stat::{Mode, fstatat};
use nix::unistd::{UnlinkatFlags, dup, linkat, unlinkat};
use rand::distr::{Alphanumeric, SampleString};

use super::{Held, RecoveryDir};
use crate::services::file_ops::error::{ErrorCode, FileError, FileResult};
use crate::services::file_ops::fs::resolve::Resolved;
use crate::services::file_ops::fs::sync::barrier_error;
use crate::services::file_ops::journal::exchange::is_link_unsupported;
use crate::services::file_ops::journal::intent::{Intent, IntentOrder, PinTarget};
use crate::services::file_ops::meta::{Kind, Stat};

impl RecoveryDir {
    /// Crash map for the slots this rename will capture. Fsynced before any
    /// public name moves. Not added to `kept`: success removes it with R.
    pub(super) fn write_rename_intent(
        &mut self,
        order: IntentOrder,
        from: &Resolved,
        to: &Resolved,
        overwrite: bool,
        source_stat: &Stat,
    ) -> FileResult<()> {
        let intent = Intent::rename(order, &from.full_path(), &to.full_path(), overwrite)
            .publishing(&to.full_path(), source_stat);
        self.prepare_intent(intent)
    }

    pub(in crate::services::file_ops) fn prepare_intent(
        &mut self,
        mut intent: Intent,
    ) -> FileResult<()> {
        self.check_durability()?;
        // Pin all known pre-effect objects before INTENT becomes durable. On
        // filesystems without stable hardlinks the live operation still works,
        // but abandoned objects cannot be automatically reconciled.
        intent.pin_records(|record, target| match target {
            PinTarget::At(path) => self.anchor_path(record, &path),
            PinTarget::ReplaceTemp => {
                let dir = dup(self.dir.as_fd()).map_err(FileError::errno)?;
                self.anchor_at(record, &dir, OsStr::new("tmp"))
            }
        })?;
        self.save_intent(intent.clone())?;
        // A failed registration can still leave an entry: cleanup unregisters.
        self.registered = true;
        if let Err(error) =
            crate::services::file_ops::journal::registry::register(&self.path, &intent)
        {
            let code = match error {
                crate::services::file_ops::journal::registry::RegistryError::UnsupportedDirSync(
                    _,
                ) => ErrorCode::UnsafeFilesystem,
                crate::services::file_ops::journal::registry::RegistryError::Io(_) => {
                    ErrorCode::IoError
                }
            };
            return Err(self.barrier_failed(FileError::new(code, error.to_string())));
        }
        Ok(())
    }

    fn anchor_path(
        &mut self,
        record: &mut crate::services::file_ops::journal::intent::IntentSlot,
        path: &Path,
    ) -> FileResult<()> {
        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
            return Ok(());
        };
        let Ok(dir) = nix::fcntl::open(
            parent,
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
            Mode::empty(),
        ) else {
            return Ok(());
        };
        self.anchor_at(record, &dir, name)
    }

    pub(super) fn anchor_at(
        &mut self,
        record: &mut crate::services::file_ops::journal::intent::IntentSlot,
        dir: &OwnedFd,
        name: &OsStr,
    ) -> FileResult<()> {
        let Ok(raw) = fstatat(dir.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW) else {
            return Ok(());
        };
        let stat = Stat::from_raw(&raw);
        if !matches!(stat.kind(), Kind::File | Kind::Symlink) || record.names_other(&stat) {
            return Ok(());
        }
        let source = Held::open(dir, name, stat)?;
        if !source.is_held() {
            return Ok(());
        }
        let anchor = format!(
            ".wsmp-pin-{}",
            Alphanumeric.sample_string(&mut rand::rng(), 24)
        );
        match linkat(
            dir.as_fd(),
            name,
            self.dir.as_fd(),
            anchor.as_str(),
            AtFlags::empty(),
        ) {
            Ok(()) => {}
            Err(errno) if is_link_unsupported(errno) => return Ok(()),
            Err(errno) => return Err(FileError::errno(errno)),
        }
        let raw = fstatat(
            self.dir.as_fd(),
            anchor.as_str(),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        )
        .map_err(FileError::errno)?;
        let pin = Held::open(&self.dir, OsStr::new(&anchor), Stat::from_raw(&raw))?;
        let same = source
            .live_stat()
            .zip(pin.live_stat())
            .is_some_and(|(a, b)| a.same_object(&b));
        if !same {
            // Some filesystems (noino FUSE, sshfs) present a different inode per
            // name, so this alias can never become a durable proof. The live
            // operation still works there without a pin; only crash recovery
            // stays manual (see `prepare_intent`).
            return self.drop_unproven_anchor(dir, name, &source, anchor, pin);
        }
        self.anchors.push((anchor.clone(), pin));
        // Do not advertise a durable pin where directory durability is not
        // supported. Its live alias still belongs to us and is cleaned normally,
        // but a crash leaves only ambiguity rather than destructive authority.
        match nix::unistd::fsync(self.dir.as_fd())
            .and_then(|()| nix::unistd::fsync(self.parent.as_fd()))
        {
            Ok(()) => {
                *record = record.clone().pinned(&source.stat(), Some(anchor));
                Ok(())
            }
            Err(errno) => Err(self.barrier_failed(barrier_error(errno))),
        }
    }

    /// Remove a pre-effect pin whose identity cannot be proven against the
    /// source, leaving the record without an anchor. The alias is proven only at
    /// its OWN private name (as the noino link probe is), and removed only while
    /// the public name it was linked from still holds the source, so it is never
    /// the last name of an object. A pin that matches the current public name instead of
    /// the held source means the name was swapped: that, or any failed proof,
    /// keeps the alias reported with an uncertain outcome.
    fn drop_unproven_anchor(
        &mut self,
        dir: &OwnedFd,
        name: &OsStr,
        source: &Held,
        anchor: String,
        mut pin: Held,
    ) -> FileResult<()> {
        let public = fstatat(dir.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW)
            .ok()
            .map(|raw| Stat::from_raw(&raw));
        let swapped = public
            .zip(pin.live_stat())
            .is_some_and(|(public, pin)| public.same_object(&pin));
        if public.is_none()
            || swapped
            || !self.holds_name(dir, name, source)
            || !self.holds_name(&self.dir, OsStr::new(&anchor), &pin)
        {
            self.anchors.push((anchor, pin));
            self.unsettled = true;
            return Err(self.uncertain());
        }
        // Close our pin descriptor before unlink (NFS sillyrename avoidance).
        pin.release();
        if unlinkat(
            self.dir.as_fd(),
            anchor.as_str(),
            UnlinkatFlags::NoRemoveDir,
        )
        .is_err()
        {
            self.remember(self.path.join(&anchor));
            self.unsettled = true;
            return Err(self.uncertain());
        }
        Ok(())
    }
}
