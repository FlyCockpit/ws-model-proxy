//! Terminal and exec sessions multiplexed on one relay connection.
//!
//! Output readers send through [`FromWorker`](crate::services::relay_bus::FromWorker) on the shared `sync_channel(64)`.
//! Dropping a registry kills every child. `kill_all` is safe to call first; the
//! later drop is a no-op.
//!
//! Unix children are process-group leaders (`setsid` for a PTY, `process_group(0)`
//! for exec) and are stopped with `SIGKILL` to the group. Closing a terminal
//! also kills every process in the shell's session, including background jobs
//! in their own process groups and `nohup`/disowned jobs; only a process that
//! calls `setsid()` itself leaves that session and survives. Windows execs
//! run in a job object assigned before the child starts. Terminating the job
//! kills the whole tree, including detached grandchildren.
//!
//! Every live Unix exec group and PTY session, and every Windows exec, is also
//! recorded in a global list, so a forced shutdown (`crate::process::shutdown`) can
//! kill them from another thread with [`kill_tracked_children`](children::kill_tracked_children) when the relay
//! thread is stuck.
//!
//! A terminal closes when its shell exits, not only on PTY EOF: a background
//! or disowned job can hold the PTY open after the shell is gone. The relay
//! loop's `poll` reaps the shell, lets already-written output drain briefly,
//! then kills the rest of the session and reports the shell's exit status.
//!
//! Terminal input never blocks the relay loop. Each terminal has a writer
//! thread fed by a queue of at most [`INPUT_QUEUE_LIMIT`](pty::INPUT_QUEUE_LIMIT) pending bytes; when
//! the program is not reading and the queue is full, further input is dropped
//! and the viewer is told with `term.input_dropped`.
//!
//! Terminals have many viewers. Each viewer has pairwise v2 keys
//! for its input and for unicast frames (output-key delivery and its scrollback
//! replay). Live output and PTY-size frames are sealed once under a shared
//! per-terminal output key; the relay fans them out. The key rotates to a new
//! epoch whenever a viewer leaves. The PTY size follows the writer, the viewer
//! that most recently typed.

use std::path::PathBuf;

use crate::wire::protocol::{NodeBinaryMetadata, NodeFrame};

/// Ending and reaping child processes, and the list a forced shutdown kills.
mod children;

/// Reader threads that pass a child's output to the relay loop.
mod pump;

/// A terminal's process: a Unix PTY or the Windows console host.
mod pty;

/// Browser terminal handshakes and identity approvals.
mod handshake;

/// Browser and operator terminals and their registry.
mod terminal;

/// Node commands (`exec.*`) and their registry.
mod exec;

#[cfg(test)]
mod test_support;

pub(crate) use exec::{DEFAULT_COMMAND_MAX, ExecLine, ExecRegistry};
pub(crate) use handshake::TermHandshake;
pub(crate) use terminal::{OperatorDelivery, TerminalRegistry, operator_base_env};

const REASON_DISABLED: &str = "disabled";
/// A command refused because the node is at Relay only.
const REASON_TRUST_RELAY: &str = "trust_relay";
const REASON_UNSUPPORTED: &str = "unsupported";
const REASON_LIMIT: &str = "limit";
const REASON_VIEWER_LIMIT: &str = "viewer_limit";
const REASON_APPROVAL_REQUIRED: &str = "approval_required";
const REASON_BAD_SIGNATURE: &str = "bad_signature";
const REASON_BAD_COMMAND: &str = "bad_command";
const REASON_BAD_CWD: &str = "bad_cwd";
const REASON_NOT_FOUND: &str = "not_found";
const REASON_ALREADY_OPEN: &str = "already_open";
const REASON_SPAWN_FAILED: &str = "spawn_failed";
const REASON_SHELL_UNAVAILABLE: &str = "shell_unavailable";
const REASON_BAD_HANDSHAKE: &str = "bad_handshake";
const REASON_BAD_FRAME: &str = "bad_frame";
const REASON_EXPIRED: &str = "expired";

#[allow(clippy::large_enum_variant)] // `NodeFrame` carries the telemetry shapes.
pub(crate) enum OutboundFrame {
    Control(NodeFrame),
    Binary(NodeBinaryMetadata, Vec<u8>),
}

fn user_home() -> Result<PathBuf, &'static str> {
    dirs::home_dir().ok_or("home directory is unavailable")
}

fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=256).contains(&bytes.len())
        && !bytes.contains(&0)
        && !bytes.contains(&b'\n')
        && !bytes.contains(&b'\r')
}

fn signal_token(signal: Option<i32>) -> Option<String> {
    signal.map(|value| value.to_string())
}

/// A wire exit code (`0..=255`); a status outside it is not reported.
fn wire_exit_code(code: Option<i32>) -> Option<u8> {
    code.and_then(|code| u8::try_from(code).ok())
}

/// A registry's own life. It takes new work while `Open`; `kill_all` moves it to `ShutDown`
/// once, for good: it then starts nothing more (no command, shell or operator terminal) and
/// only answers for what it already knows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lifecycle {
    Open,
    ShutDown,
}

impl Lifecycle {
    fn is_shut_down(self) -> bool {
        self == Self::ShutDown
    }

    /// Move to `ShutDown`. `false`: it already was (a second `kill_all` does nothing).
    fn shut_down(&mut self) -> bool {
        std::mem::replace(self, Self::ShutDown) == Self::Open
    }
}
