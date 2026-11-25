//! The relay socket's lowest layer: the session error, sending control,
//! binary, terminal, file and speech-to-text frames, and the socket's
//! timeouts.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use tungstenite::Message;

use crate::relay::sessions::OutboundFrame;
use crate::wire::protocol::{NodeFrame, RelayFailure, encode_binary_frame, encode_control};

pub(super) enum RelaySessionError {
    /// Lost or refused for now: reconnect after the backoff
    /// ([`ReconnectBackoff`](super::backoff::ReconnectBackoff) decides how long from how far the attempt got).
    Reconnectable {
        error: anyhow::Error,
    },
    Fatal(anyhow::Error),
    /// A shutdown signal arrived; the session has already cleaned up.
    Shutdown(i32),
    /// An update is in place: exit with `RestartForUpdate` so the service
    /// starts the new binary.
    RestartForUpdate,
}

pub(super) type RelaySessionResult<T> = std::result::Result<T, RelaySessionError>;

/// Sends one `stt.*` frame without risking the relay: a frame the encoder
/// refuses ends only its session, with an `stt.error` in its place. Socket
/// errors stay what they are for every frame.
pub(super) fn send_stt<S>(
    socket: &mut tungstenite::WebSocket<S>,
    stt: &mut crate::services::stt::SttRegistry,
    message: NodeFrame,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let text = match encode_control(&message) {
        Ok(text) => text,
        Err(_) => {
            let Some(session_id) = crate::services::stt::session_of(&message) else {
                return Ok(());
            };
            tracing::warn!(
                session_id,
                "a speech-to-text frame was outside the wire contract; ending that session"
            );
            let Some(refusal) = stt.refused_by_encoder(session_id) else {
                return Ok(());
            };
            match encode_control(&refusal) {
                Ok(text) => text,
                Err(_) => return Ok(()),
            }
        }
    };
    socket
        .send(Message::Text(text.into()))
        .map_err(|error| websocket_session_error(error, "sending a speech-to-text frame"))
}

pub(super) fn send_stt_frames<S>(
    socket: &mut tungstenite::WebSocket<S>,
    stt: &mut crate::services::stt::SttRegistry,
    frames: Vec<NodeFrame>,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    for frame in frames {
        send_stt(socket, stt, frame)?;
    }
    Ok(())
}

pub(super) fn send_relay_error<S>(
    socket: &mut tungstenite::WebSocket<S>,
    request_id: &str,
    failure: RelayFailure,
    message: Option<String>,
    upstream_status_code: Option<u16>,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    send_control(
        socket,
        &NodeFrame::RelayError {
            request_id: request_id.to_string(),
            failure,
            message,
            upstream_status_code,
        },
        "sending relay error",
    )?;
    Ok(())
}

pub(super) fn send_file_frames<S>(
    socket: &mut tungstenite::WebSocket<S>,
    frames: Vec<crate::services::file_relay::FileFrame>,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    use crate::services::file_relay::FileFrame;
    for frame in frames {
        match frame {
            FileFrame::Control(message) => {
                send_control(socket, &message, "sending a file op frame")?;
            }
            FileFrame::Binary(metadata, body) => {
                let encoded =
                    encode_binary_frame(&metadata, &body).map_err(RelaySessionError::Fatal)?;
                socket
                    .send(Message::Binary(encoded.into()))
                    .map_err(|error| websocket_session_error(error, "sending a file op frame"))?;
            }
        }
    }
    Ok(())
}

pub(super) fn send_outbound_frames<S>(
    socket: &mut tungstenite::WebSocket<S>,
    frames: Vec<OutboundFrame>,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    for frame in frames {
        match frame {
            OutboundFrame::Control(message) => {
                send_control(socket, &message, "sending terminal or exec frame")?;
            }
            OutboundFrame::Binary(metadata, body) => {
                let encoded =
                    encode_binary_frame(&metadata, &body).map_err(RelaySessionError::Fatal)?;
                socket
                    .send(Message::Binary(encoded.into()))
                    .map_err(|error| {
                        websocket_session_error(error, "sending terminal or exec frame")
                    })?;
            }
        }
    }
    Ok(())
}

pub(super) fn send_control<S>(
    socket: &mut tungstenite::WebSocket<S>,
    message: &NodeFrame,
    context: &'static str,
) -> RelaySessionResult<()>
where
    S: std::io::Read + std::io::Write,
{
    let text = encode_control(message).map_err(RelaySessionError::Fatal)?;
    socket
        .send(Message::Text(text.into()))
        .map_err(|error| websocket_session_error(error, context))
}

pub(super) fn websocket_session_error(
    error: tungstenite::Error,
    context: &'static str,
) -> RelaySessionError {
    match error {
        error @ (tungstenite::Error::ConnectionClosed
        | tungstenite::Error::AlreadyClosed
        | tungstenite::Error::Io(_)
        | tungstenite::Error::Tls(_)) => RelaySessionError::Reconnectable {
            error: anyhow::Error::new(error).context(context),
        },
        error => RelaySessionError::Fatal(anyhow::Error::new(error).context(context)),
    }
}

/// A relay socket read that returned without data and can simply be retried:
/// the poll timeout set by [`set_socket_timeouts`], or a shutdown signal
/// that landed on this thread (`EINTR`; a socket timeout keeps the read from
/// restarting). The loop then checks for shutdown as after a timeout.
pub(super) fn read_poll_woke(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    )
}

pub(super) fn set_read_poll(
    stream: &mut tungstenite::stream::MaybeTlsStream<std::net::TcpStream>,
    interval: Duration,
) -> Result<()> {
    let tcp = match stream {
        tungstenite::stream::MaybeTlsStream::Plain(stream) => Some(stream),
        tungstenite::stream::MaybeTlsStream::Rustls(stream) => Some(&mut stream.sock),
        _ => None,
    };
    tcp.context("unsupported websocket transport timeout configuration")?
        .set_read_timeout(Some(interval))
        .context("setting websocket read timeout")
}

pub(super) fn set_socket_timeouts(
    stream: &mut tungstenite::stream::MaybeTlsStream<std::net::TcpStream>,
    read_timeout: Duration,
    write_timeout: Duration,
) -> Result<()> {
    set_read_poll(stream, read_timeout)?;
    let tcp = match stream {
        tungstenite::stream::MaybeTlsStream::Plain(stream) => Some(stream),
        tungstenite::stream::MaybeTlsStream::Rustls(stream) => Some(&mut stream.sock),
        _ => None,
    };
    let tcp = tcp.context("unsupported websocket transport timeout configuration")?;
    tcp.set_write_timeout(Some(write_timeout))
        .context("setting websocket write timeout")?;
    Ok(())
}

pub(super) fn next_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("{prefix}-{millis}")
}

#[cfg(test)]
pub(super) mod tests {
    use std::io;

    /// A write-only in-memory stream so a `tungstenite::WebSocket` can be driven
    /// in a unit test without a real socket. Reads report end-of-stream; writes
    /// accumulate the encoded frame bytes for assertions.
    pub(in crate::relay::daemon) struct SinkStream {
        pub(in crate::relay::daemon) written: Vec<u8>,
    }

    impl io::Read for SinkStream {
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            Ok(0)
        }
    }

    impl io::Write for SinkStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.written.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    pub(in crate::relay::daemon) fn sink_socket() -> tungstenite::WebSocket<SinkStream> {
        tungstenite::WebSocket::from_raw_socket(
            SinkStream {
                written: Vec::new(),
            },
            tungstenite::protocol::Role::Server,
            None,
        )
    }
}
