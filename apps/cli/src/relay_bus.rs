//! Frames handed from worker and session threads back to the relay main loop.
//!
//! The main loop owns the websocket writer. Producers share one `sync_channel(64)`
//! so a fast PTY or exec cannot grow memory ahead of the socket.

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
    TerminalBytes {
        terminal_id: String,
        bytes: Vec<u8>,
    },
    TerminalEof {
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
}
