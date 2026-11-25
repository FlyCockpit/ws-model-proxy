//! The update sequences, free of the relay: the self-replace install, the
//! Homebrew upgrade, the dead-man's rollback, the new binary's confirmation
//! and what a starting relay does with an update in flight.

use std::path::{Path, PathBuf};

use super::deadman::Scheduler;
use super::state::Origin;
use crate::protocol::frames::{UpdatePhase, UpdateReason};

mod installer;
mod recovery;
mod rollback;
mod start;

pub use installer::{record_homebrew, self_replace};
pub use recovery::deadman_spec;
pub use rollback::{
    Rollback, job_removed, no_longer_due, restart_done, restart_pending, rollback_if_unconfirmed,
    settle_abandoned,
};
pub use start::{Confirm, OnStart, Running, confirm, on_start};

/// What to install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub update_id: String,
    pub version: String,
    pub artifact_url: String,
    pub sha256: String,
    pub signature: Option<String>,
    pub rollback_after_secs: u32,
    pub origin: Origin,
}

/// Where progress goes: `agent.update.progress` frames, or a person's terminal.
pub trait Progress {
    fn report(&mut self, phase: UpdatePhase, reason: Option<UpdateReason>, detail: Option<String>);

    /// Refuse with `version_mismatch`, naming the version this node could install instead
    /// (the progress frame's `availableVersion`). A reporter that cannot carry it reports the
    /// refusal alone.
    fn refuse_version(&mut self, available: String, detail: String) {
        let _ = available;
        self.report(
            UpdatePhase::Refused,
            Some(UpdateReason::VersionMismatch),
            Some(detail),
        );
    }
}

/// The last check before the swap: `Err` with why it must not happen now.
pub type BeforeSwap<'a> = dyn Fn(&mut dyn Progress) -> std::result::Result<(), String> + 'a;

/// Whether the update may still go on (the node's trust, its operator's
/// setting): asked between the steps, and refuses with the reason when not.
pub type Proceed<'a> = dyn Fn() -> std::result::Result<(), (UpdateReason, String)> + 'a;

/// The machine an update runs on.
pub struct Machine<'a> {
    /// The node's state directory (`--state-dir` of the dead-man).
    pub state_dir: PathBuf,
    /// The canonical live binary.
    pub live: PathBuf,
    /// The Rust target triple (the archive's `wsmp-<target>/` directory).
    pub target: String,
    /// The dead-man's scheduler; `None` when no service restarts wsmp (the
    /// caller then finishes without one).
    pub scheduler: Option<&'a dyn Scheduler>,
    pub tar: PathBuf,
    pub current_version: String,
    /// Asked last, before anything is armed or moved: `Err` with why the swap
    /// must not happen now (the node is busy again). The relay keeps the node
    /// idle from a yes until it restarts.
    pub before_swap: Option<&'a BeforeSwap<'a>>,
    /// Asked after the download, before the new build runs, and before the
    /// swap.
    pub proceed: Option<&'a Proceed<'a>>,
    /// Homebrew only, before the keg changes: make the installed service
    /// start the stable `opt` path it is given (the path the update probes
    /// after `brew upgrade`), or say why it cannot (the update stops).
    /// [`crate::service::files::ensure_stable_executable`] outside tests.
    pub stable_service: fn(&Path) -> anyhow::Result<()>,
}

impl Machine<'_> {
    pub fn update_dir(&self) -> PathBuf {
        self.state_dir.join("update")
    }
}

/// How an install ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// The new binary is in place (state `swapped`): restart into it.
    Swapped,
    /// Refused or failed; the progress already says why. No new build was
    /// recorded as installed. Steps already done stay done: a self-replace
    /// puts the previous binary back, but a Homebrew update may have
    /// refreshed the tap, rewritten the service or run `brew upgrade`
    /// (Homebrew has no rollback).
    Stopped,
}

#[cfg(test)]
mod tests;
