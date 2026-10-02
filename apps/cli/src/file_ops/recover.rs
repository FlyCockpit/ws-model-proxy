//! Idempotent recovery of abandoned `.wsmp-recover-*` directories from INTENT.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
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
    INTENT_MAX_BYTES, Intent, IntentOp, IntentPhase, IntentSlot, intent_phase_name, kind_from_name,
    parse_intent,
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
        if matches!(
            reports.last().map(|report| report.action),
            Some(RecoverAction::RolledBack | RecoverAction::RolledForward | RecoverAction::Cleaned)
        ) {
            registry::unregister(&entry.recovery_path());
        }
        if !entry.recovery_path().is_dir() {
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
    let held_lock = match try_hold_recovery_lock(path) {
        Ok(lock) => lock,
        Err(report) => return report,
    };
    let _held_lock = held_lock;
    match read_intent_file(path) {
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
            apply_intent(path, &intent, apply, slots)
        }
    }
}

fn try_hold_recovery_lock(path: &Path) -> Result<Option<Flock<File>>, RecoverReport> {
    let lock_path = path.join(".wsmp-lock");
    let file = match OpenOptions::new().read(true).write(true).open(&lock_path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
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

fn derived_phase(dir: &Path, intent: &Intent) -> IntentPhase {
    let mut vacant_with_slot = false;
    let mut origin_occupied_other = false;
    for (slot_name, slot) in &intent.slots {
        let slot_present = dir.join(slot_name).symlink_metadata().is_ok();
        if !slot_present {
            continue;
        }
        let Some(origin) = slot.origin.to_path() else {
            continue;
        };
        match std::fs::symlink_metadata(&origin) {
            Err(_) => vacant_with_slot = true,
            Ok(meta) => {
                let stat = Stat::from_metadata(&meta);
                if slot.dev.is_some() && !slot.matches(&stat) {
                    origin_occupied_other = true;
                }
            }
        }
    }
    if origin_occupied_other {
        IntentPhase::Committed
    } else if vacant_with_slot {
        IntentPhase::Captured
    } else {
        intent.phase
    }
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
    let phase_enum = derived_phase(path, intent);
    let phase = super::intent::intent_phase_name(phase_enum).to_string();
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
        IntentPhase::Prepared | IntentPhase::Captured => roll_back(path, intent),
        IntentPhase::Committed => roll_forward(path, intent),
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
    for (slot_name, slot) in &intent.slots {
        let origin = slot
            .origin
            .to_path()
            .ok_or_else(|| format!("{slot_name} origin path is not recoverable"))?;
        restore_slot(&recovery, slot_name, slot, &origin)?;
    }
    match remove_if_empty(&parent, name, dir)? {
        RecoverAction::Cleaned => Ok(RecoverAction::Cleaned),
        _ => Ok(RecoverAction::RolledBack),
    }
}

fn roll_forward(dir: &Path, intent: &Intent) -> Result<RecoverAction, String> {
    let parent = open_dir(dir.parent().ok_or("recovery path has no parent")?)?;
    let name = dir.file_name().ok_or("recovery path has no file name")?;
    let recovery = open_dir(dir)?;
    if intent.op == IntentOp::Rename
        && intent.order == Some(super::intent::IntentOrder::ExchangeFirst)
    {
        dispose_exchange_source_leftover(intent)?;
    }
    for (slot_name, slot) in &intent.slots {
        dispose_slot(&recovery, slot_name, slot)?;
    }
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
        Err(Errno::ENOENT) => return Ok(()),
        Err(errno) => return Err(format!("stat {slot_name}: {errno}")),
    };
    if !slot.matches(&slot_stat) && slot.dev.is_some() {
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
        Ok(()) | Err(Errno::EEXIST) | Err(Errno::ENOENT) => Ok(()),
        Err(errno) => Err(format!("restore {slot_name}: {errno}")),
    }
}

fn dispose_slot(recovery: &OwnedFd, slot_name: &str, slot: &IntentSlot) -> Result<(), String> {
    let slot_stat = match fstatat(recovery.as_fd(), slot_name, AtFlags::AT_SYMLINK_NOFOLLOW) {
        Ok(raw) => Stat::from_raw(&raw),
        Err(Errno::ENOENT) => return Ok(()),
        Err(errno) => return Err(format!("stat {slot_name}: {errno}")),
    };
    if slot.dev.is_some() && !slot.matches(&slot_stat) {
        return Err(format!(
            "{slot_name} identity does not match INTENT; not disposing"
        ));
    }
    let remove_dir = slot.kind.as_deref().and_then(kind_from_name)
        == Some(super::resolve::Kind::Dir)
        || slot_stat.kind() == super::resolve::Kind::Dir;
    if remove_dir {
        return match unlinkat(recovery.as_fd(), slot_name, UnlinkatFlags::RemoveDir) {
            Ok(()) | Err(Errno::ENOENT) => Ok(()),
            Err(errno) => Err(format!("rmdir {slot_name}: {errno}")),
        };
    }
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

fn dispose_exchange_source_leftover(intent: &Intent) -> Result<(), String> {
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
    let source_slot = intent.slots.get("slot-1");
    let src_stat = match fstatat(src_dir.as_fd(), src_name, AtFlags::AT_SYMLINK_NOFOLLOW) {
        Ok(raw) => Stat::from_raw(&raw),
        Err(Errno::ENOENT) => return Ok(()),
        Err(errno) => return Err(format!("stat leftover source: {errno}")),
    };
    if let Some(slot) = source_slot
        && slot.dev.is_some()
        && !slot.matches(&src_stat)
    {
        return Ok(());
    }
    let _ = dest_stat;
    match unlinkat(src_dir.as_fd(), src_name, UnlinkatFlags::NoRemoveDir) {
        Ok(()) | Err(Errno::ENOENT) => Ok(()),
        Err(Errno::EISDIR) => match unlinkat(src_dir.as_fd(), src_name, UnlinkatFlags::RemoveDir) {
            Ok(()) | Err(Errno::ENOENT) => Ok(()),
            Err(errno) => Err(format!("rmdir leftover source: {errno}")),
        },
        Err(errno) => Err(format!("unlink leftover source: {errno}")),
    }
}

fn remove_if_empty(
    parent: &OwnedFd,
    name: &std::ffi::OsStr,
    dir: &Path,
) -> Result<RecoverAction, String> {
    let _ = fs::remove_file(dir.join("INTENT"));
    let _ = fs::remove_file(dir.join(".wsmp-lock"));
    match unlinkat(parent.as_fd(), name, UnlinkatFlags::RemoveDir) {
        Ok(()) => Ok(RecoverAction::Cleaned),
        Err(Errno::ENOTEMPTY) => Ok(RecoverAction::Listed),
        Err(errno) => Err(format!("rmdir recovery: {errno}")),
    }
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
        let intent = abandoned_intent(&fx, "src", "dst", false);
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
    fn recover_rederives_committed_when_origin_holds_a_different_object() {
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
        intent.slots.insert(
            "slot-1".to_string(),
            crate::file_ops::intent::IntentSlot::planned(&fx.root.join("target"))
                .with_stat(&slot_stat),
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
}
