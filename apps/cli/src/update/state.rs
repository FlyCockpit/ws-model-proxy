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
    /// The binary the service runs.
    pub live_path: PathBuf,
    /// The rollback copy (the binary that was live before).
    pub prev_path: PathBuf,
    /// Where a rollback moves the build that failed.
    pub failed_path: PathBuf,
    pub rollback_after_secs: u32,
    /// Unix seconds: the dead-man rolls back an unconfirmed update after this.
    pub deadline: u64,
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

/// One update at a time on this machine: `<state>/update/lock`, held while an
/// update downloads, verifies and swaps. A lock older than an hour is stale (a
/// process that died holding it).
pub struct UpdateLock {
    path: PathBuf,
}

const LOCK_STALE_SECS: u64 = 60 * 60;

impl UpdateLock {
    pub fn acquire(update_dir: &Path) -> Result<Option<Self>> {
        std::fs::create_dir_all(update_dir)
            .with_context(|| format!("creating `{}`", update_dir.display()))?;
        let path = update_dir.join("lock");
        for _ in 0..2 {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut file) => {
                    use std::io::Write;
                    let _ = writeln!(file, "{}", std::process::id());
                    return Ok(Some(Self { path }));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|meta| meta.modified())
                        .ok()
                        .and_then(|modified| modified.elapsed().ok())
                        .is_some_and(|age| age.as_secs() > LOCK_STALE_SECS);
                    if !stale {
                        return Ok(None);
                    }
                    let _ = std::fs::remove_file(&path);
                }
                Err(error) => {
                    return Err(error).with_context(|| format!("creating `{}`", path.display()));
                }
            }
        }
        Ok(None)
    }
}

impl Drop for UpdateLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
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
