//! `<state>/update/state.json`: the one update in flight (or the last one),
//! shared by the binary that installs it, the new binary that confirms it and
//! the dead-man that rolls it back.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::protocol::frames::{UpdatePhase, UpdateReason};
use crate::protocol::runtime_spec::UpdateStrategy;

pub const STATE_FILE: &str = "state.json";

/// Who asked for the update: the server (`agent.update`, reported back by
/// `updateId`) or a person running `wsmp update` (not reported).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Server,
    Cli,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// The rollback copy and the dead-man are in place; the files are not swapped yet.
    Armed,
    /// The new binary is in place; it has not confirmed yet.
    Swapped,
    Confirmed,
    RolledBack,
    Failed,
}

impl Phase {
    pub fn in_progress(self) -> bool {
        matches!(self, Self::Armed | Self::Swapped)
    }

    /// The moves the sequence allows. A terminal state is only ever replaced
    /// by a new update (a new file), never moved on.
    pub fn can_move_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Armed, Self::Swapped | Self::Failed)
                | (
                    Self::Swapped,
                    Self::Confirmed | Self::RolledBack | Self::Failed
                )
        )
    }

    pub fn wire(self) -> UpdatePhase {
        match self {
            Self::Armed => UpdatePhase::Armed,
            Self::Swapped => UpdatePhase::Swapped,
            Self::Confirmed => UpdatePhase::Confirmed,
            Self::RolledBack => UpdatePhase::RolledBack,
            Self::Failed => UpdatePhase::Failed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub update_id: String,
    pub origin: Origin,
    pub strategy: UpdateStrategy,
    pub from_version: String,
    pub to_version: String,
    /// SHA-256 of the new binary: a build is the update only when its own
    /// bytes match (one version can have several builds). `None` from a
    /// state written before it was recorded: the version decides then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_sha256: Option<String>,
    /// The binary the service runs.
    pub live_path: PathBuf,
    /// The rollback copy (the binary that was live before).
    pub prev_path: PathBuf,
    /// Where a rollback moves the build that failed.
    pub failed_path: PathBuf,
    pub rollback_after_secs: u32,
    /// Unix seconds: the dead-man rolls back an unconfirmed update after this.
    /// The new build moves it to a full window after its own start.
    pub deadline: u64,
    /// Unix seconds: when the armed dead-man's deadline job fires (the first
    /// deadline). Windows' early run, before it, only starts the relay task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadman_at: Option<u64>,
    /// Starts of the new binary while unconfirmed.
    pub attempts: u32,
    pub phase: Phase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<UpdateReason>,
    /// A log tail (rolled back) or why it failed: node text, shown as plain text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The end of a server update was sent to the server.
    #[serde(default)]
    pub reported: bool,
    pub updated_at: String,
}

impl UpdateState {
    /// Move to `next`, refusing a move the sequence does not allow.
    pub fn advance(&mut self, next: Phase) -> Result<()> {
        anyhow::ensure!(
            self.phase.can_move_to(next),
            "update `{}` cannot go from {:?} to {next:?}",
            self.update_id,
            self.phase
        );
        self.phase = next;
        self.updated_at = crate::file_ops::fmt::rfc3339_secs(super::unix_now());
        Ok(())
    }

    /// Fail with `reason`, keeping `detail` within the wire cap.
    pub fn fail(&mut self, reason: UpdateReason, detail: impl Into<String>) -> Result<()> {
        self.advance(Phase::Failed)?;
        self.reason = Some(reason);
        self.detail = Some(super::clip_detail(&detail.into()));
        Ok(())
    }

    /// Whether the build that runs (`version`, and the SHA-256 of its own
    /// binary when it could be read) is this update's new build.
    pub fn is_new_build(&self, version: &str, sha256: Option<&str>) -> bool {
        match (&self.to_sha256, sha256) {
            (Some(expected), Some(actual)) => expected == actual,
            _ => self.to_version == version,
        }
    }

    /// A finished server update the server has not heard the end of.
    pub fn needs_report(&self) -> bool {
        self.origin == Origin::Server
            && !self.reported
            && matches!(
                self.phase,
                Phase::Confirmed | Phase::RolledBack | Phase::Failed
            )
    }
}

pub fn path(update_dir: &Path) -> PathBuf {
    update_dir.join(STATE_FILE)
}

pub fn load(update_dir: &Path) -> Result<Option<UpdateState>> {
    let file = path(update_dir);
    match std::fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .with_context(|| format!("reading the update state `{}`", file.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => {
            Err(error).with_context(|| format!("reading the update state `{}`", file.display()))
        }
    }
}

pub fn save(update_dir: &Path, state: &UpdateState) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(state).context("encoding the update state")?;
    bytes.push(b'\n');
    crate::approvals::write_private_atomic(&path(update_dir), &bytes, "update state", false)
        .map(|_| ())
}

/// One update at a time on this machine, and one writer of its state:
/// `<state>/update/lock`, held while an update downloads, verifies and swaps,
/// and while the new build confirms, the dead-man rolls back or a starting
/// relay looks at the state. It is an OS lock (`flock`, or the file opened
/// unshared on Windows), so the end of the process that holds it frees it.
pub struct UpdateLock {
    #[cfg(unix)]
    _file: nix::fcntl::Flock<std::fs::File>,
    #[cfg(not(unix))]
    _file: std::fs::File,
}

impl UpdateLock {
    /// The lock if it is free now.
    pub fn acquire(update_dir: &Path) -> Result<Option<Self>> {
        std::fs::create_dir_all(update_dir)
            .with_context(|| format!("creating `{}`", update_dir.display()))?;
        let path = update_dir.join("lock");
        Self::try_open(&path).with_context(|| format!("locking `{}`", path.display()))
    }

    /// The lock, waiting up to `wait` for it.
    pub fn wait(update_dir: &Path, wait: std::time::Duration) -> Result<Option<Self>> {
        let until = std::time::Instant::now() + wait;
        loop {
            if let Some(lock) = Self::acquire(update_dir)? {
                return Ok(Some(lock));
            }
            if std::time::Instant::now() >= until {
                return Ok(None);
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    #[cfg(unix)]
    fn try_open(path: &Path) -> Result<Option<Self>> {
        use std::os::unix::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(path)?;
        match nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock) {
            Ok(file) => Ok(Some(Self { _file: file })),
            Err((_, nix::errno::Errno::EWOULDBLOCK)) => Ok(None),
            Err((_, error)) => Err(error.into()),
        }
    }

    #[cfg(not(unix))]
    fn try_open(path: &Path) -> Result<Option<Self>> {
        use std::os::windows::fs::OpenOptionsExt;
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(path)
        {
            Ok(file) => Ok(Some(Self { _file: file })),
            // ERROR_SHARING_VIOLATION
            Err(error) if error.raw_os_error() == Some(32) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
}

#[cfg(test)]
pub(crate) fn sample(dir: &Path, phase: Phase) -> UpdateState {
    UpdateState {
        update_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
        origin: Origin::Server,
        strategy: UpdateStrategy::SelfReplace,
        from_version: "0.4.2".into(),
        to_version: "0.4.3".into(),
        to_sha256: None,
        deadman_at: None,
        live_path: dir.join("wsmp"),
        prev_path: dir.join("wsmp.prev"),
        failed_path: dir.join("wsmp.failed"),
        rollback_after_secs: 90,
        deadline: 0,
        attempts: 0,
        phase,
        reason: None,
        detail: None,
        reported: false,
        updated_at: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sequence_moves_only_forward() {
        use Phase::*;
        let all = [Armed, Swapped, Confirmed, RolledBack, Failed];
        let allowed = [
            (Armed, Swapped),
            (Armed, Failed),
            (Swapped, Confirmed),
            (Swapped, RolledBack),
            (Swapped, Failed),
        ];
        for from in all {
            for to in all {
                assert_eq!(
                    from.can_move_to(to),
                    allowed.contains(&(from, to)),
                    "{from:?} -> {to:?}"
                );
            }
        }
        assert!(Armed.in_progress() && Swapped.in_progress());
        assert!(!Confirmed.in_progress() && !RolledBack.in_progress() && !Failed.in_progress());
    }

    #[test]
    fn transitions_persist_and_refuse_going_back() {
        let dir = tempfile::tempdir().expect("dir");
        let update = dir.path().join("update");
        assert_eq!(load(&update).expect("load"), None);
        let mut state = sample(dir.path(), Phase::Armed);
        save(&update, &state).expect("save");
        state.advance(Phase::Swapped).expect("swap");
        save(&update, &state).expect("save");
        assert_eq!(load(&update).expect("load"), Some(state.clone()));
        assert!(!state.needs_report());
        state.advance(Phase::Confirmed).expect("confirm");
        assert!(state.needs_report());
        assert!(state.advance(Phase::RolledBack).is_err());
        assert!(state.fail(UpdateReason::Internal, "late").is_err());
        state.reported = true;
        assert!(!state.needs_report());
        let mut cli = sample(dir.path(), Phase::Swapped);
        cli.origin = Origin::Cli;
        cli.fail(UpdateReason::Internal, "x".repeat(5000))
            .expect("fail");
        assert!(!cli.needs_report());
        assert!(
            cli.detail
                .as_deref()
                .is_some_and(|d| d.encode_utf16().count() <= 4000)
        );
    }

    #[test]
    fn one_update_holds_the_lock() {
        let dir = tempfile::tempdir().expect("dir");
        let first = UpdateLock::acquire(dir.path()).expect("lock");
        assert!(first.is_some());
        assert!(UpdateLock::acquire(dir.path()).expect("lock").is_none());
        drop(first);
        assert!(UpdateLock::acquire(dir.path()).expect("lock").is_some());
    }
}
