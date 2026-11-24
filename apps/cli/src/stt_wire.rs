//! The `stt.*` server frames as the speech registry handles them: the
//! adapter a session uses is the endpoint's configured `RealtimeAdapter`.
//! The wire shapes and their bounds are `protocol::stt`.

use crate::config::RealtimeAdapter;
use crate::protocol::frames::{SttAdapter, SttConfig};
use crate::protocol::{RelayFailure, ServerFrame};

/// The `stt.*` server frames, as the speech registry handles them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SttServerMessage {
    Open {
        session_id: String,
        /// The runtime handle (always-on slug or instance handle).
        handle: String,
        upstream_model: String,
        adapter: RealtimeAdapter,
        config: SttConfig,
        max_item_seconds: u32,
        max_session_ms: u64,
        audio_window_bytes: u32,
    },
    /// Applies to the next item.
    Update {
        session_id: String,
        config: SttConfig,
    },
    Commit {
        session_id: String,
        item_seq: u32,
    },
    Clear {
        session_id: String,
        item_seq: u32,
    },
    Close {
        session_id: String,
        reason: RelayFailure,
    },
}

impl SttServerMessage {
    /// The speech message a server frame carries; `None` for other frames.
    pub fn from_frame(frame: &ServerFrame) -> Option<Self> {
        Some(match frame.clone() {
            ServerFrame::SttOpen {
                session_id,
                handle,
                upstream_model,
                adapter,
                config,
                max_item_seconds,
                max_session_ms,
                audio_window_bytes,
            } => Self::Open {
                session_id,
                handle,
                upstream_model,
                adapter: match adapter {
                    SttAdapter::Vllm => RealtimeAdapter::Vllm,
                    SttAdapter::Segmented => RealtimeAdapter::Segmented,
                },
                config,
                max_item_seconds,
                max_session_ms,
                audio_window_bytes,
            },
            ServerFrame::SttUpdate { session_id, config } => Self::Update { session_id, config },
            ServerFrame::SttCommit {
                session_id,
                item_seq,
            } => Self::Commit {
                session_id,
                item_seq,
            },
            ServerFrame::SttClear {
                session_id,
                item_seq,
            } => Self::Clear {
                session_id,
                item_seq,
            },
            ServerFrame::SttClose { session_id, reason } => Self::Close { session_id, reason },
            _ => return None,
        })
    }
}
