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
//! Overwrite rename preflights privately before capture: exchange or NR dummies,
//! then link probes on the actual S/D objects. Without a usable method nothing
//! public moves. Exchange-less NR rename vacates/proves S and D, then publishes
//! S fail-if-exists. Link publication is link-first when the probe alias and the
//! held source fd are the same object (stable inodes, including Linux NFS): link
//! S onto `to`, then capture S. noino/sshfs present a different inode per name
//! and keep vacate-first. Direct NR plain rename prepares R and a durable pending-effect fence. Directories use NR only, never overwrite, and resolved
//! own-subtree requests refuse invalid_input. A direct Move that returns EINVAL
//! while NR works inside R is a rejected destination name (`invalid_input`),
//! not a missing capability, and captures nothing.
//!
//! Unsettled operations return uncertain_outcome; successful operations can report
//! recovered paths, including delete. A journal, registry, pin or directory-sync
//! failure before the first public effect is a clean refusal: pins, INTENT, the
//! registry entry and R are removed and the error is io_error (unsafe_filesystem
//! when directory fsync is unsupported). Find `.wsmp-recover-*` beside the target;
//! retention is logged and no startup sweep deletes retained data. `wsmp recover
//! --apply` rolls forward a durable `committed` journal and rolls back only
//! interrupted `prepared`/`captured`/`capturing`/`compensating` journals and
//! deletes in `publishing` (pin-matched `mv -n`; a replace's own temp is
//! disposed, never restored). Rename/replace `publishing` stays manual. File tools may read recovery paths but refuse mutations.
//!
//! Remaining POSIX windows (no cross-process exclusion is claimed):
//! (a) a same-user process guessing a private slot can replace it between the held
//! proof, close and final unlinkat and lose the successor. Closing adds one syscall.
//! The link probe proves the alias only by a proof opened on that name, so the same
//! actor can also swap `probe` between its link and that proof. `tmp` must still be
//! the object this operation created before the link and again after the alias
//! unlink, compared with T's own fd, which stays open throughout (it pins T's inode
//! number against reuse); a swap is kept and reported, never published.
//! (a2) when NOREPLACE is absent, capture plain-renames into a private slot checked
//! absent; a squatter between that check and rename can be overwritten.
//! (b) undo briefly vacates public names; a concurrent create blocks NOREPLACE/link
//! restoration and leaves displaced data reported in recovery. Link restore cannot
//! restore directories; unsupported links also stay in recovery with uncertainty.
//! (b2) vacate-first recovery rename's source is vacant from capture through
//! operation end; link-first leaves the source name in place until `to` holds
//! that object. Exchange-less NR overwrite also vacates destination before
//! publication. Link-first overwrite vacates only the destination, links S, then
//! captures S.
//! (d) a crash leaves the original and T (possibly partial tmp or renamed probe) in
//! R with a vacant public name, a deleted file in R with its name vacant, or both
//! published and private links. Rename can leave S/D in R with public names
//! vacant (vacate-first) or only the destination vacant (link-first, before the
//! link). An `INTENT` file in R, fsynced with the directory before the first
//! capture (including exclusive-create and Move-verification fallbacks), is a
//! versioned map of slots to paths with phase, per-slot identity, pid, host,
//! and CLI version. An exclusive flock on `.wsmp-lock` is held for the op;
//! a stable sibling `.wsmp-lock-.wsmp-recover-<id>` protects final cleanup
//! while the internal lock closes before unlink (NFS sillyrename avoidance).
//! `wsmp recover` skips a directory it cannot lock and derives publication only
//! against a surviving private v3 hardlink anchor's live descriptor. Missing
//! anchors, directories and unsupported aliases retain ambiguity for
//! manual resolution. Private INTENT/anchor integrity is required, as with the
//! existing mode-0700 staging directory; malicious same-user tampering of all
//! private metadata is not excluded. Exchange rename swaps `from <-> to` first so no object is
//! reachable only through R; D is briefly visible under the source name. Live
//! R directories are indexed in the CLI state directory. Startup reads that
//! registry (O(registered)) and never walks file roots. Empty unreported R
//! after power loss is harmless.
//! (e) unheld objects are retained; they are never deleted by a snapshot. The
//! three pre-effect hardlink anchors (at most two user objects plus generated T)
//! are private aliases, not extra captured slots. Live link-survival guards
//! subtract those aliases, and original unlink closes matching anchor fds too.
//! (f) on NFS another process holding the file open can leave a `.nfs*` entry in R;
//! our own descriptors close before unlink (except T's pinned proof at the link
//! probe's alias unlink: clients that silly-rename per vnode, macOS/BSD NFS, may keep a
//! `.nfs*` alias until it closes). Retained R is reported for manual cleanup.
//! (g) replace/rename link publication briefly exposes T/S before alias unlink. Someone
//! can open/write public T, then a third save can replace that name before unlink,
//! orphaning that exposed inode. On a mount whose link counts can be believed (learned
//! per operation from the probe link, `calibrate_counts`; Linux reads them with
//! statx FORCE_SYNC) a count < 2 vetoes the unlink and keeps the last alias, narrowing
//! this to a race after that observation; where counts mean nothing (sshfs reports 1,
//! a daemon cache can be stale) there is no veto and (g) stands. Best effort, never a
//! proof. Failed alias cleanup can retain nlink 2: later replace
//! refuses hard_linked until the reported alias is manually removed. Independently,
//! an in-place write to the original after its etag read remains lost on every fs.
//!
//! Separate residuals unchanged here: case-only rename's alias check-to-rename race;
//! exclusive create's public O_EXCL-then-write; rollback_created; per-mount privacy
//! of R and existing reporting bounds. A link error after effect cannot prove
//! commit across alias names on noino; rename keeps/restores S and keeps D.
//!
//! The [`RecoveryDir`] methods are split by layer, top down: `publish`
//! (publication and the rename commit) over `probe` (private capability
//! probes) over `capture` (capture and restore) over `plan` (INTENT, its
//! anchors and the registry entry) over `settle` (held-identity disposal and
//! the final cleanup) over `barrier` (INTENT writes, directory syncs and the
//! durability fence); this file holds the types and the bookkeeping they share.

use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use nix::errno::Errno;
use nix::fcntl::{AtFlags, Flock, FlockArg, OFlag, openat};
use nix::sys::stat::{Mode, fstat, fstatat, mkdirat};
use nix::unistd::{UnlinkatFlags, dup, unlinkat};
use rand::distr::{Alphanumeric, SampleString};
use serde_json::json;

use super::intent::{Intent, IntentPhase};
use crate::services::file_ops::error::{ErrorCode, FileError, FileResult};
use crate::services::file_ops::fs::exchange::{Primitive, barrier_error, fault, run};
use crate::services::file_ops::fs::meta::{Kind, Stat};
use crate::services::file_ops::fs::resolve::Resolved;

mod barrier;
mod capture;
#[cfg(test)]
mod identity_boundary_tests;
mod plan;
mod probe;
mod publish;
mod settle;
#[cfg(test)]
mod tests;

/// Longest path list carried in a result or error detail (server schema bound).
const MAX_REPORTED: usize = 4;

/// Attempts at an unused `.wsmp-recover-*` name before failing closed with EEXIST.
const MAX_NAME_ATTEMPTS: usize = 16;

/// Recorded before a move, so undo cannot choose a new public target.
pub(in crate::services::file_ops) struct Origin {
    dir: OwnedFd,
    name: OsString,
    path: PathBuf,
}

impl Origin {
    pub(in crate::services::file_ops) fn new(
        dir: &OwnedFd,
        name: &OsStr,
        path: &Path,
    ) -> Result<Self, Errno> {
        Ok(Self {
            dir: dup(dir.as_fd())?,
            name: name.to_os_string(),
            path: path.to_path_buf(),
        })
    }
}

pub(in crate::services::file_ops) struct Slot {
    name: OsString,
    origin: Origin,
}

impl Slot {
    pub(in crate::services::file_ops) fn origin_dir(&self) -> &OwnedFd {
        &self.origin.dir
    }
}

/// Only a live fd pins an inode and authorizes disposal. The snapshot permits
/// non-deleting restoration when a platform cannot open the object.
pub(in crate::services::file_ops) struct Held {
    fd: Option<OwnedFd>,
    stat: Stat,
    /// Why the object could not be opened (none for kinds that are never opened).
    open_error: Option<Errno>,
}

impl Held {
    pub(in crate::services::file_ops) fn from_file(file: &std::fs::File) -> FileResult<Self> {
        let fd = OwnedFd::from(file.try_clone()?);
        let stat = Stat::from_raw(&fstat(fd.as_fd()).map_err(FileError::errno)?);
        Ok(Self {
            fd: Some(fd),
            stat,
            open_error: None,
        })
    }

    pub(in crate::services::file_ops) fn open(
        dir: &OwnedFd,
        name: &OsStr,
        stat: Stat,
    ) -> FileResult<Self> {
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

    /// The identity snapshot this proof was taken on.
    pub(in crate::services::file_ops) fn stat(&self) -> Stat {
        self.stat
    }

    /// The errno of a failed open (none when the kind is never opened).
    pub(in crate::services::file_ops) fn open_error(&self) -> Option<Errno> {
        self.open_error
    }

    pub(in crate::services::file_ops) fn is_held(&self) -> bool {
        self.fd.is_some()
    }

    /// Live inode of the held descriptor. Not a fault point: the link-order
    /// decision compares this with the probe alias and must not consume `Identity`.
    fn live_stat(&self) -> Option<Stat> {
        let fd = self.fd.as_ref()?;
        fstat(fd.as_fd()).ok().map(|raw| Stat::from_raw(&raw))
    }

    /// Release this proof only after the live comparison; all duplicate handles
    /// owned by the caller must also close before the unlink syscall.
    pub(in crate::services::file_ops) fn release(&mut self) {
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
    pub(in crate::services::file_ops) fn matches_for_restore(&self, stat: &Stat) -> bool {
        match &self.fd {
            Some(_) => self.identity().is_some_and(|held| held.same_object(stat)),
            None => self.stat.same_object(stat),
        }
    }
}

#[derive(Clone, Copy)]
pub(in crate::services::file_ops) enum PublishMethod {
    NoReplace,
    Link,
}

/// Link publication order, learned from the source probe. Stable inodes prove
/// the name created by `linkat` is the held source, so S can stay until `to`
/// exists. Different presented inodes (noino, sshfs) cannot, and vacate first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::services::file_ops) enum LinkOrder {
    LinkFirst,
    VacateFirst,
}

/// The unpublished object has exactly one owner. Generated temps are disposable;
/// a user's source always returns to its recorded origin or stays reported in R.
pub(in crate::services::file_ops) enum Published<'a> {
    Temp,
    UserSource {
        origin: &'a Resolved,
        target: &'a Resolved,
        method: PublishMethod,
    },
}

pub(in crate::services::file_ops) struct RecoveryDir {
    parent: OwnedFd,
    dir: OwnedFd,
    name: OsString,
    path: PathBuf,
    used: usize,
    kept: Vec<PathBuf>,
    unsettled: bool,
    /// A failed persistence/barrier after a public effect is fatal to this
    /// lifecycle. Ordinary unlink residue can follow a proven commit; this flag
    /// cannot grant that authority.
    durability_failed: bool,
    /// Set immediately before the first syscall that can change a public name.
    effect_started: bool,
    /// A barrier failed BEFORE any public effect. Nothing public changed and R
    /// holds only private, disposable entries (pins, INTENT, generated files):
    /// the operation stops and cleans R, returning this error.
    pre_effect_abort: Option<FileError>,
    /// The `committed` INTENT is durable: later cleanup barriers cannot make
    /// the acknowledged outcome uncertain; residue is reported as recovered.
    committed: bool,
    finished: bool,
    last_errno: Option<Errno>,
    /// Whether this mount's link counts can be believed, learned from this operation's own
    /// link probe (see `calibrate_counts`). `Some(true)` is the only state that lets a count
    /// veto an alias unlink.
    counts_reliable: Option<bool>,
    /// Set by the first link probe (the source object on rename). `None` until then.
    link_order: Option<LinkOrder>,
    intent: Option<Intent>,
    registered: bool,
    /// Exclusive flock on `.wsmp-lock` inside R. Recover skips a directory
    /// it cannot lock, so a live op is never rolled back.
    lock: Option<Flock<File>>,
    /// Stable sibling lock survives deletion of metadata inside R.
    cleanup_lock: Option<Flock<File>>,
    /// Live proof for our own anchor names, never a persisted snapshot.
    anchors: Vec<(String, Held)>,
}

/// State to return to when a capture provably changed nothing.
pub(in crate::services::file_ops) struct Checkpoint {
    used: usize,
    kept: usize,
    unsettled: bool,
    phase: Option<IntentPhase>,
    effect_started: bool,
}

impl RecoveryDir {
    pub(in crate::services::file_ops) fn new(
        parent: &OwnedFd,
        parent_path: &Path,
    ) -> FileResult<Self> {
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
                // Exhausted: not "the path exists" (the caller's target is fine).
                Err(Errno::EEXIST) => return Err(FileError::new(ErrorCode::IoError, "EEXIST")),
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
            let cleanup_lock = lock_cleanup(&path, false).map_err(|error| FileError::io(&error))?;
            let lock = lock_recovery_dir(&path);
            return Ok(Self {
                parent,
                dir,
                name,
                path,
                used: 0,
                kept: Vec::new(),
                unsettled: false,
                durability_failed: false,
                effect_started: false,
                pre_effect_abort: None,
                committed: false,
                finished: false,
                last_errno: None,
                counts_reliable: None,
                link_order: None,
                intent: None,
                registered: false,
                lock,
                cleanup_lock,
                anchors: Vec::new(),
            });
        }
    }

    /// Replace staging is private from its creation onward. Its intended public
    /// origin is recorded before creating it; after exchange that origin belongs
    /// to the displaced destination object in the same slot.
    pub(in crate::services::file_ops) fn create_temp(
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
    pub(in crate::services::file_ops) fn exchange(
        &mut self,
        slot: &mut Slot,
        destination: Origin,
    ) -> Result<Origin, Errno> {
        let before = self.effect_checkpoint();
        if self.begin_public_effect().is_err() {
            // A failed barrier already refuses every public effect; the
            // caller's own phase write reports it first in practice.
            return Err(Errno::EIO);
        }
        if let Err(errno) = crate::services::file_ops::fs::exchange::exchange(
            self.dir.as_fd(),
            &slot.name,
            destination.dir.as_fd(),
            &destination.name,
        ) {
            self.effect_refused(before, errno);
            return Err(errno);
        }
        Ok(std::mem::replace(&mut slot.origin, destination))
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(in crate::services::file_ops) fn exchange_temp(
        &mut self,
        slot: &mut Slot,
    ) -> Result<(), Errno> {
        let origin = Origin::new(&slot.origin.dir, &slot.origin.name, &slot.origin.path)?;
        self.exchange(slot, origin).map(|_| ())
    }

    pub(in crate::services::file_ops) fn capture_origin(&mut self, slot: &Slot) -> Option<Slot> {
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

    fn remember(&mut self, path: PathBuf) {
        if !self.kept.contains(&path) {
            self.kept.push(path);
        }
    }

    pub(in crate::services::file_ops) fn holds(&self, slot: &Slot, held: &Held) -> bool {
        self.holds_name(&self.dir, &slot.name, held)
    }

    pub(super) fn holds_name(&self, dir: &OwnedFd, name: &OsStr, held: &Held) -> bool {
        let Some(expected) = held.identity() else {
            return false;
        };
        fstatat(dir.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW)
            .is_ok_and(|raw| Stat::from_raw(&raw).same_object(&expected))
    }

    /// Follow a private object that moved to a new name inside R: the slot and the
    /// reported (kept) path change together.
    fn adopt_name(&mut self, slot: &mut Slot, name: OsString) {
        let old = self.path.join(&slot.name);
        slot.name = name;
        for path in &mut self.kept {
            if *path == old {
                *path = self.path.join(&slot.name);
            }
        }
    }
}

pub(in crate::services::file_ops) fn cleanup_lock_path(path: &Path) -> PathBuf {
    path.with_file_name(format!(
        ".wsmp-lock-{}",
        path.file_name().unwrap_or_default().to_string_lossy()
    ))
}

pub(in crate::services::file_ops) fn lock_cleanup(
    path: &Path,
    nonblocking: bool,
) -> std::io::Result<Option<Flock<File>>> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(cleanup_lock_path(path))?;
    if file.metadata()?.len() != 0 {
        return Err(std::io::Error::other("cleanup lock contains foreign bytes"));
    }
    let arg = if nonblocking {
        FlockArg::LockExclusiveNonblock
    } else {
        FlockArg::LockExclusive
    };
    match Flock::lock(file, arg) {
        Ok(lock) => {
            use std::os::unix::fs::MetadataExt;
            let held = lock.metadata()?;
            let named = std::fs::symlink_metadata(cleanup_lock_path(path))?;
            if !named.is_file() || held.dev() != named.dev() || held.ino() != named.ino() {
                return Err(std::io::Error::other("cleanup lock identity changed"));
            }
            Ok(Some(lock))
        }
        Err((_, Errno::ENOTSUP | Errno::ENOSYS)) => Ok(None),
        Err((_, errno)) => Err(std::io::Error::from_raw_os_error(errno as i32)),
    }
}

pub(in crate::services::file_ops) fn unlink_cleanup_lock(
    parent: &OwnedFd,
    name: &OsStr,
    lock: Option<&Flock<File>>,
) {
    let Some(lock) = lock else { return };
    let Ok(held) = fstat(lock.as_fd()) else {
        return;
    };
    let Ok(named) = fstatat(parent.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW) else {
        return;
    };
    if held.st_dev == named.st_dev && held.st_ino == named.st_ino && named.st_size == 0 {
        // Outside R: even NFS sillyrename cannot prevent R's completed rmdir.
        // Release the fd immediately after this final mutation.
        let _ = unlinkat(parent.as_fd(), name, UnlinkatFlags::NoRemoveDir);
    }
}

fn lock_recovery_dir(path: &Path) -> Option<Flock<File>> {
    let lock_path = path.join(".wsmp-lock");
    let file = match OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(&lock_path)
    {
        Ok(file) => file,
        Err(error) => {
            tracing::warn!(
                recovery = %path.display(),
                error = %error,
                "could not create recovery lock; recover falls back to pid liveness"
            );
            return None;
        }
    };
    match Flock::lock(file, FlockArg::LockExclusive) {
        Ok(lock) => Some(lock),
        Err((_, error)) => {
            tracing::warn!(
                recovery = %path.display(),
                error = %error,
                "could not flock recovery directory; recover falls back to pid liveness"
            );
            None
        }
    }
}

fn tolerate_dir_fsync(result: Result<(), Errno>, path: &Path) -> FileResult<()> {
    match result {
        Ok(()) => Ok(()),
        Err(errno) => {
            tracing::warn!(recovery = %path.display(), %errno, "directory sync failed; durability is not proven");
            Err(barrier_error(errno))
        }
    }
}

/// Errnos with which a rename, link or O_EXCL create is refused atomically.
/// ENOENT is excluded: an NFS retransmit can report it after a success.
pub(in crate::services::file_ops) fn refused_without_effect(errno: Errno) -> bool {
    matches!(
        errno,
        Errno::EEXIST
            | Errno::EINVAL
            | Errno::ENOSYS
            | Errno::ENOTSUP
            | Errno::EXDEV
            | Errno::EACCES
            | Errno::EPERM
            | Errno::EROFS
            | Errno::ENOSPC
            | Errno::EDQUOT
            | Errno::EMLINK
            | Errno::ENAMETOOLONG
            | Errno::ELOOP
            | Errno::ENOTDIR
            | Errno::EISDIR
            | Errno::EBUSY
    )
}

/// Report abandoned recovery directories from the durable registry.
/// Never walks file roots (that can hang on a dead NFS mount). Never deletes.
pub(crate) fn report_abandoned_recovery() {
    for entry in super::registry::abandoned_entries() {
        tracing::warn!(recovery = %entry.path, op = %entry.summary.op,
            phase = %entry.summary.phase,
            "abandoned recovery registry entry; run `wsmp recover` to inspect (directory existence not checked at startup)");
    }
}

impl Drop for RecoveryDir {
    fn drop(&mut self) {
        if !self.finished {
            // Safety net only removes an empty directory, never a slot.
            // INTENT is discarded only when R is empty (`settled()`).
            let _ = self.finish();
        }
    }
}
