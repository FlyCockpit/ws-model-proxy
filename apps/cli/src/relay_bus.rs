//! Frames handed from worker and session threads back to the relay main loop.
//!
//! The main loop owns the websocket writer. Producers share one `sync_channel(64)`
//! so a fast PTY or exec cannot grow memory ahead of the socket.

#[cfg(unix)]
use crate::config::Config;

pub(crate) enum WsFrame {
    Text(String),
    Binary(Vec<u8>),
}

pub(crate) enum FromWorker {
    Send {
        request_id: String,
        frame: WsFrame,
    },
    Finished(String),
    #[cfg(unix)]
    InventoryPrepared {
        candidate: Config,
    },
    #[cfg(unix)]
    InventoryPreparationFailed {
        message: String,
    },
    #[cfg(unix)]
    TerminalBytes {
        terminal_id: String,
        bytes: Vec<u8>,
    },
    #[cfg(unix)]
    TerminalEof {
        terminal_id: String,
    },
    /// A terminal's input writer thread hit a write error. The main loop
    /// closes the terminal.
    #[cfg(unix)]
    TerminalWriteFailed {
        terminal_id: String,
    },
    ExecBytes {
        command_id: String,
        stderr: bool,
        bytes: Vec<u8>,
    },
    ExecEof {
        command_id: String,
        stderr: bool,
    },
    /// 2.7 `node.info` / `node.metrics` / `endpoint.load` text from the
    /// telemetry thread. Sent only after registration; never request-scoped.
    Telemetry(String),
    /// 2.8: a node file op settled on a pool worker. The loop sends the frames
    /// only while the session still has the op pending.
    #[cfg(unix)]
    FileFrames {
        op_id: String,
        frames: Vec<crate::file_relay::FileFrame>,
    },
}
