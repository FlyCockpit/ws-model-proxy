//! Per-operation recovery for atomic replace, exclusive create, plain rename,
//! and overwrite rename. One mode-0700 `.wsmp-recover-<10 alnum>` directory
//! beside the destination holds at most two objects, including replace's temp.
//! Replace exchanges the private temp with the destination; overwrite rename
//! vacates and verifies the source before exchanging its private slot with the
//! destination. Each slot records its origin dirfd and name; restore accepts no
//! free-form target. A proven moved object may reclaim its recorded pre-move
//! origin. For edit, write and overwrite rename the newest foreign write returns
//! to its captured origin on undo (plain rename verification and exclusive-create
//! cleanup instead keep a foreign object in recovery and report it). Every disposal
//! requires a held fd: a pathname's dev+ino snapshot cannot prove ownership.
//! Unsettled operations return uncertain_outcome; successful operations may
//! report recovered paths. Retained locations are logged; recovery is manual
//! using a shell. Find `.wsmp-recover-*` beside the target. File tools can read
//! these paths but refuse mutations. No startup sweep deletes retained data.
//!
//! Exact remaining POSIX windows (no cross-process exclusion is claimed):
//! (a) after the held-fd fstat comparison and before final unlinkat inside the
//! private directory, a same-user process that guessed its name can rename a
//! new object onto the slot and lose it. (a2) when NOREPLACE is unsupported,
//! capture uses plain rename into a private slot checked absent; a same-user
//! squatter arriving between that check and rename can be overwritten. These
//! are the only deleting windows in recovery compensation.
//! (b) conflict undo briefly vacates public names: a concurrent create makes a
//! no-replace restore fail EEXIST, retaining displaced data with uncertainty.
//! Unsupported NOREPLACE restore uses linkat plus held-fd-proven private unlink;
//! directories or unsupported links stay in recovery with uncertain_outcome.
//! (b2) overwrite rename's source is vacant between its initial capture and the
//! operation's end. A concurrent create stays at source on success; when it
//! blocks a restore, it is kept and reported with uncertain_outcome.
//! (c) filesystems (or Unix platforms) without atomic exchange keep the pre-existing
//! cross-directory plain-rename replace: a save by another process that lands
//! between the re-check's name check (before its etag read) and the rename is
//! overwritten. This replaces rather than retains. Independently of the
//! filesystem, an in-place write into the original file after the etag read is
//! lost, because the etag only ever proves content up to that read. Overwrite
//! rename on such filesystems restores the vacated source and returns Unsupported.
//! Closing (c) would need a vacate-first publish (see the issue tracker).
//! (d) a crash leaves `.wsmp-recover-*` (including a partial replace tmp) or both links.
//! (e) unheld objects are never deleted; they remain reported in recovery.
//! (f) on NFS a file that ANOTHER process still holds open keeps a `.nfs*` entry in
//! the recovery directory after its unlink: the directory is then retained and
//! reported in `recovered` (nothing is lost; remove it by hand).

use std::ffi::{OsStr, OsString};
use std::os::fd::{AsFd, OwnedFd};
use std::path::{Path, PathBuf};

use nix::errno::Errno;
use nix::fcntl::{AtFlags, OFlag, openat, renameat};
use nix::sys::stat::{Mode, fstat, fstatat, mkdirat};
use nix::unistd::{UnlinkatFlags, dup, linkat, unlinkat};
use rand::distr::{Alphanumeric, SampleString};
use serde_json::json;

use super::error::{ErrorCode, FileError, FileResult};
use super::exchange::{Primitive, fault, is_unsupported, no_replace};
use super::resolve::{Kind, Stat};
use super::{FileOps, Step};

/// Longest path list carried in a result or error detail (server schema bound).
const MAX_REPORTED: usize = 4;

/// Recorded before a move, so undo cannot choose a new public target.
pub(super) struct Origin {
    dir: OwnedFd,
    name: OsString,
    path: PathBuf,
}

impl Origin {
    pub(super) fn new(dir: &OwnedFd, name: &OsStr, path: &Path) -> Result<Self, Errno> {
        Ok(Self {
            dir: dup(dir.as_fd())?,
            name: name.to_os_string(),
            path: path.to_path_buf(),
        })
    }
}

pub(super) struct Slot {
    name: OsString,
    origin: Origin,
}

/// Only a live fd pins an inode and authorizes disposal. The snapshot permits
/// non-deleting restoration when a platform cannot open the object.
pub(super) struct Held {
    fd: Option<OwnedFd>,
    pub(super) stat: Stat,
}

impl Held {
    pub(super) fn from_file(file: &std::fs::File) -> FileResult<Self> {
        let fd = OwnedFd::from(file.try_clone()?);
        let stat = Stat::from_raw(&fstat(fd.as_fd()).map_err(FileError::errno)?);
        Ok(Self { fd: Some(fd), stat })
    }

    pub(super) fn open(dir: &OwnedFd, name: &OsStr, stat: Stat) -> FileResult<Self> {
        let flags = match stat.kind() {
            Kind::Dir => OFlag::O_DIRECTORY | OFlag::O_RDONLY | OFlag::O_NOFOLLOW,
            #[cfg(target_os = "linux")]
            Kind::File | Kind::Symlink => OFlag::O_PATH | OFlag::O_NOFOLLOW,
            #[cfg(not(target_os = "linux"))]
            Kind::File => OFlag::O_RDONLY | OFlag::O_NONBLOCK | OFlag::O_NOFOLLOW,
            #[cfg(target_os = "macos")]
            // nix does not name O_SYMLINK; retain the platform's flag bit.
            Kind::Symlink => OFlag::from_bits_retain(nix::libc::O_SYMLINK) | OFlag::O_RDONLY,
            _ => return Ok(Self { fd: None, stat }),
        };
        let opened = openat(dir.as_fd(), name, flags | OFlag::O_CLOEXEC, Mode::empty());
        #[cfg(target_os = "linux")]
        let opened = opened.or_else(|errno| {
            if stat.kind() == Kind::File {
                openat(
                    dir.as_fd(),
                    name,
                    OFlag::O_RDONLY | OFlag::O_NONBLOCK | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
            } else {
                Err(errno)
            }
        });
        let fd = opened.ok();
        if let Some(fd) = &fd {
            let opened = Stat::from_raw(&fstat(fd.as_fd()).map_err(FileError::errno)?);
            if !opened.same_object(&stat) {
                return Err(FileError::conflict("replaced"));
            }
        }
        Ok(Self { fd, stat })
    }

    fn identity(&self) -> Option<Stat> {
        self.fd
            .as_ref()
            .and_then(|fd| fstat(fd.as_fd()).ok())
            .map(|raw| Stat::from_raw(&raw))
    }

    /// Snapshots may guide a restore, which never replaces a public object.
    pub(super) fn matches_for_restore(&self, stat: &Stat) -> bool {
        match &self.fd {
            Some(_) => self.identity().is_some_and(|held| held.same_object(stat)),
            None => self.stat.same_object(stat),
        }
    }
}

pub(super) struct RecoveryDir {
    parent: OwnedFd,
    dir: OwnedFd,
    name: OsString,
    path: PathBuf,
    used: usize,
    kept: Vec<PathBuf>,
    unsettled: bool,
    finished: bool,
    last_errno: Option<Errno>,
}

/// State to return to when a capture provably changed nothing.
pub(super) struct Checkpoint {
    used: usize,
    kept: usize,
    unsettled: bool,
}

impl RecoveryDir {
    pub(super) fn new(parent: &OwnedFd, parent_path: &Path) -> FileResult<Self> {
        let parent = dup(parent.as_fd()).map_err(FileError::errno)?;
        loop {
            let name = OsString::from(format!(
                ".wsmp-recover-{}",
                Alphanumeric.sample_string(&mut rand::rng(), 10)
            ));
            match mkdirat(parent.as_fd(), name.as_os_str(), Mode::S_IRWXU) {
                Err(Errno::EEXIST) => continue,
                Err(errno) => return Err(FileError::errno(errno)),
                Ok(()) => {}
            }
            let path = parent_path.join(&name);
            let dir = match openat(
                parent.as_fd(),
                name.as_os_str(),
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            ) {
                Ok(dir) => dir,
                Err(errno) => {
                    // Only rmdir-if-empty; never remove contents on an open failure.
                    if unlinkat(parent.as_fd(), name.as_os_str(), UnlinkatFlags::RemoveDir).is_err()
                    {
                        tracing::warn!(recovery = %path.display(), kept = ?[&path], "file recovery retained; manual recovery required");
                        return Err(FileError::new(
                            ErrorCode::UncertainOutcome,
                            "file outcome is uncertain; inspect recovery",
                        )
                        .with_detail(json!({"recovery": path.to_string_lossy(), "kept": [path.to_string_lossy()]})));
                    }
                    return Err(FileError::errno(errno));
                }
            };
            return Ok(Self {
                parent,
                dir,
                name,
                path,
                used: 0,
                kept: Vec::new(),
                unsettled: false,
                finished: false,
                last_errno: None,
            });
        }
    }

    /// Replace staging is private from its creation onward. Its intended public
    /// origin is recorded before creating it; after exchange that origin belongs
    /// to the displaced destination object in the same slot.
    pub(super) fn create_temp(
        &mut self,
        dir: &OwnedFd,
        name: &OsStr,
        path: &Path,
    ) -> FileResult<(Slot, std::fs::File)> {
        let origin = Origin::new(dir, name, path).map_err(FileError::errno)?;
        let slot = Slot {
            name: OsString::from("tmp"),
            origin,
        };
        let fd = openat(
            self.dir.as_fd(),
            slot.name.as_os_str(),
            OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_WRONLY | OFlag::O_CLOEXEC,
            Mode::S_IRUSR | Mode::S_IWUSR,
        )
        .map_err(FileError::errno)?;
        self.used += 1;
        self.remember(self.path.join(&slot.name));
        Ok((slot, std::fs::File::from(fd)))
    }

    /// Only a successful cross-directory exchange changes the slot's origin.
    /// The returned origin records where the moved object may be returned.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(super) fn exchange(
        &mut self,
        slot: &mut Slot,
        destination: Origin,
    ) -> Result<Origin, Errno> {
        super::exchange::exchange(
            self.dir.as_fd(),
            &slot.name,
            destination.dir.as_fd(),
            &destination.name,
        )?;
        Ok(std::mem::replace(&mut slot.origin, destination))
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(super) fn exchange_temp(&mut self, slot: &mut Slot) -> Result<(), Errno> {
        let origin = Origin::new(&slot.origin.dir, &slot.origin.name, &slot.origin.path)?;
        self.exchange(slot, origin).map(|_| ())
    }

    pub(super) fn capture_origin(&mut self, slot: &Slot) -> Option<Slot> {
        let origin = match Origin::new(&slot.origin.dir, &slot.origin.name, &slot.origin.path) {
            Ok(origin) => origin,
            Err(_) => {
                self.unsettled = true;
                self.remember(slot.origin.path.clone());
                return None;
            }
        };
        self.capture(&origin.dir, &origin.name, &origin.path)
    }

    /// Exchange-less replace keeps the documented plain-rename race, but its
    /// temp still never appears in the public directory.
    pub(super) fn commit_temp(&mut self, slot: &Slot) -> Result<(), Errno> {
        renameat(
            self.dir.as_fd(),
            slot.name.as_os_str(),
            slot.origin.dir.as_fd(),
            slot.origin.name.as_os_str(),
        )?;
        self.kept.retain(|p| *p != self.path.join(&slot.name));
        Ok(())
    }

    /// A previously moved candidate can reclaim its recorded pre-move origin
    /// only with identity evidence. This never authorizes disposal. Overwrite
    /// undo additionally requires holds(), so unheld objects stay at their
    /// captured destination origin.
    pub(super) fn reclaim_origin(&self, slot: &mut Slot, held: &Held, origin: Origin) -> bool {
        if !self.matches_for_restore(slot, held) {
            return false;
        }
        slot.origin = origin;
        true
    }

    fn remember(&mut self, path: PathBuf) {
        if !self.kept.contains(&path) {
            self.kept.push(path);
        }
    }

    pub(super) fn capture(
        &mut self,
        from_dir: &OwnedFd,
        from_name: &OsStr,
        from_path: &Path,
    ) -> Option<Slot> {
        if self.used >= 2 {
            self.unsettled = true;
            self.remember(from_path.to_path_buf());
            return None;
        }
        self.used += 1;
        let origin = match Origin::new(from_dir, from_name, from_path) {
            Ok(origin) => origin,
            Err(_) => {
                self.unsettled = true;
                self.remember(from_path.to_path_buf());
                return None;
            }
        };
        let slot = Slot {
            name: OsString::from(format!("slot-{}", self.used)),
            origin,
        };
        let captured = no_replace(
            from_dir.as_fd(),
            from_name,
            self.dir.as_fd(),
            &slot.name,
            Primitive::Capture,
        )
        .or_else(|errno| {
            if is_unsupported(errno) {
                // Fresh, absent slot inside our private directory. A squatter
                // arriving after this check is the documented window (a2).
                match fstatat(
                    self.dir.as_fd(),
                    slot.name.as_os_str(),
                    AtFlags::AT_SYMLINK_NOFOLLOW,
                ) {
                    Err(Errno::ENOENT) => renameat(
                        from_dir.as_fd(),
                        from_name,
                        self.dir.as_fd(),
                        slot.name.as_os_str(),
                    ),
                    Ok(_) => Err(Errno::EEXIST),
                    Err(error) => Err(error),
                }
            } else {
                Err(errno)
            }
        });
        match captured {
            Ok(()) => {
                self.remember(self.path.join(&slot.name));
                Some(slot)
            }
            Err(errno) => {
                self.last_errno = Some(errno);
                self.unsettled = true;
                self.remember(from_path.to_path_buf());
                // A competing entry at the private slot caused EEXIST: keep and
                // report it too. A slot observed occupied is never replaced.
                if fstatat(
                    self.dir.as_fd(),
                    slot.name.as_os_str(),
                    AtFlags::AT_SYMLINK_NOFOLLOW,
                )
                .is_ok()
                {
                    self.remember(self.path.join(&slot.name));
                }
                None
            }
        }
    }

    pub(super) fn checkpoint(&self) -> Checkpoint {
        Checkpoint {
            used: self.used,
            kept: self.kept.len(),
            unsettled: self.unsettled,
        }
    }

    /// The capture that just failed moved nothing when its errno says the rename
    /// was refused before it ran (a failed rename is atomic): forget it and hand
    /// back the errno so the caller can report an ordinary error with nothing to
    /// recover. Anything else (EIO and timeouts may follow a rename that took
    /// effect, an occupied private slot, the two-object cap) stays unsettled.
    pub(super) fn abort_capture(&mut self, mark: Checkpoint) -> Option<Errno> {
        let errno = self.last_errno.take()?;
        if !matches!(
            errno,
            Errno::ENOENT
                | Errno::EXDEV
                | Errno::EACCES
                | Errno::EPERM
                | Errno::EROFS
                | Errno::ENOTDIR
                | Errno::EISDIR
                | Errno::ENOSPC
                | Errno::EDQUOT
                | Errno::ELOOP
                | Errno::ENAMETOOLONG
                | Errno::EBUSY
        ) {
            return None;
        }
        self.used = mark.used;
        self.kept.truncate(mark.kept);
        self.unsettled = mark.unsettled;
        Some(errno)
    }

    /// Keep a slot's object where it is and report it (its origin is unproven).
    pub(super) fn keep(&mut self, slot: &Slot) {
        self.unsettled = true;
        self.remember(self.path.join(&slot.name));
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn record_public(&mut self, dir: &OwnedFd, name: &OsStr, path: &Path) {
        if fstatat(dir.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW).is_ok() {
            self.remember(path.to_path_buf());
        }
    }

    pub(super) fn holds(&self, slot: &Slot, held: &Held) -> bool {
        let Some(expected) = held.identity() else {
            return false;
        };
        fstatat(
            self.dir.as_fd(),
            slot.name.as_os_str(),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        )
        .is_ok_and(|raw| Stat::from_raw(&raw).same_object(&expected))
    }

    pub(super) fn matches_for_restore(&self, slot: &Slot, held: &Held) -> bool {
        fstatat(
            self.dir.as_fd(),
            slot.name.as_os_str(),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        )
        .is_ok_and(|raw| held.matches_for_restore(&Stat::from_raw(&raw)))
    }

    pub(super) fn restore(&mut self, ops: &FileOps, slot: &Slot) -> bool {
        let Origin {
            dir,
            name,
            path: public_path,
        } = &slot.origin;
        let restored = no_replace(
            self.dir.as_fd(),
            &slot.name,
            dir.as_fd(),
            name,
            Primitive::Restore,
        );
        if restored.is_err_and(is_unsupported) {
            // Public names must remain EEXIST-safe. Hold the actual slot before
            // linking it, then use the sole disposal primitive for its unlink.
            let linked = (|| -> FileResult<bool> {
                let raw = fstatat(
                    self.dir.as_fd(),
                    slot.name.as_os_str(),
                    AtFlags::AT_SYMLINK_NOFOLLOW,
                )
                .map_err(FileError::errno)?;
                let stat = Stat::from_raw(&raw);
                if stat.kind() == Kind::Dir {
                    return Ok(false);
                }
                let held = Held::open(&self.dir, &slot.name, stat)?;
                fault(Primitive::RestoreLink).map_err(FileError::errno)?;
                linkat(
                    self.dir.as_fd(),
                    slot.name.as_os_str(),
                    dir.as_fd(),
                    name.as_os_str(),
                    AtFlags::empty(),
                )
                .map_err(FileError::errno)?;
                Ok(self.dispose(ops, slot, &held))
            })();
            if matches!(linked, Ok(true)) {
                return true;
            }
            self.unsettled = true;
            self.record_public(dir, name, public_path);
            return false;
        }
        match restored {
            Ok(()) => {
                self.kept.retain(|p| *p != self.path.join(&slot.name));
                true
            }
            Err(_) => {
                self.unsettled = true;
                self.record_public(dir, name, public_path);
                false
            }
        }
    }

    pub(super) fn dispose(&mut self, ops: &FileOps, slot: &Slot, held: &Held) -> bool {
        // The seam is before the ownership check. Public-name successors must
        // already have been captured; tests must not simulate private exclusion.
        let _ = ops.step(Step::Disposing);
        if !self.holds(slot, held) {
            self.unsettled = true;
            return false;
        }
        match fault(Primitive::Unlink).and_then(|()| {
            unlinkat(
                self.dir.as_fd(),
                slot.name.as_os_str(),
                UnlinkatFlags::NoRemoveDir,
            )
        }) {
            Ok(()) => {
                self.kept.retain(|p| *p != self.path.join(&slot.name));
                true
            }
            Err(_) => {
                self.unsettled = true;
                false
            }
        }
    }

    /// Explicit end of the lifecycle. ENOTEMPTY and every other rmdir failure
    /// retain the directory. An already unsettled operation also retains even
    /// an empty directory so its recovery location stays discoverable. A
    /// captured/restored object is never auto-cleaned.
    pub(super) fn finish(&mut self) -> Vec<String> {
        if !self.finished {
            self.finished = true;
            if self.unsettled
                || fault(Primitive::Rmdir)
                    .and_then(|()| {
                        unlinkat(
                            self.parent.as_fd(),
                            self.name.as_os_str(),
                            UnlinkatFlags::RemoveDir,
                        )
                    })
                    .is_err()
            {
                self.unsettled = true;
                // Include the directory itself (also discovers externally added slots).
                if self.kept.is_empty() {
                    self.remember(self.path.clone());
                }
            }
            if self.unsettled || !self.kept.is_empty() {
                tracing::warn!(recovery = %self.path.display(), kept = ?self.kept, "file recovery retained; manual recovery required");
            }
        }
        // The wire schema bounds the list (`recovered` <= 4); the warning above
        // names every retained path, so nothing is lost by the clamp.
        self.kept
            .iter()
            .take(MAX_REPORTED)
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }

    pub(super) fn uncertain(&mut self) -> FileError {
        let kept = self.finish();
        FileError::new(
            ErrorCode::UncertainOutcome,
            "file outcome is uncertain; inspect recovery",
        )
        .with_detail(json!({ "recovery": self.path.to_string_lossy(), "kept": kept }))
    }

    pub(super) fn settled(&self) -> bool {
        !self.unsettled && self.kept.is_empty()
    }
}

impl Drop for RecoveryDir {
    fn drop(&mut self) {
        if !self.finished {
            // Safety net only removes an empty directory, never a slot.
            let _ = self.finish();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_ops::exchange::FaultScope;
    use crate::file_ops::tests::Fx;

    fn root(fx: &Fx) -> OwnedFd {
        nix::fcntl::open(
            &fx.root,
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .unwrap()
    }

    #[test]
    fn restore_uses_recorded_origin_fd_and_name_even_after_parent_rename() {
        let fx = Fx::new();
        let parent = root(&fx);
        let path = fx.put("source-dir/original-name", "captured object");
        fx.put("other-dir/original-name", "unrelated object");
        let source_dir = nix::fcntl::open(
            &fx.root.join("source-dir"),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .unwrap();
        let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
        let slot = recovery
            .capture(&source_dir, "original-name".as_ref(), &path)
            .unwrap();
        std::fs::rename(fx.root.join("source-dir"), fx.root.join("renamed-parent")).unwrap();
        drop(source_dir);
        assert!(recovery.restore(&fx.ops, &slot));
        assert_eq!(fx.get("renamed-parent/original-name"), "captured object");
        assert_eq!(fx.get("other-dir/original-name"), "unrelated object");
        assert!(!fx.root.join("original-name").exists());
        assert!(recovery.finish().is_empty());
    }

    #[test]
    fn moved_origin_cannot_be_reclaimed_by_a_successor() {
        let fx = Fx::new();
        let parent = root(&fx);
        let held_file = std::fs::File::open(fx.put("source", "checked source")).unwrap();
        let held = Held::from_file(&held_file).unwrap();
        let origin = Origin::new(&parent, "source".as_ref(), &fx.root.join("source")).unwrap();
        fx.put("destination", "foreign successor");
        let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
        let mut slot = recovery
            .capture(
                &parent,
                "destination".as_ref(),
                &fx.root.join("destination"),
            )
            .unwrap();
        assert!(!recovery.reclaim_origin(&mut slot, &held, origin));
        assert!(recovery.restore(&fx.ops, &slot));
        assert_eq!(fx.get("source"), "checked source");
        assert_eq!(fx.get("destination"), "foreign successor");
        assert!(recovery.finish().is_empty());
    }

    #[test]
    fn dispose_rejects_equal_path_snapshot_of_freed_and_recreated_object() {
        let fx = Fx::new();
        let parent = root(&fx);
        let path = fx.put("sample", "old unheld object");
        let stale = Stat::from_metadata(&std::fs::symlink_metadata(&path).unwrap());
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, "recreated only copy").unwrap();
        let recreated = Stat::from_metadata(&std::fs::symlink_metadata(&path).unwrap());
        assert_eq!(stale.dev, recreated.dev, "same filesystem");
        // Immediate reuse is permitted, not promised (ext4 reuses; APFS/tmpfs
        // may not). When observed, the stale identity equals the successor.
        if stale.ino == recreated.ino {
            assert!(stale.same_object(&recreated));
        }
        let held_file = std::fs::File::open(fx.put("held", "different pinned inode")).unwrap();
        let mut held = Held::from_file(&held_file).unwrap();
        // Simulate even a matching recycled/path-derived snapshot. This test
        // deterministically proves disposal ignores it and checks the live fd;
        // it does not claim to force inode reuse on every filesystem.
        held.stat = recreated;
        let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
        let slot = recovery.capture(&parent, "sample".as_ref(), &path).unwrap();
        let named = Stat::from_raw(
            &fstatat(
                recovery.dir.as_fd(),
                slot.name.as_os_str(),
                AtFlags::AT_SYMLINK_NOFOLLOW,
            )
            .unwrap(),
        );
        assert!(
            named.same_object(&held.stat),
            "path-derived proof would allow deletion"
        );
        assert!(!recovery.holds(&slot, &held));
        assert!(!recovery.dispose(&fx.ops, &slot, &held));
        let recovered = recovery.finish();
        assert_eq!(
            std::fs::read_to_string(&recovered[0]).unwrap(),
            "recreated only copy"
        );
    }

    #[test]
    fn unheld_object_is_retained_and_reported_in_recovered() {
        let fx = Fx::new();
        let parent = root(&fx);
        let path = fx.put("sample", "unheld only copy");
        let held = Held {
            fd: None,
            stat: Stat::from_metadata(&std::fs::metadata(&path).unwrap()),
        };
        let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
        let slot = recovery.capture(&parent, "sample".as_ref(), &path).unwrap();
        assert!(
            recovery.matches_for_restore(&slot, &held),
            "non-deleting restoration may use a snapshot"
        );
        assert!(!recovery.holds(&slot, &held));
        assert!(!recovery.dispose(&fx.ops, &slot, &held));
        let result = super::super::mutate::RenameResult {
            etag: None,
            recovered: recovery.finish(),
        };
        assert_eq!(
            std::fs::read_to_string(&result.recovered[0]).unwrap(),
            "unheld only copy"
        );
        assert!(serde_json::to_value(result).unwrap()["recovered"].is_array());
    }

    #[test]
    fn held_open_pins_regular_symlink_and_directory_objects() {
        let fx = Fx::new();
        let parent = root(&fx);
        fx.put("file", "bytes");
        std::os::unix::fs::symlink("missing-target", fx.root.join("symlink")).unwrap();
        std::fs::create_dir(fx.root.join("directory")).unwrap();
        for name in ["file", "symlink", "directory"] {
            let stat = Stat::from_metadata(&std::fs::symlink_metadata(fx.root.join(name)).unwrap());
            let held = Held::open(&parent, name.as_ref(), stat).unwrap();
            assert!(held.fd.is_some(), "{name}");
            std::fs::rename(fx.root.join(name), fx.root.join("moved")).unwrap();
            let now =
                Stat::from_metadata(&std::fs::symlink_metadata(fx.root.join("moved")).unwrap());
            assert!(held.identity().unwrap().same_object(&now));
            if name == "directory" {
                std::fs::remove_dir(fx.root.join("moved")).unwrap();
            } else {
                std::fs::remove_file(fx.root.join("moved")).unwrap();
            }
            assert!(
                held.identity().unwrap().same_object(&now),
                "unlinked inode is still pinned"
            );
        }
    }

    #[test]
    fn held_open_refuses_a_name_changed_since_lstat() {
        let fx = Fx::new();
        let parent = root(&fx);
        let path = fx.put("sample", "checked");
        let stat = Stat::from_metadata(&std::fs::metadata(&path).unwrap());
        // Keep the old inode alive to make this mismatch deterministic.
        std::fs::rename(&path, fx.root.join("old")).unwrap();
        std::fs::write(&path, "unchecked successor").unwrap();
        let error = Held::open(&parent, "sample".as_ref(), stat).err().unwrap();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(fx.get("sample"), "unchecked successor");
        assert_eq!(fx.get("old"), "checked");
    }

    #[test]
    fn restore_fallback_keeps_directories_and_unsupported_links() {
        for errno in [
            None,
            Some(Errno::EPERM),
            Some(Errno::ENOTSUP),
            Some(Errno::EMLINK),
            Some(Errno::EIO),
        ] {
            let fx = Fx::new();
            let parent = root(&fx);
            let path = fx.root.join("sample");
            if errno.is_none() {
                std::fs::create_dir(&path).unwrap();
                std::fs::write(path.join("child"), "directory bytes").unwrap();
            } else {
                std::fs::write(&path, "file bytes").unwrap();
            }
            let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
            let slot = recovery.capture(&parent, "sample".as_ref(), &path).unwrap();
            let mut faults = vec![(Primitive::Restore, 1, Errno::EINVAL)];
            if let Some(errno) = errno {
                faults.push((Primitive::RestoreLink, 1, errno));
            } else {
                faults.push((Primitive::RestoreLink, 1, Errno::EIO));
            }
            let _scope = FaultScope::new(&faults);
            assert!(!recovery.restore(&fx.ops, &slot));
            if errno.is_none() {
                assert_eq!(
                    fault(Primitive::RestoreLink),
                    Err(Errno::EIO),
                    "directories never attempt the link fallback"
                );
            }
            assert_eq!(recovery.uncertain().code, ErrorCode::UncertainOutcome);
            let kept = recovery.path.join(&slot.name);
            assert_eq!(
                std::fs::read_to_string(if errno.is_none() {
                    kept.join("child")
                } else {
                    kept
                })
                .unwrap(),
                if errno.is_none() {
                    "directory bytes"
                } else {
                    "file bytes"
                }
            );
            assert!(!path.exists());
        }
    }

    #[test]
    fn restore_fallback_never_overwrites_an_existing_public_object() {
        let fx = Fx::new();
        let parent = root(&fx);
        let path = fx.put("sample", "displaced original");
        let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
        let slot = recovery.capture(&parent, "sample".as_ref(), &path).unwrap();
        std::fs::write(&path, "newest public object").unwrap();
        let _scope = FaultScope::new(&[(Primitive::Restore, 1, Errno::EINVAL)]);
        assert!(!recovery.restore(&fx.ops, &slot));
        assert_eq!(fx.get("sample"), "newest public object");
        assert_eq!(
            std::fs::read_to_string(recovery.path.join(&slot.name)).unwrap(),
            "displaced original"
        );
        assert_eq!(recovery.uncertain().code, ErrorCode::UncertainOutcome);
    }

    #[test]
    fn restore_fallback_disposal_keeps_a_private_slot_successor() {
        let fx = Fx::new();
        let parent = root(&fx);
        let path = fx.put("sample", "linked original");
        let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
        let slot = recovery.capture(&parent, "sample".as_ref(), &path).unwrap();
        let private = recovery.path.join(&slot.name);
        let fx = fx.with_hook(move |step| {
            if step == Step::Disposing {
                std::fs::remove_file(&private).unwrap();
                std::fs::write(&private, "private successor").unwrap();
            }
            Ok(())
        });
        let _scope = FaultScope::new(&[(Primitive::Restore, 1, Errno::EINVAL)]);
        assert!(!recovery.restore(&fx.ops, &slot));
        let error = recovery.uncertain();
        assert_eq!(error.code, ErrorCode::UncertainOutcome);
        assert_eq!(fx.get("sample"), "linked original");
        assert_eq!(
            std::fs::read_to_string(recovery.path.join(&slot.name)).unwrap(),
            "private successor"
        );
        let kept = error.detail.unwrap()["kept"].as_array().unwrap().clone();
        assert_eq!(kept.len(), 2, "both the slot and public link are reported");
    }
}
