//! Per-operation recovery, allocated before any exchange. One mode-0700
//! `.wsmp-recover-<10 alnum>` directory beside the destination holds at most two
//! captured objects. Captures and restores use NOREPLACE, without fallback.
//! Only a proven object INSIDE this private directory can be unlinked. Every
//! retained location is logged and returned; recovery is manual using a shell.
//! Find `.wsmp-recover-*` beside the target. File tools can read these paths but
//! refuse mutations; no startup sweep or automatic deletion of retained data.
//!
//! Exact remaining POSIX windows (no cross-process exclusion is claimed):
//! (a) between a slot identity check and its final unlink, a same-user process
//! that discovers this unpredictable, short-lived private directory and replaces
//! the slot can lose its replacement. This is the only deleting window.
//! (b) conflict undo briefly vacates public names: a concurrent create makes a
//! NOREPLACE restore fail EEXIST, keeping displaced data here with an uncertain
//! outcome. (c) exchange-less filesystems retain the plain-rename replace race.
//! (d) a crash between steps leaves recovery/staging names, without deleting data.

use std::ffi::{OsStr, OsString};
use std::os::fd::{AsFd, OwnedFd};
use std::path::{Path, PathBuf};

use nix::errno::Errno;
use nix::fcntl::{AtFlags, OFlag, openat};
use nix::sys::stat::{Mode, fstatat, mkdirat};
use nix::unistd::{UnlinkatFlags, dup, unlinkat};
use rand::distr::{Alphanumeric, SampleString};
use serde_json::json;

use super::error::{ErrorCode, FileError, FileResult};
use super::exchange::{Primitive, fault, no_replace};
use super::resolve::Stat;
use super::{FileOps, Step};

/// Longest path list carried in a result or error detail (server schema bound).
const MAX_REPORTED: usize = 4;

pub(super) struct Slot(OsString);

pub(super) struct RecoveryDir {
    parent: OwnedFd,
    dir: OwnedFd,
    name: OsString,
    path: PathBuf,
    used: usize,
    kept: Vec<PathBuf>,
    unsettled: bool,
    finished: bool,
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
            });
        }
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
        let slot = Slot(OsString::from(format!("slot-{}", self.used)));
        match no_replace(
            from_dir.as_fd(),
            from_name,
            self.dir.as_fd(),
            &slot.0,
            Primitive::Capture,
        ) {
            Ok(()) => {
                self.remember(self.path.join(&slot.0));
                Some(slot)
            }
            Err(_) => {
                self.unsettled = true;
                self.remember(from_path.to_path_buf());
                // A competing entry at the private slot caused EEXIST: keep and
                // report it too. Capture never replaces an occupied slot.
                if fstatat(
                    self.dir.as_fd(),
                    slot.0.as_os_str(),
                    AtFlags::AT_SYMLINK_NOFOLLOW,
                )
                .is_ok()
                {
                    self.remember(self.path.join(&slot.0));
                }
                None
            }
        }
    }

    pub(super) fn record_public(&mut self, dir: &OwnedFd, name: &OsStr, path: &Path) {
        if fstatat(dir.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW).is_ok() {
            self.remember(path.to_path_buf());
        }
    }

    pub(super) fn holds(&self, slot: &Slot, expected: &Stat) -> bool {
        fstatat(
            self.dir.as_fd(),
            slot.0.as_os_str(),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        )
        .is_ok_and(|raw| Stat::from_raw(&raw).same_object(expected))
    }

    pub(super) fn restore(
        &mut self,
        slot: &Slot,
        dir: &OwnedFd,
        name: &OsStr,
        public_path: &Path,
    ) -> bool {
        match no_replace(
            self.dir.as_fd(),
            &slot.0,
            dir.as_fd(),
            name,
            Primitive::Restore,
        ) {
            Ok(()) => {
                self.kept.retain(|p| *p != self.path.join(&slot.0));
                true
            }
            Err(_) => {
                self.unsettled = true;
                self.record_public(dir, name, public_path);
                false
            }
        }
    }

    pub(super) fn dispose(&mut self, ops: &FileOps, slot: &Slot, expected: &Stat) -> bool {
        // The seam is before the ownership check. Public-name successors must
        // already have been captured; tests must not simulate private exclusion.
        let _ = ops.step(Step::Disposing);
        if !self.holds(slot, expected) {
            self.unsettled = true;
            return false;
        }
        match fault(Primitive::Unlink).and_then(|()| {
            unlinkat(
                self.dir.as_fd(),
                slot.0.as_os_str(),
                UnlinkatFlags::NoRemoveDir,
            )
        }) {
            Ok(()) => {
                self.kept.retain(|p| *p != self.path.join(&slot.0));
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
