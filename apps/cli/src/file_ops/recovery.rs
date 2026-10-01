//! Per-operation recovery for replace, delete, exclusive create and rename.
//! One mode-0700 `.wsmp-recover-<10 alnum>` beside the target holds at most two
//! captured objects, including replace's temp. Private capability probes do not
//! consume that bound. Every slot records its origin dirfd/name; restore takes
//! no free-form target and never overwrites a public name. A live held fd proves
//! disposal ownership; every descriptor this process owns on that inode closes
//! after the proof and BEFORE unlink. Pathname snapshots never authorize deletion.
//!
//! Replace attempts exchange first. When unavailable, an ABSENT-name probe in R
//! selects NOREPLACE rename or link, BEFORE any public effect. Capture the original,
//! verify its held identity, then publish into the vacant name with that primitive.
//! No primitive means unsafe_filesystem, with no public change. A concurrent create
//! survives: the original stays named in recovery with uncertain_outcome. A file or
//! symlink delete likewise captures and verifies before disposal. Directories never
//! enter recovery for delete: kernel rmdir only removes empty directories, so a
//! racer's saved contents cannot be removed. A file/symlink delete fails closed on
//! ANY recovery mkdir failure (including ENOSPC/EDQUOT/EMLINK); free space using the
//! shell. A file the CLI user cannot open read-only (for example mode 000 or 0200)
//! has no Held on macOS and other Unix and refuses before capture with the real open
//! errno; so does a symlink on Unix targets other than Linux and macOS (it cannot be
//! held, EACCES). Linux O_PATH is unaffected.
//!
//! The vacant-name interval is a bounded number of syscalls, not a time promise:
//! scheduler/network delays or a crash can extend it. Readers see ENOENT. Publication
//! is only as atomic as the filesystem's NOREPLACE/link implementation; a daemon's
//! emulation cannot be verified here. Detection is per operation and errno-driven:
//! Linux vfat has exchange and NOREPLACE; exFAT has NOREPLACE without links; NFS/9p
//! commonly lack rename flags but permit links. macOS HFS+ has EXCL without SWAP;
//! SMB can lack links. Other Unix uses the no-replace/link ladder and fails closed.
//! Overwrite rename on exchange-less targets restores source then refuses; there
//! is no private preflight and no plain public overwrite fallback.
//!
//! Unsettled operations return uncertain_outcome; successful operations can report
//! recovered paths, including delete. Find `.wsmp-recover-*` beside the target;
//! retention is logged, recovery is manual using a shell, and no startup sweep
//! deletes retained data. File tools may read recovery paths but refuse mutations.
//!
//! Remaining POSIX windows (no cross-process exclusion is claimed):
//! (a) a same-user process guessing a private slot can replace it between the held
//! proof, close and final unlinkat and lose the successor. Closing adds one syscall.
//! (a2) when NOREPLACE is absent, capture plain-renames into a private slot checked
//! absent; a squatter between that check and rename can be overwritten.
//! (b) undo briefly vacates public names; a concurrent create blocks NOREPLACE/link
//! restoration and leaves displaced data reported in recovery. Link restore cannot
//! restore directories; unsupported links also stay in recovery with uncertainty.
//! (b2) overwrite rename's source is vacant from capture through operation end.
//! (d) a crash leaves the original and T (possibly partial tmp or renamed probe) in
//! R with a vacant public name, a deleted file in R with its name vacant, or both
//! published and private links. Empty unreported R after power loss is harmless.
//! (e) unheld objects are retained; they are never deleted by a snapshot.
//! (f) on NFS another process holding the file open can leave a `.nfs*` entry in R;
//! our own descriptors close before unlink. Retained R is reported for manual cleanup.
//! (g) link publication briefly exposes T before its private alias unlink. Someone
//! can open/write public T, then a third save can replace that name before unlink,
//! orphaning that exposed inode. A failed alias unlink retains nlink 2: later replace
//! refuses hard_linked until the reported alias is manually removed. Independently,
//! an in-place write to the original after its etag read remains lost on every fs.
//!
//! Separate residuals unchanged here: case-only rename's alias check-to-rename race;
//! exclusive create's public O_EXCL-then-write; rollback_created; per-mount privacy
//! of R and existing reporting bounds. Exchange-less overwrite rename remains a
//! refusal, distinct from replacement's safe vacate-first publication.

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
use super::exchange::{Primitive, fault, is_link_unsupported, is_unsupported, no_replace, run};
use super::resolve::{Kind, Stat};
use super::{Cancel, FileOps, Step};

/// Longest path list carried in a result or error detail (server schema bound).
const MAX_REPORTED: usize = 4;

/// Attempts at an unused `.wsmp-recover-*` name before failing closed with EEXIST.
const MAX_NAME_ATTEMPTS: usize = 16;

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
    /// Why the object could not be opened (none for kinds that are never opened).
    open_error: Option<Errno>,
}

impl Held {
    pub(super) fn from_file(file: &std::fs::File) -> FileResult<Self> {
        let fd = OwnedFd::from(file.try_clone()?);
        let stat = Stat::from_raw(&fstat(fd.as_fd()).map_err(FileError::errno)?);
        Ok(Self {
            fd: Some(fd),
            stat,
            open_error: None,
        })
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
            _ => {
                return Ok(Self {
                    fd: None,
                    stat,
                    open_error: None,
                });
            }
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
        let (fd, open_error) = match fault(Primitive::Hold).and(opened) {
            Ok(fd) => (Some(fd), None),
            Err(errno) => (None, Some(errno)),
        };
        if let Some(fd) = &fd {
            let opened = Stat::from_raw(&fstat(fd.as_fd()).map_err(FileError::errno)?);
            if !opened.same_object(&stat) {
                return Err(FileError::conflict("replaced"));
            }
        }
        Ok(Self {
            fd,
            stat,
            open_error,
        })
    }

    /// The errno of a failed open (none when the kind is never opened).
    pub(super) fn open_error(&self) -> Option<Errno> {
        self.open_error
    }

    pub(super) fn is_held(&self) -> bool {
        self.fd.is_some()
    }

    /// Release this proof only after the live comparison; all duplicate handles
    /// owned by the caller must also close before the unlink syscall.
    pub(super) fn release(&mut self) {
        self.fd.take();
    }

    fn identity(&self) -> Option<Stat> {
        // A failed observation must not turn a live descriptor into proof.
        let fd = self.fd.as_ref()?;
        run(Primitive::Identity, || fstat(fd.as_fd()))
            .ok()
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

#[derive(Clone, Copy)]
enum PublishMethod {
    NoReplace,
    Link,
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
        // A random 10-character name never collides on a correct filesystem. Bound
        // the retries so a filesystem that answers EEXIST to every mkdir fails
        // closed (nothing changed) instead of spinning under the namespace lock.
        let mut attempts = 0;
        loop {
            attempts += 1;
            let name = OsString::from(format!(
                ".wsmp-recover-{}",
                Alphanumeric.sample_string(&mut rand::rng(), 10)
            ));
            match run(Primitive::Mkdir, || {
                mkdirat(parent.as_fd(), name.as_os_str(), Mode::S_IRWXU)
            }) {
                Err(Errno::EEXIST) if attempts < MAX_NAME_ATTEMPTS => continue,
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

    /// Probes use absent private names and do not consume a capture slot. A
    /// successful NOREPLACE probe MOVES T, so update both its name and reporting.
    fn probe_publish(
        &mut self,
        ops: &FileOps,
        slot: &mut Slot,
        identity: &mut Held,
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
                let old = self.path.join(&slot.name);
                slot.name = probe;
                for path in &mut self.kept {
                    if *path == old {
                        *path = self.path.join(&slot.name);
                    }
                }
                return Ok(PublishMethod::NoReplace);
            }
            Err(errno) if is_unsupported(errno) => {}
            Err(errno) => return Err(FileError::errno(errno)),
        }
        run(Primitive::ProbeLink, || {
            linkat(
                self.dir.as_fd(),
                slot.name.as_os_str(),
                self.dir.as_fd(),
                probe.as_os_str(),
                AtFlags::empty(),
            )
        })
        .map_err(|errno| {
            if is_link_unsupported(errno) {
                FileError::unsafe_filesystem()
            } else {
                FileError::errno(errno)
            }
        })?;
        let alias = Slot {
            name: probe,
            origin: Origin::new(&slot.origin.dir, &slot.origin.name, &slot.origin.path)
                .map_err(FileError::errno)?,
        };
        self.remember(self.path.join(&alias.name));
        // Both names remain private. Names of one inode need not report one inode
        // number (FUSE without stable inodes, for example sshfs), so each private
        // name is proven by a proof opened on THAT name, never by comparing across
        // names. T's own proof closes before the alias unlink (no own descriptor on
        // the inode at an unlink), then the surviving name is re-held.
        let alias_stat = fstatat(
            self.dir.as_fd(),
            alias.name.as_os_str(),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        )
        .map_err(FileError::errno)?;
        let mut alias_held = Held::open(&self.dir, &alias.name, Stat::from_raw(&alias_stat))?;
        identity.release();
        if !self.dispose(ops, &alias, &mut alias_held) {
            return Err(self.uncertain());
        }
        let tmp_stat = fstatat(
            self.dir.as_fd(),
            slot.name.as_os_str(),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        )
        .map_err(FileError::errno)?;
        *identity = Held::open(&self.dir, &slot.name, Stat::from_raw(&tmp_stat))?;
        if !identity.is_held() {
            return Err(FileError::errno(
                identity.open_error().unwrap_or(Errno::EACCES),
            ));
        }
        Ok(PublishMethod::Link)
    }

    fn publish_slot(&self, slot: &Slot, method: PublishMethod) -> Result<(), Errno> {
        match method {
            PublishMethod::NoReplace => no_replace(
                self.dir.as_fd(),
                &slot.name,
                slot.origin.dir.as_fd(),
                &slot.origin.name,
                Primitive::Publish,
            ),
            PublishMethod::Link => run(Primitive::PublishLink, || {
                linkat(
                    self.dir.as_fd(),
                    slot.name.as_os_str(),
                    slot.origin.dir.as_fd(),
                    slot.origin.name.as_os_str(),
                    AtFlags::empty(),
                )
            }),
        }
    }

    /// Sole exchange-less commit owner. After the private capability probe,
    /// capture and verify the inspected public object, then publish only with
    /// a primitive that refuses an occupied name. No plain public rename.
    pub(super) fn publish_without_exchange(
        &mut self,
        ops: &FileOps,
        tmp: &mut Slot,
        original: &mut Held,
        identity: &mut Held,
        cancel: &Cancel,
    ) -> FileResult<()> {
        let before_capture = (|| {
            let method = self.probe_publish(ops, tmp, identity)?;
            if !self.holds(tmp, identity) {
                self.keep(tmp);
                return Err(self.uncertain());
            }
            ops.step(Step::Vacating)?;
            cancel.check()?; // last cancellation point; nothing public moved yet
            Ok(method)
        })();
        let method = match before_capture {
            Ok(method) => method,
            Err(error) => {
                // Alias cleanup failure must retain both private names. No
                // second disposal owns T after this owner has become uncertain.
                if error.code != ErrorCode::UncertainOutcome {
                    self.dispose(ops, tmp, identity);
                }
                return Err(error);
            }
        };
        let mark = self.checkpoint();
        let captured = self.capture(&tmp.origin.dir, &tmp.origin.name, &tmp.origin.path);
        let Some(captured) = captured else {
            let errno = self.abort_capture(mark);
            self.dispose(ops, tmp, identity);
            return Err(match errno {
                Some(Errno::ENOENT) => FileError::conflict("gone"),
                Some(errno) => FileError::errno(errno),
                None => self.uncertain(),
            });
        };
        if !self.holds(&captured, original) {
            original.release();
            if self.restore(ops, &captured) {
                let _ = ops.step(Step::Restored);
            }
            self.dispose(ops, tmp, identity);
            return if self.settled() {
                Err(FileError::conflict("replaced"))
            } else {
                Err(self.uncertain())
            };
        }
        // The vacant-name seam follows the original's identity proof. A hook
        // cannot cancel or abandon an object that was already captured.
        let _ = ops.step(Step::Vacated);
        let published = self.publish_slot(tmp, method);
        // NFS may report an error after the publish took effect. Reconcile ANY
        // error against the live held identity before deciding to compensate.
        let committed = published.is_ok()
            || fstatat(
                tmp.origin.dir.as_fd(),
                tmp.origin.name.as_os_str(),
                AtFlags::AT_SYMLINK_NOFOLLOW,
            )
            .is_ok_and(|raw| Stat::from_raw(&raw).same_object(&identity.stat));
        if committed {
            match method {
                PublishMethod::NoReplace => {
                    self.kept.retain(|p| *p != self.path.join(&tmp.name));
                    identity.release();
                }
                PublishMethod::Link => {
                    self.dispose(ops, tmp, identity);
                }
            }
            self.dispose(ops, &captured, original);
            return Ok(());
        }
        // Not committed: the original is preserved. An EEXIST racer must stay
        // untouched; do not capture it to finish this operation.
        if published == Err(Errno::EEXIST) {
            self.keep(&captured);
            original.release();
            self.dispose(ops, tmp, identity);
            return Err(self.uncertain());
        }
        original.release(); // close before a restore's possible link-alias unlink
        if self.restore(ops, &captured) {
            let _ = ops.step(Step::Restored);
        }
        self.dispose(ops, tmp, identity);
        let errno = match published {
            Err(errno) => errno,
            Ok(()) => return Ok(()),
        };
        let unsupported = match method {
            PublishMethod::NoReplace => is_unsupported(errno),
            PublishMethod::Link => is_link_unsupported(errno),
        };
        Err(if unsupported {
            FileError::unsafe_filesystem()
        } else {
            FileError::errno(errno)
        })
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
                let mut held = Held::open(&self.dir, &slot.name, stat)?;
                run(Primitive::RestoreLink, || {
                    linkat(
                        self.dir.as_fd(),
                        slot.name.as_os_str(),
                        dir.as_fd(),
                        name.as_os_str(),
                        AtFlags::empty(),
                    )
                })
                .map_err(FileError::errno)?;
                Ok(self.dispose(ops, slot, &mut held))
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

    pub(super) fn dispose(&mut self, ops: &FileOps, slot: &Slot, held: &mut Held) -> bool {
        // The seam is before the ownership check. Public-name successors must
        // already have been captured; tests must not simulate private exclusion.
        let _ = ops.step(Step::Disposing);
        if !self.holds(slot, held) {
            self.unsettled = true;
            return false;
        }
        held.release();
        match run(Primitive::Unlink, || {
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
                || run(Primitive::Rmdir, || {
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
        assert!(!recovery.dispose(&fx.ops, &slot, &mut held));
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
        let mut held = Held {
            fd: None,
            stat: Stat::from_metadata(&std::fs::metadata(&path).unwrap()),
            open_error: None,
        };
        let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
        let slot = recovery.capture(&parent, "sample".as_ref(), &path).unwrap();
        assert!(
            recovery.matches_for_restore(&slot, &held),
            "non-deleting restoration may use a snapshot"
        );
        assert!(!recovery.holds(&slot, &held));
        assert!(!recovery.dispose(&fx.ops, &slot, &mut held));
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

    #[test]
    fn private_noreplace_probe_renames_reporting_without_consuming_capture_capacity() {
        use std::io::Write;
        let fx = Fx::new();
        let parent = root(&fx);
        let original_path = fx.put("destination", "original");
        let original_stat = Stat::from_metadata(&std::fs::metadata(&original_path).unwrap());
        let mut original = Held::open(&parent, "destination".as_ref(), original_stat).unwrap();
        let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
        let (mut tmp, mut file) = recovery
            .create_temp(&parent, "destination".as_ref(), &original_path)
            .unwrap();
        file.write_all(b"replacement").unwrap();
        let mut identity = Held::from_file(&file).unwrap();
        drop(file);
        let _faults = FaultScope::new(&[]);
        assert!(matches!(
            recovery
                .probe_publish(&fx.ops, &mut tmp, &mut identity)
                .unwrap(),
            PublishMethod::NoReplace
        ));
        assert_eq!(tmp.name, "probe");
        assert_eq!(recovery.kept, [recovery.path.join("probe")]);
        assert!(!recovery.path.join("tmp").exists());
        assert_eq!(recovery.used, 1, "probe is not a capture");
        let original_slot = recovery
            .capture(&parent, "destination".as_ref(), &original_path)
            .unwrap();
        assert_eq!(original_slot.name, "slot-2");
        assert_eq!(recovery.used, 2);
        assert!(recovery.holds(&original_slot, &original));
        original.release();
        assert!(recovery.restore(&fx.ops, &original_slot));
        assert!(recovery.dispose(&fx.ops, &tmp, &mut identity));
        assert!(!identity.is_held());
        assert_eq!(
            recovery.used, 2,
            "restoring/disposal does not refund captures"
        );
        assert!(recovery.kept.is_empty());
        assert!(recovery.settled());
        assert!(recovery.finish().is_empty());
        assert_eq!(fx.get("destination"), "original");
    }

    #[test]
    fn private_link_probe_reopens_proof_and_alias_failure_retains_both_names_once() {
        for fail_unlink in [false, true] {
            let fx = Fx::new();
            let parent = root(&fx);
            fx.put("destination", "original");
            let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
            let (mut tmp, file) = recovery
                .create_temp(
                    &parent,
                    "destination".as_ref(),
                    &fx.root.join("destination"),
                )
                .unwrap();
            let mut identity = Held::from_file(&file).unwrap();
            drop(file);
            let mut faults = vec![(Primitive::ProbeNoReplace, 1, Errno::EINVAL)];
            if fail_unlink {
                faults.push((Primitive::Unlink, 1, Errno::EIO));
            }
            let _faults = FaultScope::new(&faults);
            let result = recovery.probe_publish(&fx.ops, &mut tmp, &mut identity);
            assert_eq!(recovery.used, 1);
            assert_eq!(fx.get("destination"), "original");
            assert_eq!(
                FaultScope::calls()
                    .iter()
                    .filter(|p| **p == Primitive::Unlink)
                    .count(),
                1
            );
            if fail_unlink {
                assert_eq!(result.err().unwrap().code, ErrorCode::UncertainOutcome);
                assert!(!identity.is_held(), "closed BEFORE even a refused unlink");
                assert_eq!(
                    recovery.kept,
                    [recovery.path.join("tmp"), recovery.path.join("probe")]
                );
                assert_eq!(std::fs::read_dir(&recovery.path).unwrap().count(), 2);
                assert!(!recovery.settled());
            } else {
                assert!(matches!(result.unwrap(), PublishMethod::Link));
                assert!(identity.is_held(), "surviving tmp has a new held proof");
                assert_eq!(recovery.kept, [recovery.path.join("tmp")]);
                assert!(!recovery.path.join("probe").exists());
                assert!(recovery.dispose(&fx.ops, &tmp, &mut identity));
                assert!(recovery.finish().is_empty());
            }
        }
    }

    #[test]
    fn private_link_probe_missing_reheld_proof_returns_eacces() {
        let fx = Fx::new();
        let parent = root(&fx);
        let destination = fx.put("destination", "original");
        let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
        let (mut tmp, file) = recovery
            .create_temp(&parent, "destination".as_ref(), &destination)
            .unwrap();
        let mut identity = Held::from_file(&file).unwrap();
        drop(file);
        let _scope = FaultScope::new(&[
            (Primitive::ProbeNoReplace, 1, Errno::EINVAL),
            (Primitive::Hold, 2, Errno::EACCES),
        ]);
        let error = recovery
            .probe_publish(&fx.ops, &mut tmp, &mut identity)
            .err()
            .unwrap();
        assert_eq!(error.code, ErrorCode::IoError);
        assert_eq!(error.message, "EACCES");
        assert!(!identity.is_held());
        assert_eq!(fx.get("destination"), "original");
        assert!(!recovery.path.join("probe").exists());
        assert!(recovery.path.join("tmp").exists());
        assert_eq!(
            FaultScope::calls()
                .iter()
                .filter(|p| **p == Primitive::Capture)
                .count(),
            0
        );
        // Restore a real proof for explicit cleanup after checking the contract.
        identity = Held::open(&recovery.dir, &tmp.name, identity.stat).unwrap();
        assert!(recovery.dispose(&fx.ops, &tmp, &mut identity));
        assert!(recovery.finish().is_empty());
    }

    /// The publication helper is shared by the regular-file temp flow. A real
    /// symlink slot makes accidentally following its source discriminating.
    #[test]
    fn link_publication_keeps_symlink_identity_without_following_its_target() {
        let fx = Fx::new();
        let parent = root(&fx);
        let target = fx.put("target", "target bytes must remain");
        let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
        let slot = Slot {
            name: OsString::from("private-link"),
            origin: Origin::new(
                &parent,
                "published-link".as_ref(),
                &fx.root.join("published-link"),
            )
            .unwrap(),
        };
        let private = recovery.path.join(&slot.name);
        std::os::unix::fs::symlink(&target, &private).unwrap();
        recovery.remember(private.clone());
        let stat = Stat::from_metadata(&std::fs::symlink_metadata(&private).unwrap());
        let mut identity = Held::open(&recovery.dir, &slot.name, stat).unwrap();
        assert!(identity.is_held());
        recovery.publish_slot(&slot, PublishMethod::Link).unwrap();
        let published = fx.root.join("published-link");
        let public_stat = Stat::from_metadata(&std::fs::symlink_metadata(&published).unwrap());
        assert_eq!(public_stat.kind(), Kind::Symlink);
        assert!(public_stat.same_object(&identity.stat));
        assert_eq!(std::fs::read_link(&published).unwrap(), target);
        assert!(recovery.dispose(&fx.ops, &slot, &mut identity));
        assert!(recovery.finish().is_empty());
        assert!(published.is_symlink());
        assert_eq!(fx.get("target"), "target bytes must remain");
    }

    #[test]
    fn recovery_name_allocation_is_bounded_and_fails_closed() {
        let fx = Fx::new();
        let parent = root(&fx);
        // Every mkdir answers EEXIST: the call must stop after the bound.
        let faults: Vec<_> = (1..=MAX_NAME_ATTEMPTS + 8)
            .map(|nth| (Primitive::Mkdir, nth, Errno::EEXIST))
            .collect();
        let _faults = FaultScope::new(&faults);
        let error = RecoveryDir::new(&parent, &fx.root).err().unwrap();
        assert_eq!(error.code, ErrorCode::Exists);
        assert_eq!(
            FaultScope::calls()
                .iter()
                .filter(|p| **p == Primitive::Mkdir)
                .count(),
            MAX_NAME_ATTEMPTS
        );
        assert_eq!(std::fs::read_dir(&fx.root).unwrap().count(), 0);
        // One collision below the bound still succeeds.
        let _faults = FaultScope::new(&[(Primitive::Mkdir, 1, Errno::EEXIST)]);
        let mut recovery = RecoveryDir::new(&parent, &fx.root).unwrap();
        assert!(recovery.finish().is_empty());
    }
}
