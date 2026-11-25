//! `agent.update` phases, reasons and bounds.

use serde::{Deserialize, Serialize};

/// `agent.update.progress` `phase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePhase {
    Refused,
    WaitingIdle,
    Downloading,
    Verifying,
    Armed,
    Swapped,
    Restarting,
    Confirmed,
    RolledBack,
    Failed,
}

/// `agent.update.progress` `reason` (only with `refused` or `failed`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateReason {
    NotOwnerTrust,
    OptedOut,
    SourceBuild,
    UnsupportedMethod,
    Busy,
    SignatureMismatch,
    ChecksumMismatch,
    DownloadFailed,
    VersionMismatch,
    AlreadyCurrent,
    InProgress,
    Internal,
}

/// `agent.update.progress` `detail` cap (UTF-16 code units, as the server counts).
pub const UPDATE_DETAIL_MAX_CHARS: usize = 4000;

/// `agent.update` `rollbackAfterSecs` bounds.
pub const UPDATE_ROLLBACK_SECS_RANGE: std::ops::RangeInclusive<u32> = 30..=600;
