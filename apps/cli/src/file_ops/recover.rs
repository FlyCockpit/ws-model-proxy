//! Idempotent recovery of abandoned `.wsmp-recover-*` directories from INTENT.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use nix::errno::Errno;
use nix::fcntl::{AtFlags, Flock, FlockArg, OFlag, open};
use nix::sys::stat::{Mode, fstatat};
use nix::unistd::{UnlinkatFlags, unlinkat};
use serde::Serialize;

use super::exchange::Primitive;
use super::exchange::no_replace;
use super::intent::{
    INTENT_MAX_BYTES, Intent, IntentOp, IntentPhase, IntentSlot, intent_phase_name, parse_intent,
};
use super::registry::{self, RegistryEntry};
use super::resolve::Stat;

const SCAN_REPORT_MAX: usize = 32;
const SCAN_VISIT_MAX: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecoverAction {
    Listed,
    RolledBack,
    RolledForward,
    Cleaned,
    SkippedLive,
    NeedsScan,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverReport {
    pub path: String,
    pub action: RecoverAction,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub slots: Vec<String>,
}

pub fn recover_from_registry(apply: bool) -> Vec<RecoverReport> {
    let mut reports = Vec::new();
    for entry in registry::list_entries() {
        reports.push(recover_entry(&entry, apply));
        if apply
            && matches!(
                reports.last().map(|report| report.action),
                Some(
                    RecoverAction::RolledBack
                        | RecoverAction::RolledForward
                        | RecoverAction::Cleaned
                )
            )
        {
            registry::unregister(&entry.recovery_path());
        }
        if apply && !entry.recovery_path().is_dir() {
            registry::unregister(&entry.recovery_path());
        }
    }
    reports
}

pub fn recover_scan(roots: &[PathBuf], apply: bool) -> Vec<RecoverReport> {
    let already: HashSet<PathBuf> = registry::list_entries()
        .into_iter()
        .map(|entry| entry.recovery_path())
        .collect();
    let mut reports = Vec::new();
    for root in roots {
        let mut reported = 0usize;
        let mut visited = 0usize;
        let found = scan_recovery_dirs_in(root, &mut reported, &mut visited);
        reports.extend(
            found
                .into_iter()
                .filter(|path| !already.contains(path))
                .map(|path| recover_dir(&path, apply, None)),
        );
        if visited >= SCAN_VISIT_MAX || reported >= SCAN_REPORT_MAX {
            reports.push(RecoverReport {
                path: root.display().to_string(),
                action: RecoverAction::NeedsScan,
                message:
                    "scan budget reached; remaining .wsmp-recover directories were not visited"
                        .to_string(),
                phase: None,
                slots: Vec::new(),
            });
        }
    }
    reports
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn scan_recovery_dirs(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for root in roots {
        let mut reported = 0usize;
        let mut visited = 0usize;
        found.extend(scan_recovery_dirs_in(root, &mut reported, &mut visited));
    }
    found
}

fn scan_recovery_dirs_in(root: &Path, reported: &mut usize, visited: &mut usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    collect_recovery(root, reported, visited, &mut found);
    found
}

fn recover_entry(entry: &RegistryEntry, apply: bool) -> RecoverReport {
    let path = entry.recovery_path();
    recover_dir(&path, apply, Some(entry))
}

pub fn recover_dir(path: &Path, apply: bool, entry: Option<&RegistryEntry>) -> RecoverReport {
    let slots = present_slots(path);
    if !path.is_dir() {
        if apply && super::recovery::cleanup_lock_path(path).exists() {
            match super::recovery::lock_cleanup(path, true) {
                Ok(Some(lock)) if !path.exists() => {
                    unlink_cleanup_sibling(path, Some(&lock));
                    drop(lock);
                }
                Ok(_) => {}
                Err(error) => {
                    return RecoverReport {
                        path: path.display().to_string(),
                        action: RecoverAction::Listed,
                        message: format!("orphan cleanup lock retained: {error}"),
                        phase: None,
                        slots,
                    };
                }
            }
        }
        return RecoverReport {
            path: path.display().to_string(),
            action: RecoverAction::Cleaned,
            message: "recovery directory is gone; registry entry can be dropped".to_string(),
            phase: None,
            slots,
        };
    }
    if let Some(entry) = entry
        && let Some(report) = skip_live_pid(
            path,
            &entry.summary.host,
            entry.summary.pid,
            Some(entry.summary.phase.clone()),
            slots.clone(),
        )
    {
        return report;
    }
    let cleanup_lock = match if apply {
        super::recovery::lock_cleanup(path, true)
    } else {
        Ok(None)
    } {
        Ok(lock) => lock,
        Err(error) => {
            return RecoverReport {
                path: path.display().to_string(),
                action: RecoverAction::SkippedLive,
                message: format!("cannot acquire cleanup lock: {error}"),
                phase: None,
                slots,
            };
        }
    };
    let held_lock = match try_hold_recovery_lock(path) {
        Ok(lock) => lock,
        Err(report) => return report,
    };
    // The sibling remains locked through every mutation and final rmdir. Closing
    // the internal lock now prevents NFS sillyrename inside the recovery dir.
    let _held_lock = if cleanup_lock.is_some() {
        drop(held_lock);
        None
    } else {
        held_lock
    };
    let report = match read_intent_file(path) {
        Ok(None)
            if apply
                && cleanup_lock.is_some()
                && fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none()) =>
        {
            RecoverReport {
                path: path.display().to_string(),
                action: if fs::remove_dir(path).is_ok() {
                    RecoverAction::Cleaned
                } else {
                    RecoverAction::Listed
                },
                message: "empty INTENT-less recovery residue".to_string(),
                phase: None,
                slots,
            }
        }
        Ok(None) => RecoverReport {
            path: path.display().to_string(),
            action: RecoverAction::Listed,
            message: if slots.is_empty() {
                "INTENT is absent; no slots present".to_string()
            } else {
                format!("INTENT is absent; present slots: {}", slots.join(", "))
            },
            phase: None,
            slots,
        },
        Err(message) => RecoverReport {
            path: path.display().to_string(),
            action: RecoverAction::Listed,
            message,
            phase: None,
            slots,
        },
        Ok(Some(intent)) => {
            if let Some(report) = skip_live_pid(
                path,
                &intent.host,
                intent.pid,
                Some(intent_phase_name(intent.phase).to_string()),
                slots.clone(),
            ) {
                return report;
            }
            apply_intent(path, &intent, apply && cleanup_lock.is_some(), slots)
        }
    };
    if !path.exists() {
        unlink_cleanup_sibling(path, cleanup_lock.as_ref());
        drop(cleanup_lock);
    }
    report
}

fn unlink_cleanup_sibling(path: &Path, lock: Option<&Flock<File>>) {
    let lock_path = super::recovery::cleanup_lock_path(path);
    if let Some(parent_path) = lock_path.parent()
        && let Some(name) = lock_path.file_name()
        && let Ok(parent) = open_dir(parent_path)
    {
        super::recovery::unlink_cleanup_lock(&parent, name, lock);
    }
}

fn try_hold_recovery_lock(path: &Path) -> Result<Option<Flock<File>>, RecoverReport> {
    let lock_path = path.join(".wsmp-lock");
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(&lock_path)
    {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(RecoverReport {
                path: path.display().to_string(),
                action: RecoverAction::Listed,
                message: format!("open recovery lock: {err}"),
                phase: None,
                slots: present_slots(path),
            });
        }
    };
    match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
        Ok(lock) => Ok(Some(lock)),
        Err((_, Errno::EWOULDBLOCK)) => Err(RecoverReport {
            path: path.display().to_string(),
            action: RecoverAction::SkippedLive,
            message: "another process holds the recovery lock".to_string(),
            phase: None,
            slots: present_slots(path),
        }),
        Err(_) => Ok(None),
    }
}

/// Narrow automatic undo. An interrupted `capturing` journal moved at most
/// the captured object into R, and a delete in `publishing` was never
/// acknowledged (success is returned only after `committed` is durable;
/// between `captured` and `committed` a delete issues no public syscall).
/// Both roll back through `restore_slot`'s rules only: the kept hardlink pin
/// must match and `mv -n` never overwrites a newer public file. A rename or
/// replace in `publishing` may already have published a new object at a public
/// name, so it stays manual.
fn manual_only(op: IntentOp, phase: IntentPhase) -> bool {
    phase == IntentPhase::Publishing && op != IntentOp::Delete
}

/// Rename/replace `publishing`: the interrupted operation never proved its
/// outcome, so neither rollback nor roll-forward is chosen automatically.
const MANUAL_RESOLUTION: &str = "the operation stopped before its outcome was proven, so nothing is applied automatically. \
For each listed slot, compare it with its `origin` in INTENT and with the current public file; \
move a copy you want back with `mv -n <slot> <origin>` (never overwrite a newer public file). \
Then delete this directory, including its `.wsmp-pin-*` hardlinks (which otherwise make the public file look hard-linked), and the sibling `.wsmp-lock-.wsmp-recover-*` file beside it";

fn derived_phase(dir: &Path, intent: &Intent) -> IntentPhase {
    // A durable commit is authoritative even if delete/rename vacated origin.
    if intent.phase == IntentPhase::Committed {
        return intent.phase;
    }
    if matches!(
        intent.phase,
        IntentPhase::Publishing | IntentPhase::Compensating | IntentPhase::Capturing
    ) {
        return intent.phase;
    }
    if matches!(intent.op, IntentOp::Rename | IntentOp::Replace)
        && let Some(published) = &intent.published
        && let Some(destination) = published.origin.to_path()
        && let Ok(metadata) = fs::symlink_metadata(destination)
        && intent.version >= 3
        && let Ok(recovery) = open_dir(dir)
        && anchored_identity(&recovery, published)
            .is_ok_and(|pin| pin.matches_for_restore(&Stat::from_metadata(&metadata)))
    {
        return IntentPhase::Committed;
    }
    intent.phase
}

fn skip_live_pid(
    path: &Path,
    host: &str,
    pid: u32,
    phase: Option<String>,
    slots: Vec<String>,
) -> Option<RecoverReport> {
    let current = crate::hostname::reported_hostname().unwrap_or_else(|| "unknown".to_string());
    if host != current || !pid_is_live(pid) {
        return None;
    }
    Some(RecoverReport {
        path: path.display().to_string(),
        action: RecoverAction::SkippedLive,
        message: format!("pid {pid} on this host still holds this recovery directory"),
        phase,
        slots,
    })
}

fn apply_intent(path: &Path, intent: &Intent, apply: bool, slots: Vec<String>) -> RecoverReport {
    if intent.version < 3 {
        return RecoverReport {
            path: path.display().to_string(),
            action: RecoverAction::Listed,
            message: "legacy INTENT has no durable identity anchors; manual resolution required"
                .to_string(),
            phase: Some(intent_phase_name(intent.phase).to_string()),
            slots,
        };
    }
    let phase_enum = derived_phase(path, intent);
    let phase = super::intent::intent_phase_name(phase_enum).to_string();
    if manual_only(intent.op, phase_enum) {
        return RecoverReport {
            path: path.display().to_string(),
            action: RecoverAction::Listed,
            message: MANUAL_RESOLUTION.to_string(),
            phase: Some(phase),
            slots,
        };
    }
    if !apply {
        return RecoverReport {
            path: path.display().to_string(),
            action: RecoverAction::Listed,
            message: format!(
                "{} {}; run `wsmp recover --apply` to {}",
                super::intent::intent_op_name(intent.op),
                phase,
                match phase_enum {
                    IntentPhase::Committed => "dispose leftover slots",
                    _ => "restore missing public names with mv -n",
                }
            ),
            phase: Some(phase),
            slots,
        };
    }
    let result = match phase_enum {
        IntentPhase::Prepared
        | IntentPhase::Captured
        | IntentPhase::Compensating
        | IntentPhase::Capturing => roll_back(path, intent),
        IntentPhase::Publishing if intent.op == IntentOp::Delete => roll_back(path, intent),
        IntentPhase::Committed => roll_forward(path, intent),
        IntentPhase::Publishing => Err(MANUAL_RESOLUTION.to_string()),
    };
    match result {
        Ok(action) => RecoverReport {
            path: path.display().to_string(),
            action,
            message: match action {
                RecoverAction::RolledBack => "restored public names from slots".to_string(),
                RecoverAction::RolledForward => "disposed leftover slots after commit".to_string(),
                RecoverAction::Cleaned => "removed empty recovery directory".to_string(),
                _ => "no changes required".to_string(),
            },
            phase: Some(phase),
            slots: present_slots(path),
        },
        Err(message) => RecoverReport {
            path: path.display().to_string(),
            action: RecoverAction::Listed,
            message,
            phase: Some(phase),
            slots: present_slots(path),
        },
    }
}

fn roll_back(dir: &Path, intent: &Intent) -> Result<RecoverAction, String> {
    let parent = open_dir(dir.parent().ok_or("recovery path has no parent")?)?;
    let name = dir.file_name().ok_or("recovery path has no file name")?;
    let recovery = open_dir(dir)?;
    if intent.version < 3 && !present_slots(dir).is_empty() {
        return Err(
            "legacy INTENT has no durable identity anchors; manual resolution required".to_string(),
        );
    }
    // Undoing a replace never publishes its own temp T (CLI-generated, never
    // acknowledged): T is identified ONLY by the live `published` pin, moved off
    // the public name if a compensation had not captured it yet, and disposed
    // wherever it sits in R. Every other slot is then restored as usual.
    let temp_anchor = match &intent.published {
        Some(published) if intent.op == IntentOp::Replace => published.anchor.as_deref(),
        _ => None,
    };
    if let (Some(published), Some(anchor)) = (&intent.published, temp_anchor)
        && fstatat(recovery.as_fd(), anchor, AtFlags::AT_SYMLINK_NOFOLLOW).is_ok()
    {
        let pin = anchored_identity(&recovery, published)?;
        if let Some(origin) = intent.source.to_path() {
            remove_public_temp(&recovery, &origin, &pin)?;
        }
        let mut names: Vec<&str> = intent.slots.keys().map(String::as_str).collect();
        names.extend(["tmp", "probe", PUBLISHED_LEFTOVER]);
        for slot_name in names {
            dispose_if_temp(&recovery, slot_name, &pin)?;
        }
        sync_directory(&recovery)?;
    }
    for (slot_name, slot) in &intent.slots {
        if temp_anchor.is_some() && slot.anchor.as_deref() == temp_anchor {
            continue; // the temp's own record: disposed above, never restored
        }
        let origin = slot
            .origin
            .to_path()
            .ok_or_else(|| format!("{slot_name} origin path is not recoverable"))?;
        restore_slot(&recovery, slot_name, slot, &origin)?;
    }
    sync_directory(&recovery)?;
    remove_anchors(&recovery, intent)?;
    match remove_if_empty(&parent, name, dir)? {
        RecoverAction::Cleaned => Ok(RecoverAction::Cleaned),
        _ => Ok(RecoverAction::RolledBack),
    }
}

/// Private name a rejected public temp is captured to before its disposal.
const PUBLISHED_LEFTOVER: &str = "published-leftover";

/// A rejected replace temp still at the public name (interrupted before its
/// compensation capture) leaves it with the same proof the live protocol uses:
/// no-replace capture into R, identity re-proven there, then unlink.
fn remove_public_temp(
    recovery: &OwnedFd,
    origin: &Path,
    pin: &super::recovery::Held,
) -> Result<(), String> {
    let parent = origin.parent().ok_or("origin has no parent")?;
    let name = origin.file_name().ok_or("origin has no file name")?;
    let public = open_dir(parent)?;
    match fstatat(public.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW) {
        Ok(raw) if pin.matches_for_restore(&Stat::from_raw(&raw)) => {}
        Ok(_) | Err(Errno::ENOENT) => return Ok(()),
        Err(errno) => return Err(format!("stat public temp candidate: {errno}")),
    }
    no_replace(
        public.as_fd(),
        name,
        recovery.as_fd(),
        PUBLISHED_LEFTOVER.as_ref(),
        Primitive::Capture,
    )
    .map_err(|errno| format!("capture rejected temp from its public name: {errno}"))?;
    sync_directory(&public)?;
    sync_directory(recovery)
}

/// Unlink `name` in R only when it is the replace's own temp (pin match).
fn dispose_if_temp(
    recovery: &OwnedFd,
    name: &str,
    pin: &super::recovery::Held,
) -> Result<(), String> {
    match fstatat(recovery.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW) {
        Ok(raw) if pin.matches_for_restore(&Stat::from_raw(&raw)) => {
            // The anchor keeps naming this inode, so the unlink is never the
            // last name (no NFS silly-rename from our open proof).
            unlinkat(recovery.as_fd(), name, UnlinkatFlags::NoRemoveDir)
                .map_err(|errno| format!("dispose rejected temp {name}: {errno}"))
        }
        Ok(_) | Err(Errno::ENOENT) => Ok(()),
        Err(errno) => Err(format!("stat {name}: {errno}")),
    }
}

fn roll_forward(dir: &Path, intent: &Intent) -> Result<RecoverAction, String> {
    let parent = open_dir(dir.parent().ok_or("recovery path has no parent")?)?;
    let name = dir.file_name().ok_or("recovery path has no file name")?;
    let recovery = open_dir(dir)?;
    // Cleanup retries must cross public barriers even if slots are now absent.
    for path in std::iter::once(&intent.source)
        .chain(intent.destination.iter())
        .chain(intent.published.iter().map(|slot| &slot.origin))
    {
        if let Some(path) = path.to_path()
            && let Some(parent) = path.parent()
        {
            sync_directory(&open_dir(parent)?)?;
        }
    }
    if intent.version < 3
        && (!present_slots(dir).is_empty()
            || intent.order == Some(super::intent::IntentOrder::ExchangeFirst))
    {
        return Err(
            "legacy INTENT has no durable identity anchors; manual resolution required".to_string(),
        );
    }
    if intent.op == IntentOp::Rename
        && intent.order == Some(super::intent::IntentOrder::ExchangeFirst)
    {
        dispose_exchange_source_leftover(&recovery, intent)?;
    }
    for (slot_name, slot) in &intent.slots {
        dispose_slot(&recovery, slot_name, slot)?;
    }
    sync_directory(&recovery)?;
    remove_anchors(&recovery, intent)?;
    match remove_if_empty(&parent, name, dir)? {
        RecoverAction::Cleaned => Ok(RecoverAction::Cleaned),
        _ => Ok(RecoverAction::RolledForward),
    }
}

fn restore_slot(
    recovery: &OwnedFd,
    slot_name: &str,
    slot: &IntentSlot,
    origin: &Path,
) -> Result<(), String> {
    let slot_stat = match fstatat(recovery.as_fd(), slot_name, AtFlags::AT_SYMLINK_NOFOLLOW) {
        Ok(raw) => Stat::from_raw(&raw),
        Err(Errno::ENOENT) => {
            // Absence is not durable restoration evidence. A surviving pin
            // requires proof of the public original before evidence removal.
            if slot.anchor.as_deref().is_some_and(|name| {
                fstatat(recovery.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW).is_ok()
            }) {
                let pin = anchored_identity(recovery, slot)?;
                let parent = origin.parent().ok_or("origin has no parent")?;
                let name = origin.file_name().ok_or("origin has no file name")?;
                let dest = open_dir(parent)?;
                let now =
                    fstatat(dest.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW).map_err(|error| {
                        format!("absent {slot_name} has no proven public original: {error}")
                    })?;
                if !pin.matches_for_restore(&Stat::from_raw(&now)) {
                    return Err(format!(
                        "absent {slot_name} public origin differs; retaining evidence"
                    ));
                }
                sync_directory(&dest)?;
            }
            return Ok(());
        }
        Err(errno) => return Err(format!("stat {slot_name}: {errno}")),
    };
    let pin = anchored_identity(recovery, slot)?;
    if !pin.matches_for_restore(&slot_stat) {
        return Err(format!(
            "{slot_name} identity does not match INTENT; leaving it in place"
        ));
    }
    let Some(parent) = origin.parent() else {
        return Err(format!("{slot_name} origin has no parent"));
    };
    let Some(file_name) = origin.file_name() else {
        return Err(format!("{slot_name} origin has no file name"));
    };
    let dest_dir = open_dir(parent)?;
    match no_replace(
        recovery.as_fd(),
        slot_name.as_ref(),
        dest_dir.as_fd(),
        file_name,
        Primitive::Restore,
    ) {
        Ok(()) => {
            sync_directory(&dest_dir)?;
            sync_directory(recovery)
        }
        Err(Errno::ENOENT) => Err(format!(
            "restore {slot_name} became absent; retaining INTENT"
        )),
        Err(Errno::EEXIST) => Err(format!(
            "{slot_name} origin is occupied; retaining slot and INTENT"
        )),
        Err(errno) => Err(format!("restore {slot_name}: {errno}")),
    }
}

fn dispose_slot(recovery: &OwnedFd, slot_name: &str, slot: &IntentSlot) -> Result<(), String> {
    let slot_stat = match fstatat(recovery.as_fd(), slot_name, AtFlags::AT_SYMLINK_NOFOLLOW) {
        Ok(raw) => Stat::from_raw(&raw),
        Err(Errno::ENOENT) => return Ok(()),
        Err(errno) => return Err(format!("stat {slot_name}: {errno}")),
    };
    let pin = anchored_identity(recovery, slot)?;
    if !pin.matches_for_restore(&slot_stat) {
        return Err(format!(
            "{slot_name} identity does not match INTENT; not disposing"
        ));
    }
    drop(pin); // Anchor name itself continues pinning the original inode.
    match unlinkat(recovery.as_fd(), slot_name, UnlinkatFlags::NoRemoveDir) {
        Ok(()) | Err(Errno::ENOENT) => Ok(()),
        Err(Errno::EISDIR) | Err(Errno::ENOTDIR) => {
            match unlinkat(recovery.as_fd(), slot_name, UnlinkatFlags::RemoveDir) {
                Ok(()) | Err(Errno::ENOENT) => Ok(()),
                Err(errno) => Err(format!("rmdir {slot_name}: {errno}")),
            }
        }
        Err(errno) => Err(format!("unlink {slot_name}: {errno}")),
    }
}

fn dispose_exchange_source_leftover(recovery: &OwnedFd, intent: &Intent) -> Result<(), String> {
    let Some(source) = intent.source.to_path() else {
        return Ok(());
    };
    let Some(destination) = intent.destination.as_ref().and_then(|path| path.to_path()) else {
        return Ok(());
    };
    let Some(src_parent) = source.parent() else {
        return Ok(());
    };
    let Some(src_name) = source.file_name() else {
        return Ok(());
    };
    let Some(dst_parent) = destination.parent() else {
        return Ok(());
    };
    let Some(dst_name) = destination.file_name() else {
        return Ok(());
    };
    let src_dir = open_dir(src_parent)?;
    let dst_dir = open_dir(dst_parent)?;
    let dest_stat = match fstatat(dst_dir.as_fd(), dst_name, AtFlags::AT_SYMLINK_NOFOLLOW) {
        Ok(raw) => Stat::from_raw(&raw),
        Err(_) => return Ok(()),
    };
    // After exchange-first commit, `to` holds S. Only then may leftover D under
    // the source name be removed.
    if !intent.published.as_ref().is_some_and(|published| {
        anchored_identity(recovery, published).is_ok_and(|pin| pin.matches_for_restore(&dest_stat))
    }) {
        return Err(
            "exchange destination identity is not proven; retaining source leftover".to_string(),
        );
    }
    let source_slot = intent.slots.get("slot-1");
    let src_stat = match fstatat(src_dir.as_fd(), src_name, AtFlags::AT_SYMLINK_NOFOLLOW) {
        Ok(raw) => Stat::from_raw(&raw),
        Err(Errno::ENOENT) => return Ok(()),
        Err(errno) => return Err(format!("stat leftover source: {errno}")),
    };
    if !source_slot.is_some_and(|slot| {
        anchored_identity(recovery, slot).is_ok_and(|pin| pin.matches_for_restore(&src_stat))
    }) {
        return Err(
            "exchange source leftover identity is not proven; leaving it in place".to_string(),
        );
    }
    let result = match unlinkat(src_dir.as_fd(), src_name, UnlinkatFlags::NoRemoveDir) {
        Ok(()) | Err(Errno::ENOENT) => Ok(()),
        Err(Errno::EISDIR) => match unlinkat(src_dir.as_fd(), src_name, UnlinkatFlags::RemoveDir) {
            Ok(()) | Err(Errno::ENOENT) => Ok(()),
            Err(errno) => Err(format!("rmdir leftover source: {errno}")),
        },
        Err(errno) => Err(format!("unlink leftover source: {errno}")),
    };
    result?;
    sync_directory(&src_dir)
}

/// The private hardlink, not the serialized inode number, prevents reuse. The
/// snapshot only detects damaged metadata/anchors; all candidate comparisons
/// use a currently held descriptor. Directories/unsupported aliases fail closed.
fn anchored_identity(
    recovery: &OwnedFd,
    slot: &IntentSlot,
) -> Result<super::recovery::Held, String> {
    let name = slot
        .anchor
        .as_deref()
        .filter(|name| {
            name.starts_with(".wsmp-pin-")
                && name.len() == 34
                && name[10..].bytes().all(|b| b.is_ascii_alphanumeric())
        })
        .ok_or("durable identity anchor unavailable; manual resolution required")?;
    let raw = fstatat(recovery.as_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW).map_err(|error| {
        format!("identity anchor unavailable: {error}; manual resolution required")
    })?;
    let stat = Stat::from_raw(&raw);
    if !slot.matches(&stat)
        || !matches!(
            stat.kind(),
            super::resolve::Kind::File | super::resolve::Kind::Symlink
        )
    {
        return Err(
            "identity anchor does not match INTENT; retaining ambiguous objects".to_string(),
        );
    }
    let held = super::recovery::Held::open(recovery, name.as_ref(), stat)
        .map_err(|error| error.to_string())?;
    if !held.is_held() {
        return Err("identity anchor cannot be held; retaining ambiguous objects".to_string());
    }
    Ok(held)
}

fn remove_anchors(recovery: &OwnedFd, intent: &Intent) -> Result<(), String> {
    sync_directory(recovery)?;
    let known: HashSet<&str> = intent
        .slots
        .values()
        .chain(intent.published.iter())
        .filter_map(|slot| slot.anchor.as_deref())
        .collect();
    let copy = nix::unistd::dup(recovery.as_fd()).map_err(|error| error.to_string())?;
    let mut entries = nix::dir::Dir::from_fd(copy).map_err(|error| error.to_string())?;
    for entry in entries.iter() {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_bytes();
        if !matches!(
            name,
            b"." | b".." | b"INTENT" | b"INTENT.new" | b".wsmp-lock"
        ) && !std::str::from_utf8(name).is_ok_and(|name| known.contains(name))
        {
            return Err(
                "unresolved recovery entries remain; retaining identity anchors".to_string(),
            );
        }
    }
    let mut names = HashSet::new();
    let mut held = Vec::new();
    for slot in intent.slots.values().chain(intent.published.iter()) {
        if let Some(name) = &slot.anchor {
            if !names.insert(name.clone()) {
                continue;
            }
            match anchored_identity(recovery, slot) {
                Ok(pin) => held.push(pin),
                Err(error)
                    if fstatat(
                        recovery.as_fd(),
                        name.as_str(),
                        AtFlags::AT_SYMLINK_NOFOLLOW,
                    ) == Err(Errno::ENOENT) =>
                {
                    let _ = error;
                    names.remove(name);
                }
                Err(error) => return Err(error),
            }
        }
    }
    // No candidate remains. Close our proof handles before unlinking the final
    // anchor names, so our own descriptors cannot make NFS sillyrename them.
    drop(held);
    for name in names {
        unlinkat(recovery.as_fd(), name.as_str(), UnlinkatFlags::NoRemoveDir)
            .map_err(|error| format!("remove identity anchor: {error}"))?;
    }
    sync_directory(recovery)
}

fn remove_if_empty(
    parent: &OwnedFd,
    name: &std::ffi::OsStr,
    dir: &Path,
) -> Result<RecoverAction, String> {
    // A failed/occupied restore or a foreign entry must keep its crash map and
    // lock. Hidden foreign entries (including NFS silly-renames) count too.
    for entry in fs::read_dir(dir).map_err(|err| format!("read recovery: {err}"))? {
        let name = entry
            .map_err(|err| format!("read recovery entry: {err}"))?
            .file_name();
        if name != "INTENT" && name != "INTENT.new" && name != ".wsmp-lock" {
            return Err(
                "unresolved recovery entries remain; retaining INTENT and lock".to_string(),
            );
        }
    }
    let intent = read_intent_file(dir)?.ok_or("INTENT disappeared before cleanup")?;
    let recovery = open_dir(dir)?;
    sync_directory(&recovery)?;
    let _ = fs::remove_file(dir.join("INTENT.new"));
    let _ = fs::remove_file(dir.join("INTENT"));
    let _ = fs::remove_file(dir.join(".wsmp-lock"));
    sync_directory(&recovery)?;
    match unlinkat(parent.as_fd(), name, UnlinkatFlags::RemoveDir) {
        Ok(()) => {
            sync_directory(parent)?;
            Ok(RecoverAction::Cleaned)
        }
        Err(errno) => {
            // An entry can arrive after the emptiness check. Restore durable
            // metadata when rmdir refuses instead of making recovery inert.
            let bytes =
                serde_json::to_vec(&intent).map_err(|err| format!("restore INTENT: {err}"))?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(nix::libc::O_NOFOLLOW)
                .open(dir.join("INTENT"))
                .map_err(|err| format!("restore INTENT after rmdir {errno}: {err}"))?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|err| format!("sync restored INTENT: {err}"))?;
            let _ = OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .mode(0o600)
                .custom_flags(nix::libc::O_NOFOLLOW)
                .open(dir.join(".wsmp-lock"));
            fs::File::open(dir)
                .and_then(|directory| directory.sync_all())
                .map_err(|err| format!("sync recovery directory: {err}"))?;
            Err(format!("rmdir recovery: {errno}; INTENT retained"))
        }
    }
}

fn sync_directory(dir: &OwnedFd) -> Result<(), String> {
    nix::unistd::fsync(dir.as_fd())
        .map_err(|error| format!("directory sync: {error}; durability is not proven"))
}

fn read_intent_file(dir: &Path) -> Result<Option<Intent>, String> {
    let path = dir.join("INTENT");
    let mut options = std::fs::OpenOptions::new();
    options.read(true).custom_flags(nix::libc::O_NOFOLLOW);
    let file = match options.open(&path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("open INTENT: {err}")),
    };
    let mut buf = Vec::new();
    file.take(INTENT_MAX_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|err| format!("read INTENT: {err}"))?;
    if buf.len() > INTENT_MAX_BYTES {
        return Err("INTENT is larger than 64 KiB".to_string());
    }
    parse_intent(&buf).map(Some)
}

pub fn present_slots(dir: &Path) -> Vec<String> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name != "INTENT" && name != "INTENT.new" && !name.starts_with('.'))
        .collect();
    names.sort();
    names
}

fn open_dir(path: &Path) -> Result<OwnedFd, String> {
    open(
        path,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(|errno| format!("open {}: {errno}", path.display()))
}

fn pid_is_live(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    if pid == std::process::id() {
        return true;
    }
    let Ok(raw) = i32::try_from(pid) else {
        return false;
    };
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(raw), None) {
        Ok(()) => true,
        Err(Errno::ESRCH) => false,
        Err(_) => true,
    }
}

fn collect_recovery(
    dir: &Path,
    reported: &mut usize,
    visited: &mut usize,
    found: &mut Vec<PathBuf>,
) {
    if *reported >= SCAN_REPORT_MAX || *visited >= SCAN_VISIT_MAX {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries {
        if *reported >= SCAN_REPORT_MAX || *visited >= SCAN_VISIT_MAX {
            break;
        }
        let Ok(entry) = entry else { continue };
        *visited += 1;
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_file()
            && let Some(name) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_prefix(".wsmp-lock-").map(str::to_owned))
            && is_recovery_name(std::ffi::OsStr::new(&name))
        {
            let recovery = dir.join(name);
            if !recovery.exists() {
                found.push(recovery);
                *reported += 1;
            }
        }
        if !file_type.is_dir() {
            continue;
        }
        if is_recovery_name(&entry.file_name()) {
            found.push(entry.path());
            *reported += 1;
            continue;
        }
        collect_recovery(&entry.path(), reported, visited, found);
    }
}

pub fn is_recovery_name(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy();
    let Some(suffix) = name.strip_prefix(".wsmp-recover-") else {
        return false;
    };
    suffix.len() == 10 && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// Startup / human log: describe an abandoned R without claiming INTENT exists.
#[cfg(test)]
pub fn describe_abandoned(path: &Path) -> String {
    if !path.is_dir() {
        return "registry entry only, recovery directory already gone; run `wsmp recover` to drop the entry".to_string();
    }
    let slots = present_slots(path);
    let intent_present = path.join("INTENT").is_file();
    match (intent_present, slots.is_empty()) {
        (true, false) => format!(
            "abandoned .wsmp-recover directory; INTENT present, slots: {}; restore with `wsmp recover --apply`; it will not be deleted",
            slots.join(", ")
        ),
        (true, true) => {
            "abandoned .wsmp-recover directory; INTENT present, no slots; run `wsmp recover --apply`; it will not be deleted"
                .to_string()
        }
        (false, false) => format!(
            "abandoned .wsmp-recover directory; INTENT absent, present slots: {}; inspect before deleting; it will not be deleted",
            slots.join(", ")
        ),
        (false, true) => {
            "abandoned .wsmp-recover directory; INTENT absent and no slots; it will not be deleted"
                .to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_ops::intent::{Intent, IntentOrder, IntentPhase};
    use crate::file_ops::registry;
    use crate::file_ops::tests::Fx;

    fn anchor_fixture(dir: &Path, slot: &mut IntentSlot, actual: &Path, index: usize) {
        let name = format!(".wsmp-pin-{index:024}");
        fs::hard_link(actual, dir.join(&name)).expect("real durable anchor");
        *slot = slot.clone().with_stat(&Stat::from_metadata(
            &fs::symlink_metadata(actual).expect("stat"),
        ));
        slot.anchor = Some(name);
        File::open(dir)
            .expect("directory")
            .sync_all()
            .expect("sync anchor");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn legacy_matching_snapshots_never_authorize_disposal() {
        for slot_mode in [false, true] {
            let fx = Fx::new();
            let dir = fx.root.join(".wsmp-recover-ABCDEFGHIJ");
            fs::create_dir(&dir).unwrap();
            let slot = dir.join("slot-1");
            fs::write(&slot, b"ONLY ORIGINAL").unwrap();
            let temp = if slot_mode {
                slot.clone()
            } else {
                dir.join("tmp")
            };
            if !slot_mode {
                fs::write(&temp, b"unpublished temporary").unwrap();
            }
            let old = Stat::from_metadata(&fs::symlink_metadata(&temp).unwrap());
            let original = Stat::from_metadata(&fs::symlink_metadata(&slot).unwrap());
            let target = fx.root.join("target");
            let mut intent = if slot_mode {
                Intent::delete(&target)
            } else {
                Intent::replace(&target)
            };
            intent.version = 2;
            intent.pid = 0;
            intent.phase = if slot_mode {
                IntentPhase::Committed
            } else {
                IntentPhase::Captured
            };
            intent.published = Some(IntentSlot::planned(&target).with_stat(&old));
            intent.slots.insert(
                "slot-1".to_string(),
                IntentSlot::planned(&target).with_stat(&original),
            );
            fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
            fs::remove_file(&temp).unwrap();
            let successor = if slot_mode { &slot } else { &target };
            let mut reused = false;
            for _ in 0..10_000 {
                fs::write(successor, b"STRANGER").unwrap();
                let now = Stat::from_metadata(&fs::symlink_metadata(successor).unwrap());
                if old.same_object(&now) {
                    reused = true;
                    break;
                }
                fs::remove_file(successor).unwrap();
            }
            if !reused {
                // Allocation policies differ between filesystems and runs. The
                // deterministic contract is that even matching legacy metadata
                // confers no destructive authority. Force that predicate, not a
                // fake claim that the kernel recycled this particular inode.
                fs::write(successor, b"STRANGER").unwrap();
                let now = Stat::from_metadata(&fs::symlink_metadata(successor).unwrap());
                if slot_mode {
                    intent.slots.insert(
                        "slot-1".to_string(),
                        IntentSlot::planned(&target).with_stat(&now),
                    );
                } else {
                    intent.published = Some(IntentSlot::planned(&target).with_stat(&now));
                }
                fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
            }
            crate::output::diagnostic(format!(
                "legacy snapshot boundary slot={slot_mode}: actual kernel inode reuse={reused}"
            ))
            .expect("fixture diagnostic");
            let report = recover_dir(&dir, true, None);
            assert_eq!(report.action, RecoverAction::Listed, "{report:?}");
            assert_eq!(fs::read(successor).unwrap(), b"STRANGER");
            if !slot_mode {
                assert_eq!(fs::read(&slot).unwrap(), b"ONLY ORIGINAL");
            }
            assert!(dir.join("INTENT").is_file());
            if slot_mode {
                assert!(!target.exists(), "committed delete must not resurrect");
            }
        }
    }

    #[test]
    fn durable_anchor_preserves_strangers_and_missing_anchors_fail_closed() {
        for committed in [false, true] {
            let fx = Fx::new();
            let dir = fx.root.join(".wsmp-recover-ABCDEFGHIJ");
            fs::create_dir(&dir).unwrap();
            let slot = dir.join("slot-1");
            fs::write(&slot, b"original").unwrap();
            let mut intent = Intent::delete(&fx.root.join("target"));
            intent.pid = 0;
            intent.phase = if committed {
                IntentPhase::Committed
            } else {
                IntentPhase::Captured
            };
            anchor_fixture(&dir, intent.slots.get_mut("slot-1").unwrap(), &slot, 1);
            fs::remove_file(&slot).unwrap();
            fs::write(&slot, b"STRANGER").unwrap();
            fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
            assert_eq!(recover_dir(&dir, true, None).action, RecoverAction::Listed);
            assert_eq!(fs::read(&slot).unwrap(), b"STRANGER");
            assert_eq!(
                fs::read(dir.join(intent.slots["slot-1"].anchor.as_ref().unwrap())).unwrap(),
                b"original"
            );
            fs::remove_file(dir.join(intent.slots["slot-1"].anchor.as_ref().unwrap())).unwrap();
            assert_eq!(recover_dir(&dir, true, None).action, RecoverAction::Listed);
            assert_eq!(fs::read(&slot).unwrap(), b"STRANGER");
            assert!(!fx.root.join("target").exists());
        }
    }

    #[test]
    fn unanchored_directory_recovery_is_explicitly_non_destructive() {
        let fx = Fx::new();
        let dir = fx.root.join(".wsmp-recover-ABCDEFGHIJ");
        fs::create_dir(&dir).unwrap();
        fs::create_dir(dir.join("slot-1")).unwrap();
        fs::write(dir.join("slot-1/content"), b"keep").unwrap();
        let mut intent = abandoned_intent(&fx, "source", "target", false);
        intent.phase = IntentPhase::Captured;
        fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
        let report = recover_dir(&dir, true, None);
        assert_eq!(report.action, RecoverAction::Listed);
        assert!(report.message.contains("manual resolution"));
        assert_eq!(fs::read(dir.join("slot-1/content")).unwrap(), b"keep");
        assert!(!fx.root.join("source").exists());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn actual_replace_producer_child_helper() {
        let Some(root) = std::env::var_os("WSMP_RECOVERY_PRODUCER_FIXTURE") else {
            return;
        };
        use crate::file_ops::exchange::{FaultScope, Primitive};
        use crate::file_ops::{Cancel, EtagKey, FileOps, Policy, Step};
        let root = PathBuf::from(root);
        let target = root.join("target");
        fs::write(&target, b"ONLY ORIGINAL").unwrap();
        let _registry = registry::install_temp_registry();
        let mut ops = FileOps::new(
            Policy::new(vec![], vec![], true),
            EtagKey::from_bytes([7; 32]),
        );
        let cancel = Cancel::new();
        let info = ops
            .execute(
                "stat",
                serde_json::json!({"paths":[target],"hash":true}),
                &cancel,
            )
            .unwrap();
        let etag = info["entries"][0]["etag"].as_str().unwrap().to_string();
        let abort = std::env::var_os("WSMP_RECOVERY_PRODUCER_ABORT").is_some();
        let public = target.clone();
        ops = ops.with_step_hook(std::sync::Arc::new(move |step| {
            if abort && step == Step::Publishing {
                fs::write(&public, b"STRANGER").unwrap();
            }
            if !abort && step == Step::Exchanged {
                std::process::exit(0);
            }
            Ok(())
        }));
        let _scope = if abort {
            Some(FaultScope::new(&[(Primitive::Exchange, 1, Errno::EINVAL)]))
        } else {
            None
        };
        let result = ops.execute("write", serde_json::json!({"path":target,"content":"published new bytes","ifExists":"replace","expectedEtag":etag}), &cancel);
        assert!(result.is_err(), "occupied restore must retain the original");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn actual_aborted_and_published_replacements_recover_with_durable_pins() {
        for abort in [true, false] {
            let root = tempfile::tempdir().unwrap();
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child
                .args([
                    "--exact",
                    "file_ops::recover::tests::actual_replace_producer_child_helper",
                    "--nocapture",
                ])
                .env("WSMP_RECOVERY_PRODUCER_FIXTURE", root.path());
            if abort {
                child.env("WSMP_RECOVERY_PRODUCER_ABORT", "1");
            }
            assert!(child.status().unwrap().success(), "actual producer child");
            let dir = scan_recovery_dirs(&[root.path().to_path_buf()])
                .pop()
                .expect("producer's real recovery directory");
            let mut intent = read_intent_file(&dir).unwrap().unwrap();
            assert_eq!(intent.version, 3);
            assert!(intent.published.as_ref().unwrap().anchor.is_some());
            let public = root.path().join("target");
            if abort {
                assert_eq!(fs::read(&public).unwrap(), b"STRANGER");
                assert!(
                    !dir.join("tmp").exists() && !dir.join("probe").exists(),
                    "abort_published disposed generated temporary"
                );
                let original_slot = present_slots(&dir)
                    .into_iter()
                    .find(|name| {
                        fs::read(dir.join(name)).is_ok_and(|bytes| bytes == b"ONLY ORIGINAL")
                    })
                    .expect("actual producer captured the sole original");
                let report = recover_dir(&dir, true, None);
                assert_eq!(report.action, RecoverAction::Listed, "{report:?}");
                assert_eq!(report.phase.as_deref(), Some("compensating"));
                assert_eq!(fs::read(dir.join(original_slot)).unwrap(), b"ONLY ORIGINAL");
                assert_eq!(fs::read(&public).unwrap(), b"STRANGER");
            } else {
                assert_eq!(fs::read(&public).unwrap(), b"published new bytes");
                // Model loss of the phase update separately: publication itself
                // was executed by the real producer, not inferred from metadata.
                intent.phase = IntentPhase::Captured;
                fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
                let report = recover_dir(&dir, true, None);
                assert_eq!(report.action, RecoverAction::Cleaned, "{report:?}");
                assert_eq!(report.phase.as_deref(), Some("committed"));
                assert_eq!(fs::read(&public).unwrap(), b"published new bytes");
                assert!(!dir.exists());
            }
        }
    }

    #[test]
    fn empty_residue_cleanup_is_excluded_and_never_removes_foreign_bytes() {
        let root = tempfile::tempdir().expect("root");
        let dir = root.path().join(".wsmp-recover-ABCDEFGHIJ");
        fs::create_dir(&dir).expect("dir");
        let lock = super::super::recovery::lock_cleanup(&dir, false).expect("lock");
        assert_eq!(
            recover_dir(&dir, true, None).action,
            RecoverAction::SkippedLive
        );
        assert!(dir.exists());
        drop(lock);
        fs::write(dir.join("stranger"), b"retain").expect("stranger");
        assert_eq!(recover_dir(&dir, true, None).action, RecoverAction::Listed);
        assert_eq!(fs::read(dir.join("stranger")).expect("read"), b"retain");
        fs::remove_file(dir.join("stranger")).expect("remove fixture");
        assert_eq!(recover_dir(&dir, false, None).action, RecoverAction::Listed);
        assert!(dir.exists());
        assert_eq!(recover_dir(&dir, true, None).action, RecoverAction::Cleaned);
        assert!(!dir.exists());
        assert!(!super::super::recovery::cleanup_lock_path(&dir).exists());
    }

    #[test]
    fn cleanup_lock_foreign_content_and_symlink_are_never_consumed() {
        let root = tempfile::tempdir().expect("root");
        let dir = root.path().join(".wsmp-recover-ABCDEFGHIJ");
        fs::create_dir(&dir).expect("dir");
        let lock_path = super::super::recovery::cleanup_lock_path(&dir);
        fs::write(&lock_path, b"stranger-lock").expect("lock");
        assert_eq!(
            recover_dir(&dir, true, None).action,
            RecoverAction::SkippedLive
        );
        assert_eq!(
            fs::read(&lock_path).expect("lock retained"),
            b"stranger-lock"
        );
        fs::remove_file(&lock_path).expect("remove fixture");
        let target = root.path().join("target");
        fs::write(&target, b"target").expect("target");
        std::os::unix::fs::symlink(&target, &lock_path).expect("symlink");
        assert_eq!(
            recover_dir(&dir, true, None).action,
            RecoverAction::SkippedLive
        );
        assert_eq!(fs::read(&target).expect("target retained"), b"target");
        assert!(lock_path.is_symlink());
    }

    #[test]
    fn orphan_cleanup_lock_is_bounded_explicit_and_dry_run_safe() {
        let root = tempfile::tempdir().expect("root");
        let dir = root.path().join(".wsmp-recover-ABCDEFGHIJ");
        let lock_path = super::super::recovery::cleanup_lock_path(&dir);
        let lock = super::super::recovery::lock_cleanup(&dir, false).expect("lock");
        drop(lock);
        assert_eq!(recover_scan(&[root.path().to_path_buf()], false).len(), 1);
        assert!(lock_path.exists());
        assert_eq!(recover_scan(&[root.path().to_path_buf()], true).len(), 1);
        assert!(!lock_path.exists());
        fs::write(&lock_path, b"foreign").expect("foreign");
        assert_eq!(
            recover_scan(&[root.path().to_path_buf()], true)[0].action,
            RecoverAction::Listed
        );
        assert_eq!(fs::read(&lock_path).expect("retained"), b"foreign");
    }

    fn abandoned_intent(fx: &Fx, from: &str, to: &str, overwrite: bool) -> Intent {
        let mut intent = Intent::rename(
            IntentOrder::VacateFirst,
            &fx.root.join(from),
            &fx.root.join(to),
            overwrite,
        );
        intent.pid = 0;
        intent
    }

    #[test]
    fn recover_lists_absent_intent_slots_without_claiming_to_read_it() {
        let fx = Fx::new();
        let dir = fx.root.join(".wsmp-recover-abcdefghij");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("slot-1"), "kept").unwrap();
        let report = recover_dir(&dir, false, None);
        assert_eq!(report.action, RecoverAction::Listed);
        assert!(report.message.contains("INTENT is absent"));
        assert!(!report.message.contains("read INTENT"));
        assert_eq!(report.slots, vec!["slot-1".to_string()]);
        assert!(dir.join("slot-1").is_file());
    }

    #[test]
    fn recover_rolls_back_a_captured_rename() {
        let fx = Fx::new();
        let dir = fx.root.join(".wsmp-recover-abcdefghij");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("slot-1"), "source bytes").unwrap();
        let mut intent = abandoned_intent(&fx, "src", "dst", false);
        anchor_fixture(
            &dir,
            intent.slots.get_mut("slot-1").unwrap(),
            &dir.join("slot-1"),
            1,
        );
        std::fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
        registry::register(&dir, &intent).unwrap();
        let report = recover_dir(&dir, true, None);
        assert!(
            matches!(
                report.action,
                RecoverAction::RolledBack | RecoverAction::Cleaned
            ),
            "{report:?}"
        );
        assert_eq!(fx.get("src"), "source bytes");
        assert!(!dir.is_dir());
    }

    #[test]
    fn recover_rolls_forward_committed_exchange_leftover() {
        let fx = Fx::new();
        fx.put("src", "destination leftover");
        fx.put("dst", "source bytes");
        let dir = fx.root.join(".wsmp-recover-abcdefghij");
        std::fs::create_dir(&dir).unwrap();
        let mut intent = Intent::rename(
            IntentOrder::ExchangeFirst,
            &fx.root.join("src"),
            &fx.root.join("dst"),
            true,
        );
        intent.phase = IntentPhase::Committed;
        intent.pid = 0;
        let source_stat = Stat::from_metadata(&fs::symlink_metadata(fx.root.join("src")).unwrap());
        intent.slots.insert(
            "slot-1".to_string(),
            IntentSlot::planned(&fx.root.join("dst")).with_stat(&source_stat),
        );
        let published_stat =
            Stat::from_metadata(&fs::symlink_metadata(fx.root.join("dst")).unwrap());
        intent.published =
            Some(IntentSlot::planned(&fx.root.join("dst")).with_stat(&published_stat));
        anchor_fixture(
            &dir,
            intent.slots.get_mut("slot-1").unwrap(),
            &fx.root.join("src"),
            1,
        );
        anchor_fixture(
            &dir,
            intent.published.as_mut().unwrap(),
            &fx.root.join("dst"),
            2,
        );
        std::fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
        let report = recover_dir(&dir, true, None);
        assert!(
            matches!(
                report.action,
                RecoverAction::RolledForward | RecoverAction::Cleaned
            ),
            "{report:?}"
        );
        assert_eq!(fx.get("dst"), "source bytes");
        assert!(std::fs::symlink_metadata(fx.root.join("src")).is_err());
        assert!(!dir.is_dir());
    }

    #[test]
    fn recover_skips_a_live_pid_on_this_host() {
        let fx = Fx::new();
        let dir = fx.root.join(".wsmp-recover-abcdefghij");
        std::fs::create_dir(&dir).unwrap();
        let intent = Intent::delete(&fx.root.join("gone"));
        std::fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
        let entry = registry::RegistryEntry::from_intent(&dir, &intent);
        let report = recover_dir(&dir, true, Some(&entry));
        assert_eq!(report.action, RecoverAction::SkippedLive);
        assert!(dir.is_dir());
    }

    #[test]
    fn recover_scan_skips_a_live_pid_from_intent() {
        let fx = Fx::new();
        let dir = fx.root.join(".wsmp-recover-abcdefghij");
        std::fs::create_dir(&dir).unwrap();
        let intent = Intent::delete(&fx.root.join("gone"));
        std::fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
        let reports = recover_scan(std::slice::from_ref(&fx.root), true);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].action, RecoverAction::SkippedLive);
        assert!(dir.is_dir());
        assert!(dir.join("INTENT").is_file());
    }

    #[test]
    fn recover_scan_finds_unregistered_recovery_dirs() {
        let fx = Fx::new();
        let dir = fx.root.join(".wsmp-recover-abcdefghij");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("slot-1"), "orphan").unwrap();
        let found = scan_recovery_dirs(std::slice::from_ref(&fx.root));
        assert_eq!(found, vec![dir.clone()]);
        let reports = recover_scan(std::slice::from_ref(&fx.root), false);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].action, RecoverAction::Listed);
        assert!(reports[0].message.contains("INTENT is absent"));
    }

    #[test]
    fn recover_skips_a_directory_whose_lock_is_held() {
        let fx = Fx::new();
        let dir = fx.root.join(".wsmp-recover-abcdefghij");
        std::fs::create_dir(&dir).unwrap();
        let mut intent = abandoned_intent(&fx, "src", "dst", false);
        intent.pid = 0;
        std::fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
        std::fs::write(dir.join("slot-1"), "source bytes").unwrap();
        let lock_file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.join(".wsmp-lock"))
            .unwrap();
        let _lock = Flock::lock(lock_file, FlockArg::LockExclusive).expect("lock");
        let report = recover_dir(&dir, true, None);
        assert_eq!(report.action, RecoverAction::SkippedLive);
        assert!(report.message.contains("recovery lock"));
        assert!(dir.is_dir());
        assert!(std::fs::read_to_string(fx.root.join("src")).is_err());
    }

    #[test]
    fn recover_rederives_committed_only_with_published_identity() {
        let fx = Fx::new();
        fx.put("target", "published new bytes");
        let dir = fx.root.join(".wsmp-recover-abcdefghij");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("slot-1"), "captured original").unwrap();
        let slot_stat =
            Stat::from_metadata(&std::fs::symlink_metadata(dir.join("slot-1")).unwrap());
        let mut intent = Intent::replace(&fx.root.join("target"));
        intent.phase = IntentPhase::Captured;
        intent.pid = 0;
        let published = Stat::from_metadata(&fs::symlink_metadata(fx.root.join("target")).unwrap());
        intent.published = Some(IntentSlot::planned(&fx.root.join("target")).with_stat(&published));
        intent.slots.insert(
            "slot-1".to_string(),
            crate::file_ops::intent::IntentSlot::planned(&fx.root.join("target"))
                .with_stat(&slot_stat),
        );
        anchor_fixture(
            &dir,
            intent.slots.get_mut("slot-1").unwrap(),
            &dir.join("slot-1"),
            1,
        );
        anchor_fixture(
            &dir,
            intent.published.as_mut().unwrap(),
            &fx.root.join("target"),
            2,
        );
        std::fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
        let report = recover_dir(&dir, true, None);
        assert!(
            matches!(
                report.action,
                RecoverAction::RolledForward | RecoverAction::Cleaned
            ),
            "{report:?}"
        );
        assert_eq!(fx.get("target"), "published new bytes");
        assert!(!dir.join("slot-1").exists());
    }

    #[test]
    fn describe_abandoned_names_a_gone_directory() {
        let fx = Fx::new();
        let gone = fx.root.join(".wsmp-recover-gone00001");
        let message = describe_abandoned(&gone);
        assert!(message.contains("already gone"), "{message}");
        assert!(message.contains("wsmp recover"), "{message}");
    }

    #[test]
    fn recover_preserves_original_when_precommit_origin_is_reoccupied() {
        for op in [IntentOp::Rename, IntentOp::Create, IntentOp::Replace] {
            let fx = Fx::new();
            let dir = fx.root.join(".wsmp-recover-abcdefghij");
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("slot-1"), "only original").unwrap();
            fx.put("src", "stranger");
            let stat = Stat::from_metadata(&fs::symlink_metadata(dir.join("slot-1")).unwrap());
            let mut intent = abandoned_intent(&fx, "src", "dst", false);
            intent.op = op;
            intent.phase = IntentPhase::Captured;
            intent.slots.insert(
                "slot-1".to_string(),
                IntentSlot::planned(&fx.root.join("src")).with_stat(&stat),
            );
            anchor_fixture(
                &dir,
                intent.slots.get_mut("slot-1").unwrap(),
                &dir.join("slot-1"),
                1,
            );
            fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
            fs::write(dir.join(".wsmp-lock"), "").unwrap();
            registry::register(&dir, &intent).unwrap();
            let report = recover_dir(&dir, true, None);
            assert_eq!(report.action, RecoverAction::Listed, "{report:?}");
            assert_eq!(fx.get("src"), "stranger");
            assert_eq!(
                fs::read_to_string(dir.join("slot-1")).unwrap(),
                "only original"
            );
            assert!(dir.join("INTENT").is_file());
            assert!(dir.join(".wsmp-lock").is_file());
            assert_eq!(registry::list_entries().len(), 1);
        }
    }

    #[test]
    fn committed_delete_never_restores_a_vacant_origin() {
        let fx = Fx::new();
        let dir = fx.root.join(".wsmp-recover-abcdefghij");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("slot-1"), "deleted").unwrap();
        let stat = Stat::from_metadata(&fs::symlink_metadata(dir.join("slot-1")).unwrap());
        let mut intent = Intent::delete(&fx.root.join("src"));
        intent.phase = IntentPhase::Committed;
        intent.pid = 0;
        intent.slots.insert(
            "slot-1".to_string(),
            IntentSlot::planned(&fx.root.join("src")).with_stat(&stat),
        );
        anchor_fixture(
            &dir,
            intent.slots.get_mut("slot-1").unwrap(),
            &dir.join("slot-1"),
            1,
        );
        fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
        let report = recover_dir(&dir, true, None);
        assert_eq!(report.action, RecoverAction::Cleaned);
        assert!(!fx.root.join("src").exists());
    }

    #[test]
    fn committed_link_rename_never_restores_source_alias() {
        let fx = Fx::new();
        let dir = fx.root.join(".wsmp-recover-abcdefghij");
        fs::create_dir(&dir).unwrap();
        fx.put("dst", "published source");
        fs::hard_link(fx.root.join("dst"), dir.join("slot-1")).unwrap();
        let stat = Stat::from_metadata(&fs::symlink_metadata(dir.join("slot-1")).unwrap());
        let mut intent = Intent::rename(
            IntentOrder::LinkFirst,
            &fx.root.join("src"),
            &fx.root.join("dst"),
            false,
        );
        intent.pid = 0;
        intent.phase = IntentPhase::Committed;
        intent.slots.insert(
            "slot-1".to_string(),
            IntentSlot::planned(&fx.root.join("src")).with_stat(&stat),
        );
        anchor_fixture(
            &dir,
            intent.slots.get_mut("slot-1").unwrap(),
            &dir.join("slot-1"),
            1,
        );
        fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
        assert_eq!(recover_dir(&dir, true, None).action, RecoverAction::Cleaned);
        assert!(!fx.root.join("src").exists());
        assert_eq!(fx.get("dst"), "published source");
    }

    #[test]
    fn dry_run_keeps_stale_registry_and_symlink_lock_fails_closed() {
        let fx = Fx::new();
        let dir = fx.root.join(".wsmp-recover-abcdefghij");
        let mut intent = Intent::delete(&fx.root.join("src"));
        intent.pid = 0;
        registry::register(&dir, &intent).unwrap();
        recover_from_registry(false);
        assert_eq!(registry::list_entries().len(), 1);
        fs::create_dir(&dir).unwrap();
        fx.put("foreign", "untouched");
        std::os::unix::fs::symlink(fx.root.join("foreign"), dir.join(".wsmp-lock")).unwrap();
        fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
        let report = recover_dir(&dir, true, None);
        assert_eq!(report.action, RecoverAction::Listed);
        assert!(report.message.contains("open recovery lock"));
        assert_eq!(fx.get("foreign"), "untouched");
    }

    #[test]
    fn committed_delete_cleanup_fault_round_trips_through_recover() {
        use crate::file_ops::exchange::FaultScope;
        use crate::file_ops::tests::args;
        let fx = Fx::new();
        fx.put("src", "acknowledged delete");
        let result = {
            let _fault = FaultScope::new(&[(Primitive::Unlink, 1, Errno::EIO)]);
            fx.ops
                .delete(&args(serde_json::json!({"path": fx.p("src")})), &fx.cancel)
                .unwrap()
        };
        assert!(result.deleted);
        assert!(!result.recovered.is_empty());
        let entry = registry::list_entries().into_iter().next().unwrap();
        let dir = entry.recovery_path();
        let mut intent = read_intent_file(&dir).unwrap().unwrap();
        assert_eq!(intent.phase, IntentPhase::Committed);
        assert!(dir.join(".wsmp-lock").is_file());
        // Emulate the departed owner without altering the actual crash phase.
        intent.pid = 0;
        fs::write(dir.join("INTENT"), serde_json::to_vec(&intent).unwrap()).unwrap();
        assert_eq!(recover_dir(&dir, true, None).action, RecoverAction::Cleaned);
        assert!(!fx.root.join("src").exists());
    }
}
