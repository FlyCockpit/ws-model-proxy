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
    /// Preparation of a supervised file request completed on the shared file
    /// pool. `generation` prevents a cancelled/recycled command id from
    /// receiving a stale snapshot.
    #[cfg(unix)]
    SupervisedFilePrepared {
        command_id: String,
        generation: u64,
        outcome: Box<crate::file_ops::FileResult<crate::file_ops::PreparedSupervised>>,
    },
    /// The sole daemon-owned application job settled on the shared file pool.
    #[cfg(unix)]
    SupervisedFileApplied {
        command_id: String,
        generation: u64,
        outcome: crate::file_ops::FileResult<serde_json::Value>,
    },
    /// 2.4: a frame from a live speech-to-text session thread. The loop
    /// sends it only while the session is live, through the non-fatal
    /// `stt.*` encoder path.
    Stt {
        session_id: String,
        /// Boxed: control messages are large next to the other variants.
        message: Box<crate::protocol::ClientControlMessage>,
    },
}
