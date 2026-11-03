//! `<state>/update/state.json`: the one update in flight (or the last one),
//! shared by the binary that installs it, the new binary that confirms it and
//! the dead-man that rolls it back.
//!
//! In memory an update's progress is one [`Lifecycle`], moved only by the transition methods of
//! [`UpdateState`]. On disk it stays the flat record every release reads and writes (`phase`,
//! `reported`, and the optional `rollingBack` and `restartPending` marks): [`Wire`] is that
//! record, field for field, so a file this build writes is the file it always wrote, and a file
//! any build wrote (odd combinations of the marks included) loads to one [`Lifecycle`].

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

/// The `phase` of the stored record (and of the progress frames): what a released wsmp reads.
/// [`Lifecycle::phase`] gives it for a lifecycle.
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

/// Where an update is. Every value is a state the sequence can be in: the marks that only mean
/// something in one phase live in that phase's variant.
///
/// ```text
/// Armed ──swap──▶ Swapped ──confirm──▶ Confirmed{reported}
///   │               │  ▲
///   │               │  └─abandon_rollback─┐
///   │               └─begin_rollback──▶ RollingBack ──finish_rollback──▶ RolledBack{restart_pending, reported}
///   └──────fail─────┴──────────────────────────────────────────────────▶ Failed{reported}
/// ```
///
/// A terminal state moves only to mark its report sent (`reported`) or, rolled back, the
/// relay restarted (`restart_pending` cleared). A new update replaces it (a new file).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    /// The rollback copy and the dead-man are in place; the files are not swapped yet.
    Armed,
    /// The new binary is in place; it has not confirmed yet.
    Swapped,
    /// Swapped, and a rollback was decided and may have begun: saved before the restore takes
    /// the rollback copy, so a rollback interrupted after it (a crash, a failed save) is finished
    /// on replay, and no confirmation certifies the build it replaces. Stored as `swapped` with
    /// `rollingBack`, which a released wsmp ignores.
    RollingBack,
    Confirmed {
        /// The server stored how this server update ended (`agent.update.ack`).
        reported: bool,
    },
    RolledBack {
        /// Rolled back by the dead-man, and the relay service has not restarted into the
        /// restored build yet: the dead-man job stays and restarts it on its next run.
        restart_pending: bool,
        /// The server stored how this server update ended.
        reported: bool,
    },
    Failed {
        /// The server stored how this server update ended.
        reported: bool,
    },
}

impl Lifecycle {
    /// The stored and reported phase. A decided rollback is still `swapped` until it is recorded.
    pub fn phase(self) -> Phase {
        match self {
            Self::Armed => Phase::Armed,
            Self::Swapped | Self::RollingBack => Phase::Swapped,
            Self::Confirmed { .. } => Phase::Confirmed,
            Self::RolledBack { .. } => Phase::RolledBack,
            Self::Failed { .. } => Phase::Failed,
        }
    }

    /// Not ended yet: armed, swapped, or a rollback decided and not recorded.
    pub fn in_progress(self) -> bool {
        matches!(self, Self::Armed | Self::Swapped | Self::RollingBack)
    }

    /// Whether a recovery owner (the dead-man) may still have to act: the update is in progress
    /// (a decided rollback included), or the relay still has to be restarted into the restored
    /// build.
    pub fn needs_recovery(self) -> bool {
        self.in_progress()
            || matches!(
                self,
                Self::RolledBack {
                    restart_pending: true,
                    ..
                }
            )
    }

    /// The dead-man rolled the update back and still owes the relay its restart.
    pub fn restart_pending(self) -> bool {
        matches!(
            self,
            Self::RolledBack {
                restart_pending: true,
                ..
            }
        )
    }

    /// For an ended update, whether the server stored its end; `None` while in progress.
    pub fn reported(self) -> Option<bool> {
        match self {
            Self::Confirmed { reported }
            | Self::RolledBack { reported, .. }
            | Self::Failed { reported } => Some(reported),
            Self::Armed | Self::Swapped | Self::RollingBack => None,
        }
    }

    /// The moves the sequence allows (the diagram above).
    pub fn can_move_to(self, next: Self) -> bool {
        use Lifecycle::*;
        match (self, next) {
            (Armed, Swapped | Failed { reported: false })
            | (Swapped, Confirmed { reported: false } | RollingBack | Failed { reported: false })
            | (
                RollingBack,
                Swapped
                | RolledBack {
                    reported: false, ..
                },
            )
            | (Confirmed { reported: false }, Confirmed { reported: true })
            | (Failed { reported: false }, Failed { reported: true }) => true,
            (
                RolledBack {
                    restart_pending: was_pending,
                    reported: was_reported,
                },
                RolledBack {
                    restart_pending,
                    reported,
                },
            ) => {
                // One mark at a time, and each only from set to cleared (reported: to set).
                let restarted = was_pending && !restart_pending && was_reported == reported;
                let acknowledged = !was_reported && reported && was_pending == restart_pending;
                restarted || acknowledged
            }
            _ => false,
        }
    }

    /// The lifecycle a stored record describes. Only combinations this sequence writes come
    /// from a release, but any combination loads, without losing what recovery needs:
    ///
    /// - `rollingBack` on an in-progress phase is a decided rollback ([`Self::RollingBack`]):
    ///   it is finished, never confirmed. (Only `swapped` is ever written with it; an `armed`
    ///   one is finished too, the restore putting back the copy of the binary still live.)
    /// - On an ended phase the recorded end wins, and `rollingBack` is dropped: a rollback is
    ///   never finished over a recorded end (the dead-man settles at an ended phase), and the
    ///   end is what is reported.
    /// - `restartPending` means something only once rolled back; elsewhere it is dropped (no
    ///   dead-man restarts the relay for any other phase).
    /// - `reported` means something only for an ended server update; elsewhere it is dropped
    ///   (nothing is ever reported for those).
    fn from_record(
        phase: Phase,
        origin: Origin,
        rolling_back: bool,
        restart_pending: bool,
        reported: bool,
    ) -> Self {
        let reported = reported && origin == Origin::Server;
        match phase {
            Phase::Armed | Phase::Swapped if rolling_back => Self::RollingBack,
            Phase::Armed => Self::Armed,
            Phase::Swapped => Self::Swapped,
            Phase::Confirmed => Self::Confirmed { reported },
            Phase::RolledBack => Self::RolledBack {
                restart_pending,
                reported,
            },
            Phase::Failed => Self::Failed { reported },
        }
    }
}

impl From<Phase> for Lifecycle {
    /// The lifecycle at `phase`, with no mark set.
    fn from(phase: Phase) -> Self {
        Self::from_record(phase, Origin::Server, false, false, false)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "Wire", into = "Wire")]
pub struct UpdateState {
    pub update_id: String,
    pub origin: Origin,
    pub strategy: UpdateStrategy,
    pub from_version: String,
    pub to_version: String,
    /// SHA-256 of the new binary: a build is the update only when its own
    /// bytes match (one version can have several builds). `None` from a
    /// state written before it was recorded: the version decides then.
    pub to_sha256: Option<String>,
    /// The binary the service runs.
    pub live_path: PathBuf,
    /// The rollback copy (the binary that was live before).
    pub prev_path: PathBuf,
    /// The dead-man's own program: a copy of the rollback copy that no swap or rollback moves
    /// (`.wsmp-recovery-<id>` beside the binary), so the job still has a program to run after
    /// the restore consumed `prev_path` (a retried relay restart, a replay). Kept while
    /// [`Self::needs_recovery`], removed once the job is gone. `None`: no dead-man of this
    /// release was armed (Homebrew, no scheduler), or one of an earlier build was, which runs
    /// `prev_path`. Optional: a released wsmp ignores it.
    pub recovery_path: Option<PathBuf>,
    /// Where a rollback moves the build that failed.
    pub failed_path: PathBuf,
    pub rollback_after_secs: u32,
    /// Unix seconds: the dead-man rolls back an unconfirmed update after this.
    /// The new build moves it to a full window after its own start.
    pub deadline: u64,
    /// Unix seconds: when the armed dead-man's deadline job fires (the first
    /// deadline). Windows' early run, before it, only starts the relay task.
    pub deadman_at: Option<u64>,
    /// Starts of the new binary while unconfirmed.
    pub attempts: u32,
    /// Where the update is. Moved by the transition methods ([`Self::swap`], [`Self::confirm`],
    /// [`Self::fail`], [`Self::begin_rollback`], ...), which refuse a move the sequence does not
    /// allow.
    pub lifecycle: Lifecycle,
    pub reason: Option<UpdateReason>,
    /// A log tail (rolled back) or why it failed: node text, shown as plain text.
    pub detail: Option<String>,
    pub updated_at: String,
}

/// `state.json` as every release writes it: the fields in this order, the lifecycle flat
/// (`phase` and the marks). The rollback marks are optional fields, absent when false, so a
/// file without them is the file a released wsmp wrote; a released wsmp that starts after a
/// rollback reads this file and ignores the fields it does not know (as this build does).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Wire {
    update_id: String,
    origin: Origin,
    strategy: UpdateStrategy,
    from_version: String,
    to_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    to_sha256: Option<String>,
    live_path: PathBuf,
    prev_path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery_path: Option<PathBuf>,
    failed_path: PathBuf,
    rollback_after_secs: u32,
    deadline: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deadman_at: Option<u64>,
    attempts: u32,
    phase: Phase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<UpdateReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    /// The end of a server update was sent to the server.
    #[serde(default)]
    reported: bool,
    /// [`Lifecycle::RollingBack`].
    #[serde(default, skip_serializing_if = "is_false")]
    rolling_back: bool,
    /// [`Lifecycle::RolledBack`]'s `restart_pending`.
    #[serde(default, skip_serializing_if = "is_false")]
    restart_pending: bool,
    updated_at: String,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl From<Wire> for UpdateState {
    fn from(wire: Wire) -> Self {
        Self {
            lifecycle: Lifecycle::from_record(
                wire.phase,
                wire.origin,
                wire.rolling_back,
                wire.restart_pending,
                wire.reported,
            ),
            update_id: wire.update_id,
            origin: wire.origin,
            strategy: wire.strategy,
            from_version: wire.from_version,
            to_version: wire.to_version,
            to_sha256: wire.to_sha256,
            live_path: wire.live_path,
            prev_path: wire.prev_path,
            recovery_path: wire.recovery_path,
            failed_path: wire.failed_path,
            rollback_after_secs: wire.rollback_after_secs,
            deadline: wire.deadline,
            deadman_at: wire.deadman_at,
            attempts: wire.attempts,
            reason: wire.reason,
            detail: wire.detail,
            updated_at: wire.updated_at,
        }
    }
}

impl From<UpdateState> for Wire {
    fn from(state: UpdateState) -> Self {
        let lifecycle = state.lifecycle;
        Self {
            update_id: state.update_id,
            origin: state.origin,
            strategy: state.strategy,
            from_version: state.from_version,
            to_version: state.to_version,
            to_sha256: state.to_sha256,
            live_path: state.live_path,
            prev_path: state.prev_path,
            recovery_path: state.recovery_path,
            failed_path: state.failed_path,
            rollback_after_secs: state.rollback_after_secs,
            deadline: state.deadline,
            deadman_at: state.deadman_at,
            attempts: state.attempts,
            phase: lifecycle.phase(),
            reason: state.reason,
            detail: state.detail,
            reported: lifecycle.reported().unwrap_or(false),
            rolling_back: lifecycle == Lifecycle::RollingBack,
            restart_pending: lifecycle.restart_pending(),
            updated_at: state.updated_at,
        }
    }
}

impl UpdateState {
    /// The stored and reported phase ([`Lifecycle::phase`]).
    pub fn phase(&self) -> Phase {
        self.lifecycle.phase()
    }

    /// [`Lifecycle::in_progress`].
    pub fn in_progress(&self) -> bool {
        self.lifecycle.in_progress()
    }

    /// Whether a recovery owner (the dead-man) may still have to act on this update
    /// ([`Lifecycle::needs_recovery`]). Its recovery copy is kept while this holds.
    pub fn needs_recovery(&self) -> bool {
        self.lifecycle.needs_recovery()
    }

    /// Move to `next`, refusing a move the sequence does not allow. `touch`: the move is a step
    /// of the update (recorded in `updated_at`), not only a mark.
    fn move_to(&mut self, next: Lifecycle, touch: bool) -> Result<()> {
        anyhow::ensure!(
            self.lifecycle.can_move_to(next),
            "update `{}` cannot go from {:?} to {next:?}",
            self.update_id,
            self.lifecycle
        );
        self.lifecycle = next;
        if touch {
            self.updated_at = crate::file_ops::fmt::rfc3339_secs(super::unix_now());
        }
        Ok(())
    }

    /// `armed` to `swapped`: the new binary is in place.
    pub fn swap(&mut self) -> Result<()> {
        self.move_to(Lifecycle::Swapped, true)
    }

    /// `swapped` to `confirmed`.
    pub fn confirm(&mut self) -> Result<()> {
        self.move_to(Lifecycle::Confirmed { reported: false }, true)
    }

    /// Fail with `reason`, keeping `detail` within the wire cap. Only an update in progress
    /// fails, and not one whose rollback was decided ([`Self::abandon_rollback`] first).
    pub fn fail(&mut self, reason: UpdateReason, detail: impl Into<String>) -> Result<()> {
        self.move_to(Lifecycle::Failed { reported: false }, true)?;
        self.reason = Some(reason);
        self.detail = Some(super::clip_detail(&detail.into()));
        Ok(())
    }

    /// `swapped` to [`Lifecycle::RollingBack`]: a rollback is decided. Saved before the
    /// restore begins.
    pub fn begin_rollback(&mut self) -> Result<()> {
        self.move_to(Lifecycle::RollingBack, false)
    }

    /// A decided rollback that restored nothing (there is no copy, and the new build is still
    /// installed) goes back to `swapped`. Nothing happens in any other state.
    pub fn abandon_rollback(&mut self) {
        if self.lifecycle == Lifecycle::RollingBack {
            self.lifecycle = Lifecycle::Swapped;
        }
    }

    /// A decided rollback is done: `rolled_back`. `restart_pending`: the relay still runs the
    /// build that failed, and the dead-man restarts it.
    pub fn finish_rollback(&mut self, restart_pending: bool) -> Result<()> {
        self.move_to(
            Lifecycle::RolledBack {
                restart_pending,
                reported: false,
            },
            true,
        )
    }

    /// The relay restarted into the restored build. True when a restart was pending.
    pub fn restart_done(&mut self) -> bool {
        let Lifecycle::RolledBack {
            restart_pending: true,
            reported,
        } = self.lifecycle
        else {
            return false;
        };
        let next = Lifecycle::RolledBack {
            restart_pending: false,
            reported,
        };
        self.move_to(next, false).is_ok()
    }

    /// The server stored how this update ended. True when that was owed ([`Self::needs_report`]).
    pub fn mark_reported(&mut self) -> bool {
        if !self.needs_report() {
            return false;
        }
        let next = match self.lifecycle {
            Lifecycle::Confirmed { .. } => Lifecycle::Confirmed { reported: true },
            Lifecycle::Failed { .. } => Lifecycle::Failed { reported: true },
            Lifecycle::RolledBack {
                restart_pending, ..
            } => Lifecycle::RolledBack {
                restart_pending,
                reported: true,
            },
            Lifecycle::Armed | Lifecycle::Swapped | Lifecycle::RollingBack => return false,
        };
        self.move_to(next, false).is_ok()
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
        self.origin == Origin::Server && self.lifecycle.reported() == Some(false)
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
        recovery_path: None,
        failed_path: dir.join("wsmp.failed"),
        rollback_after_secs: 90,
        deadline: 0,
        attempts: 0,
        lifecycle: phase.into(),
        reason: None,
        detail: None,
        updated_at: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every lifecycle there is.
    fn all() -> Vec<Lifecycle> {
        use Lifecycle::*;
        let mut all = vec![Armed, Swapped, RollingBack];
        for reported in [false, true] {
            all.push(Confirmed { reported });
            all.push(Failed { reported });
            for restart_pending in [false, true] {
                all.push(RolledBack {
                    restart_pending,
                    reported,
                });
            }
        }
        all
    }

    #[test]
    fn the_sequence_moves_only_forward() {
        use Lifecycle::*;
        let rolled = |restart_pending, reported| RolledBack {
            restart_pending,
            reported,
        };
        let allowed = [
            (Armed, Swapped),
            (Armed, Failed { reported: false }),
            (Swapped, Confirmed { reported: false }),
            (Swapped, RollingBack),
            (Swapped, Failed { reported: false }),
            (RollingBack, Swapped),
            (RollingBack, rolled(false, false)),
            (RollingBack, rolled(true, false)),
            (Confirmed { reported: false }, Confirmed { reported: true }),
            (Failed { reported: false }, Failed { reported: true }),
            (rolled(true, false), rolled(false, false)),
            (rolled(true, true), rolled(false, true)),
            (rolled(false, false), rolled(false, true)),
            (rolled(true, false), rolled(true, true)),
        ];
        for from in all() {
            for to in all() {
                assert_eq!(
                    from.can_move_to(to),
                    allowed.contains(&(from, to)),
                    "{from:?} -> {to:?}"
                );
            }
        }
        for lifecycle in all() {
            assert_eq!(
                lifecycle.in_progress(),
                matches!(lifecycle, Armed | Swapped | RollingBack),
                "{lifecycle:?}"
            );
            assert_eq!(
                lifecycle.phase().in_progress(),
                lifecycle.in_progress(),
                "{lifecycle:?}"
            );
            assert_eq!(lifecycle.reported().is_none(), lifecycle.in_progress());
            assert_eq!(
                lifecycle.needs_recovery(),
                lifecycle.in_progress() || lifecycle.restart_pending(),
                "{lifecycle:?}"
            );
        }
    }

    #[test]
    fn transitions_persist_and_refuse_going_back() {
        let dir = tempfile::tempdir().expect("dir");
        let update = dir.path().join("update");
        assert_eq!(load(&update).expect("load"), None);
        let mut state = sample(dir.path(), Phase::Armed);
        assert!(state.confirm().is_err(), "an armed update swaps first");
        assert!(state.begin_rollback().is_err(), "nothing to roll back yet");
        save(&update, &state).expect("save");
        state.swap().expect("swap");
        save(&update, &state).expect("save");
        assert_eq!(load(&update).expect("load"), Some(state.clone()));
        assert!(!state.needs_report());
        assert!(!state.mark_reported(), "nothing to report yet");
        state.confirm().expect("confirm");
        assert!(state.needs_report());
        assert!(state.begin_rollback().is_err());
        assert!(state.finish_rollback(false).is_err());
        assert!(state.fail(UpdateReason::Internal, "late").is_err());
        assert!(state.mark_reported());
        assert!(!state.needs_report());
        assert!(!state.mark_reported(), "reported once");
        let mut cli = sample(dir.path(), Phase::Swapped);
        cli.origin = Origin::Cli;
        cli.fail(UpdateReason::Internal, "x".repeat(5000))
            .expect("fail");
        assert!(!cli.needs_report());
        assert!(!cli.mark_reported(), "a person's update is never reported");
        assert!(
            cli.detail
                .as_deref()
                .is_some_and(|d| d.encode_utf16().count() <= 4000)
        );
    }

    /// A rollback: decided (a mark, not a step), then recorded or abandoned. A decided rollback
    /// is not failed or confirmed until it is abandoned; the restart it owes is cleared once.
    #[test]
    fn a_rollback_is_decided_then_recorded_or_abandoned() {
        let dir = tempfile::tempdir().expect("dir");
        let mut state = sample(dir.path(), Phase::Swapped);
        state.updated_at = "then".into();
        state.begin_rollback().expect("decide");
        assert_eq!(state.updated_at, "then", "a mark, not a step");
        assert_eq!(state.phase(), Phase::Swapped);
        assert!(state.in_progress() && state.needs_recovery());
        assert!(state.confirm().is_err());
        assert!(state.fail(UpdateReason::Internal, "x").is_err());
        assert!(state.begin_rollback().is_err(), "decided once");
        state.abandon_rollback();
        assert_eq!(state.lifecycle, Lifecycle::Swapped);
        state.abandon_rollback();
        assert_eq!(state.lifecycle, Lifecycle::Swapped, "a no-op elsewhere");
        state.begin_rollback().expect("decide");
        state.finish_rollback(true).expect("record");
        assert_ne!(state.updated_at, "then");
        assert_eq!(state.phase(), Phase::RolledBack);
        assert!(state.needs_recovery() && state.lifecycle.restart_pending());
        assert!(state.mark_reported());
        assert!(state.restart_done());
        assert!(!state.restart_done(), "once");
        assert_eq!(
            state.lifecycle,
            Lifecycle::RolledBack {
                restart_pending: false,
                reported: true
            }
        );
        assert!(!state.needs_recovery());
    }

    /// The rollback marks are optional fields, not phases: absent when false (the file is what a
    /// released wsmp wrote), read back when set, and a reader ignores fields it does not know (as
    /// a released wsmp does with these, after a rollback restores it).
    #[test]
    fn the_rollback_marks_are_optional_fields_old_readers_skip() {
        let dir = tempfile::tempdir().expect("dir");
        let update = dir.path().join("update");
        let mut state = sample(dir.path(), Phase::Swapped);
        save(&update, &state).expect("save");
        let plain: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path(&update)).expect("read")).expect("json");
        assert!(plain.get("rollingBack").is_none() && plain.get("restartPending").is_none());
        state.begin_rollback().expect("decide");
        save(&update, &state).expect("save");
        assert_eq!(load(&update).expect("load"), Some(state.clone()));
        let mut marked: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path(&update)).expect("read")).expect("json");
        assert_eq!(marked["rollingBack"], true);
        assert_eq!(marked["phase"], "swapped");
        assert!(marked.get("restartPending").is_none());
        marked["aFieldFromALaterWsmp"] = serde_json::json!(1);
        let read: UpdateState = serde_json::from_value(marked).expect("unknown fields are ignored");
        assert_eq!(read, state);
        state.finish_rollback(true).expect("record");
        save(&update, &state).expect("save");
        let rolled: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path(&update)).expect("read")).expect("json");
        assert_eq!(rolled["phase"], "rolled_back");
        assert_eq!(rolled["restartPending"], true);
        assert!(rolled.get("rollingBack").is_none());
        assert_eq!(load(&update).expect("load"), Some(state));
    }

    /// `(name, bytes)` of each file in `tests/fixtures/update-state/written.txt`: what the
    /// build before [`Lifecycle`] (the flat `phase` and marks) wrote, byte for byte, for every
    /// state it could reach.
    fn written_before() -> Vec<(String, String)> {
        let text = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/update-state/written.txt"
        ));
        text.split("=== ")
            .filter(|entry| !entry.is_empty())
            .map(|entry| {
                let (name, json) = entry.split_once('\n').expect("a name line");
                (name.to_string(), json.to_string())
            })
            .collect()
    }

    fn encode(state: &UpdateState) -> String {
        let mut bytes = serde_json::to_vec_pretty(state).expect("encode");
        bytes.push(b'\n');
        String::from_utf8(bytes).expect("utf-8")
    }

    /// Every state the sequence reaches is written exactly as before (the fixture's files, which
    /// the flat record wrote), reads back to the same state, and is what that state means.
    #[cfg(unix)]
    #[test]
    fn every_reachable_state_is_written_as_before() {
        use Lifecycle::*;
        let files = written_before();
        assert_eq!(files.len(), 23);
        let mut seen = std::collections::BTreeSet::new();
        for (name, json) in &files {
            let state: UpdateState = serde_json::from_str(json).expect(name);
            assert_eq!(&encode(&state), json, "{name}: the same bytes");
            let again: UpdateState = serde_json::from_str(&encode(&state)).expect(name);
            assert_eq!(again, state, "{name}");
            let server = state.origin == Origin::Server;
            let expected = match name.split_once('-').map_or("", |(_, rest)| rest) {
                "armed-plain" | "armed-full" => Armed,
                "swapped-plain" | "swapped-full" | "swapped" => Swapped,
                "rolling-back" => RollingBack,
                "confirmed-false" => Confirmed { reported: false },
                "confirmed-true" => Confirmed { reported: true },
                "failed-false" => Failed { reported: false },
                "failed-true" => Failed { reported: true },
                rolled => {
                    let marks = rolled
                        .strip_prefix("rolledback-")
                        .unwrap_or_else(|| panic!("{name}"));
                    RolledBack {
                        reported: marks.starts_with("true"),
                        restart_pending: marks.ends_with("true"),
                    }
                }
            };
            assert_eq!(state.lifecycle, expected, "{name}");
            assert_eq!(
                state.needs_report(),
                server && expected.reported() == Some(false)
            );
            seen.insert(format!("{:?}/{:?}", state.origin, state.lifecycle));
        }
        // Every lifecycle, for each origin (a person's update is never reported).
        for lifecycle in all() {
            for origin in [Origin::Server, Origin::Cli] {
                if origin == Origin::Cli && lifecycle.reported() == Some(true) {
                    continue;
                }
                assert!(
                    seen.contains(&format!("{origin:?}/{lifecycle:?}")),
                    "{origin:?} {lifecycle:?} is covered"
                );
            }
        }
        // Built here (not read), each state writes its file too.
        let dir = Path::new("/d");
        let mut built = sample(dir, Phase::Swapped);
        built.to_sha256 = Some("ab".repeat(32));
        built.recovery_path = Some(dir.join(".wsmp-recovery-AAAAAAAAAAAAAAAAAAAAAA"));
        built.deadman_at = Some(1_800_000_090);
        built.deadline = 1_800_000_090;
        built.attempts = 2;
        built.updated_at = "2026-11-03T00:00:00Z".into();
        built.lifecycle = RolledBack {
            restart_pending: true,
            reported: true,
        };
        built.detail = Some("log tail".into());
        let file = |name: &str| {
            files
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, json)| json.clone())
                .expect(name)
        };
        assert_eq!(encode(&built), file("Server-rolledback-true-true"));
        built.lifecycle = RollingBack;
        built.detail = None;
        assert_eq!(encode(&built), file("Server-rolling-back"));
    }

    /// A file wsmp 0.4.3 wrote (no `recoveryPath`, no rollback marks: it had none) loads, in
    /// every phase, and is written back the same.
    #[cfg(unix)]
    #[test]
    fn every_file_a_0_4_3_wsmp_wrote_loads_and_is_written_the_same() {
        let mut phases = std::collections::BTreeSet::new();
        for (name, json) in written_before() {
            if json.contains("\"rollingBack\"") {
                continue;
            }
            // The same file without the fields 0.4.3 did not have (each on a line of its own,
            // never the last), in the order it wrote them.
            let released: String = json
                .lines()
                .filter(|line| {
                    !line.starts_with("  \"recoveryPath\"")
                        && !line.starts_with("  \"restartPending\"")
                })
                .flat_map(|line| [line, "\n"])
                .collect();
            let value: serde_json::Value = serde_json::from_str(&released).expect(&name);
            let state: UpdateState = serde_json::from_str(&released).expect(&name);
            let phase: Phase = serde_json::from_value(value["phase"].clone()).expect("a phase");
            assert_eq!(state.phase(), phase, "{name}");
            phases.insert(format!("{phase:?}"));
            assert_eq!(encode(&state), released, "{name}");
        }
        assert_eq!(phases.len(), 5, "every phase: {phases:?}");
    }

    /// Any combination of the flat record's marks (only some are ever written) loads to one
    /// lifecycle, keeping what recovery needs: a decided rollback on an update in progress is
    /// finished (never confirmed); a restart the dead-man owes after a rollback stays owed; an
    /// update in progress stays in progress (its recovery copy is kept); a recorded end stays
    /// that end. Loading what it saves gives the same lifecycle.
    #[test]
    fn any_stored_combination_loads_to_a_sane_lifecycle() {
        let dir = tempfile::tempdir().expect("dir");
        let phases = [
            Phase::Armed,
            Phase::Swapped,
            Phase::Confirmed,
            Phase::RolledBack,
            Phase::Failed,
        ];
        for phase in phases {
            for origin in [Origin::Server, Origin::Cli] {
                for rolling_back in [false, true] {
                    for restart_pending in [false, true] {
                        for reported in [false, true] {
                            let mut value = serde_json::to_value(sample(dir.path(), Phase::Armed))
                                .expect("encode");
                            value["phase"] = serde_json::to_value(phase).expect("phase");
                            value["origin"] = serde_json::to_value(origin).expect("origin");
                            value["rollingBack"] = rolling_back.into();
                            value["restartPending"] = restart_pending.into();
                            value["reported"] = reported.into();
                            let case = format!("{value}");
                            let state: UpdateState = serde_json::from_value(value).expect(&case);
                            let lifecycle = state.lifecycle;
                            assert_eq!(lifecycle.in_progress(), phase.in_progress(), "{case}");
                            assert!(
                                !phase.in_progress() || state.needs_recovery(),
                                "{case}: recovery copy kept"
                            );
                            if phase.in_progress() {
                                assert_eq!(
                                    lifecycle == Lifecycle::RollingBack,
                                    rolling_back,
                                    "{case}"
                                );
                                if !rolling_back {
                                    assert_eq!(lifecycle.phase(), phase, "{case}");
                                }
                            } else {
                                assert_eq!(lifecycle.phase(), phase, "{case}: the end wins");
                            }
                            assert_eq!(
                                lifecycle.restart_pending(),
                                phase == Phase::RolledBack && restart_pending,
                                "{case}"
                            );
                            assert_eq!(
                                lifecycle.reported(),
                                (!phase.in_progress())
                                    .then_some(reported && origin == Origin::Server),
                                "{case}"
                            );
                            let again: UpdateState =
                                serde_json::from_str(&encode(&state)).expect(&case);
                            assert_eq!(again, state, "{case}: a fixed point");
                        }
                    }
                }
            }
        }
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
