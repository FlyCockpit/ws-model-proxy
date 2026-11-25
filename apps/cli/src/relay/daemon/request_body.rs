//! A relayed request's body on its way from the websocket to the upstream
//! HTTP request: the credit-limited channel, the streamed body (exact
//! length or prefixed) and the buffered body.

use std::io;
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::thread;
use std::time::Duration;

use futures_core::Stream;
use tokio::sync::{mpsc as tokio_mpsc, watch};

use crate::services::relay_bus::{FromWorker, WsFrame};
use crate::wire::protocol::{NodeFrame, RELAY_REQUEST_BODY_WINDOW_CHUNKS, encode_control};

/// The async handoff owns one request chunk after a credit is returned. The
/// ingress queue must still accept the whole advertised window before the new
/// worker has had a chance to run.
const UPSTREAM_BODY_HANDOFF_CAPACITY: usize = 1;
pub(super) const REQUEST_BODY_INGRESS_CAPACITY: usize = RELAY_REQUEST_BODY_WINDOW_CHUNKS;

/// A request-body chunk delivered to a worker's upstream request reader.
pub(super) struct BodyChunk {
    pub(super) data: Vec<u8>,
    pub(super) last: bool,
}

/// Outcome of routing an inbound request-body frame to a worker.
pub(super) enum BodyRoute {
    Delivered,
    /// The worker's body channel is gone (upstream finished/rejected early).
    WorkerGone,
    /// The server exceeded the granted flow-control window: protocol violation.
    OverCredit,
}

pub(super) fn deliver_body_chunk(
    body_tx: &SyncSender<BodyChunk>,
    data: Vec<u8>,
    last: bool,
) -> BodyRoute {
    match body_tx.try_send(BodyChunk { data, last }) {
        Ok(()) => BodyRoute::Delivered,
        Err(TrySendError::Full(_)) => BodyRoute::OverCredit,
        Err(TrySendError::Disconnected(_)) => BodyRoute::WorkerGone,
    }
}

/// A streamed body that fails if it yields more or fewer than `length` bytes,
/// so a declared Content-Length always frames exactly what is sent.
pub(super) struct ExactLengthBody<S> {
    inner: S,
    length: u64,
    sent: u64,
    done: bool,
}

pub(super) fn exact_length_body<S>(inner: S, length: u64) -> ExactLengthBody<S> {
    ExactLengthBody {
        inner,
        length,
        sent: 0,
        done: false,
    }
}

impl<S> Stream for ExactLengthBody<S>
where
    S: Stream<Item = std::result::Result<Vec<u8>, io::Error>> + Unpin,
{
    type Item = std::result::Result<Vec<u8>, io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use std::task::Poll;
        if self.done {
            return Poll::Ready(None);
        }
        let mismatch =
            || io::Error::new(io::ErrorKind::InvalidData, "request body length mismatch");
        let item = match std::pin::Pin::new(&mut self.inner).poll_next(cx) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(item) => item,
        };
        let result = match item {
            Some(Ok(chunk)) => {
                self.sent = self.sent.saturating_add(chunk.len() as u64);
                if self.sent > self.length {
                    Err(mismatch())
                } else {
                    return Poll::Ready(Some(Ok(chunk)));
                }
            }
            Some(Err(error)) => Err(error),
            None if self.sent != self.length => Err(mismatch()),
            None => {
                self.done = true;
                return Poll::Ready(None);
            }
        };
        self.done = true;
        Poll::Ready(Some(result))
    }
}

/// Bridge the websocket's synchronous, credit-limited request channel to the
/// async HTTP body. The bridge polls its cancellation receiver while waiting
/// for a body frame, so a cancelled upload cannot pin a worker on `recv()`.
pub(super) fn streaming_request_body(
    rx: Receiver<BodyChunk>,
    tx: SyncSender<FromWorker>,
    request_id: String,
    cancellation_rx: watch::Receiver<bool>,
) -> impl Stream<Item = std::result::Result<Vec<u8>, io::Error>> + Send + 'static {
    let (body_tx, body_rx) = tokio_mpsc::channel(UPSTREAM_BODY_HANDOFF_CAPACITY);
    thread::spawn(move || {
        loop {
            if *cancellation_rx.borrow() {
                return;
            }
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(BodyChunk { data, last }) => {
                    // Return a protocol credit only after this chunk entered
                    // the async handoff. Acknowledging before `blocking_send`
                    // lets the server refill the websocket channel while the
                    // handoff is still full, exceeding the advertised window.
                    // The end rides in band with the last chunk: a channel
                    // that closes without it is a truncated upload.
                    if body_tx.blocking_send(BodyHandoff { data, last }).is_err() {
                        return;
                    }
                    let ack = NodeFrame::RelayRequestBodyAck {
                        request_id: request_id.clone(),
                        credits: 1,
                    };
                    let Ok(text) = encode_control(&ack) else {
                        return;
                    };
                    if tx
                        .send(FromWorker::Send {
                            request_id: request_id.clone(),
                            frame: WsFrame::Text(text),
                        })
                        .is_err()
                    {
                        return;
                    }
                    if last {
                        return;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                // A sender disappearing before its final chunk is a truncated
                // upload, never a valid HTTP EOF. Let the body stream surface
                // a broken pipe instead of completing the upstream request.
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
    TokioBodyStream {
        receiver: body_rx,
        state: BodyStreamState::Open,
    }
}

/// One request-body chunk on its way from the bridge thread to the HTTP body.
struct BodyHandoff {
    data: Vec<u8>,
    last: bool,
}

/// Where the upstream request body stream stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyStreamState {
    /// More chunks may come.
    Open,
    /// The final chunk was yielded: a clean EOF.
    Ended,
    /// The channel closed before the final chunk: the error was yielded.
    Truncated,
}

struct TokioBodyStream {
    receiver: tokio_mpsc::Receiver<BodyHandoff>,
    state: BodyStreamState,
}

impl Stream for TokioBodyStream {
    type Item = std::result::Result<Vec<u8>, io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use std::task::Poll;
        if self.state != BodyStreamState::Open {
            return Poll::Ready(None);
        }
        match self.receiver.poll_recv(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Some(BodyHandoff { data, last })) => {
                if last {
                    self.state = BodyStreamState::Ended;
                }
                Poll::Ready(Some(Ok(data)))
            }
            Poll::Ready(None) => {
                self.state = BodyStreamState::Truncated;
                Poll::Ready(Some(Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "relay request body ended before final chunk",
                ))))
            }
        }
    }
}

/// Outcome of buffering a relay request body for media expansion.
#[derive(Debug)]
pub(super) enum CollectError {
    /// End-of-body never arrived (disconnect or cancellation).
    Aborted,
    /// The buffered body exceeded the cap.
    TooLarge,
}

/// The most a body without a declared length is buffered to send it with a
/// Content-Length (the server's JSON body cap).
pub(super) const UNSIZED_BODY_BUFFER_BYTES: usize = 32 * 1024 * 1024;

/// A body read up to a cap: whole, or the chunks read before the cap.
pub(super) enum BufferedBody {
    Whole(Vec<u8>),
    Prefix(Vec<Vec<u8>>),
    Aborted,
}

/// Read body chunks (one credit each, as the streaming reader returns them)
/// until the final chunk or until more than `max_bytes` arrived.
pub(super) fn buffer_body_prefix(
    rx: &Receiver<BodyChunk>,
    tx: &SyncSender<FromWorker>,
    request_id: &str,
    max_bytes: usize,
) -> BufferedBody {
    let mut chunks = Vec::new();
    let mut total = 0_usize;
    loop {
        let Ok(BodyChunk { data, last }) = rx.recv() else {
            return BufferedBody::Aborted;
        };
        if !send_body_credit(tx, request_id) {
            return BufferedBody::Aborted;
        }
        total = total.saturating_add(data.len());
        chunks.push(data);
        if last {
            return BufferedBody::Whole(chunks.concat());
        }
        if total > max_bytes {
            return BufferedBody::Prefix(chunks);
        }
    }
}

/// Chunks already read, then the rest of the streamed body.
pub(super) struct PrefixedBody<S> {
    pub(super) prefix: std::collections::VecDeque<Vec<u8>>,
    pub(super) rest: S,
}

impl<S> Stream for PrefixedBody<S>
where
    S: Stream<Item = std::result::Result<Vec<u8>, io::Error>> + Unpin,
{
    type Item = std::result::Result<Vec<u8>, io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        if let Some(chunk) = self.prefix.pop_front() {
            return std::task::Poll::Ready(Some(Ok(chunk)));
        }
        std::pin::Pin::new(&mut self.rest).poll_next(cx)
    }
}

/// Drain the streamed request body into memory, returning one flow-control
/// credit to the server per consumed chunk so buffered mode keeps the same
/// credit accounting as the streaming reader.
pub(super) fn collect_request_body(
    rx: &Receiver<BodyChunk>,
    tx: &SyncSender<FromWorker>,
    request_id: &str,
    max_bytes: usize,
) -> std::result::Result<Vec<u8>, CollectError> {
    let mut buffer = Vec::new();
    loop {
        match rx.recv() {
            Ok(BodyChunk { data, last }) => {
                if !send_body_credit(tx, request_id) {
                    return Err(CollectError::Aborted);
                }
                if buffer.len().saturating_add(data.len()) > max_bytes {
                    return Err(CollectError::TooLarge);
                }
                buffer.extend_from_slice(&data);
                if last {
                    return Ok(buffer);
                }
            }
            Err(_) => return Err(CollectError::Aborted),
        }
    }
}

/// Return one request-body flow-control credit to the server. Returns false when
/// the outbound channel is gone.
fn send_body_credit(tx: &SyncSender<FromWorker>, request_id: &str) -> bool {
    let ack = NodeFrame::RelayRequestBodyAck {
        request_id: request_id.to_string(),
        credits: 1,
    };
    match encode_control(&ack) {
        Ok(text) => tx
            .send(FromWorker::Send {
                request_id: request_id.to_string(),
                frame: WsFrame::Text(text),
            })
            .is_ok(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::super::link::RELAY_WORKER_OUTBOUND_CAPACITY;
    use super::super::upstream_worker::CancellationHandle;
    use super::*;
    use crate::services::media::MEDIA_EXPAND_MAX_BODY_BYTES;

    // Unix only: Windows `shutdown` does not interrupt a blocked send (see
    // `PublicationWatchdog`).
    fn drain_acks(rx: &Receiver<FromWorker>) -> Vec<String> {
        let mut acks = Vec::new();
        while let Ok(message) = rx.try_recv() {
            if let FromWorker::Send {
                frame: WsFrame::Text(text),
                ..
            } = message
            {
                acks.push(text);
            }
        }
        acks
    }

    #[test]
    fn collect_request_body_buffers_and_returns_a_credit_per_chunk() {
        let (body_tx, body_rx) = mpsc::channel::<BodyChunk>();
        let (out_tx, out_rx) = mpsc::sync_channel::<FromWorker>(16);
        body_tx
            .send(BodyChunk {
                data: b"hello ".to_vec(),
                last: false,
            })
            .expect("send chunk");
        body_tx
            .send(BodyChunk {
                data: b"world".to_vec(),
                last: true,
            })
            .expect("send final chunk");

        let body =
            collect_request_body(&body_rx, &out_tx, "request-1", MEDIA_EXPAND_MAX_BODY_BYTES)
                .expect("collect");
        assert_eq!(body, b"hello world");

        // Buffered mode must return the same one-credit-per-chunk flow control as
        // the streaming reader so the server keeps sending within its window.
        let acks = drain_acks(&out_rx);
        assert_eq!(acks.len(), 2);
        for ack in acks {
            assert!(ack.contains(r#""type":"relay.request.body.ack""#));
            assert!(ack.contains(r#""requestId":"request-1""#));
            assert!(ack.contains(r#""credits":1"#));
        }
    }

    #[test]
    fn collect_request_body_enforces_the_cap() {
        let (body_tx, body_rx) = mpsc::channel::<BodyChunk>();
        let (out_tx, out_rx) = mpsc::sync_channel::<FromWorker>(16);
        body_tx
            .send(BodyChunk {
                data: vec![0_u8; 8],
                last: false,
            })
            .expect("send chunk");
        body_tx
            .send(BodyChunk {
                data: vec![0_u8; 8],
                last: true,
            })
            .expect("send final chunk");

        let result = collect_request_body(&body_rx, &out_tx, "request-1", 10);
        assert!(matches!(result, Err(CollectError::TooLarge)));
        // The first (in-window) chunk was still acked before the cap tripped.
        assert_eq!(drain_acks(&out_rx).len(), 2);
    }

    #[test]
    fn collect_request_body_aborts_when_sender_dropped_before_end() {
        let (body_tx, body_rx) = mpsc::channel::<BodyChunk>();
        let (out_tx, _out_rx) = mpsc::sync_channel::<FromWorker>(16);
        body_tx
            .send(BodyChunk {
                data: b"partial".to_vec(),
                last: false,
            })
            .expect("send chunk");
        drop(body_tx);

        let result =
            collect_request_body(&body_rx, &out_tx, "request-1", MEDIA_EXPAND_MAX_BODY_BYTES);
        assert!(matches!(result, Err(CollectError::Aborted)));
    }

    #[test]
    fn deliver_body_chunk_reports_over_credit_when_window_is_full() {
        let (body_tx, body_rx) = mpsc::sync_channel::<BodyChunk>(1);
        assert!(matches!(
            deliver_body_chunk(&body_tx, vec![1], false),
            BodyRoute::Delivered
        ));
        // Second chunk exceeds the one-slot window before the receiver drains.
        assert!(matches!(
            deliver_body_chunk(&body_tx, vec![2], false),
            BodyRoute::OverCredit
        ));
        drop(body_rx);
        assert!(matches!(
            deliver_body_chunk(&body_tx, vec![3], true),
            BodyRoute::WorkerGone
        ));
    }

    #[test]
    fn ingress_accepts_the_full_advertised_credit_burst_before_worker_runs() {
        let (body_tx, body_rx) = mpsc::sync_channel::<BodyChunk>(REQUEST_BODY_INGRESS_CAPACITY);
        for index in 0..RELAY_REQUEST_BODY_WINDOW_CHUNKS {
            assert!(matches!(
                deliver_body_chunk(&body_tx, vec![index as u8], false),
                BodyRoute::Delivered
            ));
        }
        assert!(matches!(
            deliver_body_chunk(&body_tx, vec![255], true),
            BodyRoute::OverCredit
        ));
        drop(body_rx);
    }

    #[test]
    fn disconnected_request_body_is_not_reported_as_clean_eof() {
        let (body_tx, body_rx) = mpsc::sync_channel::<BodyChunk>(1);
        let (out_tx, _out_rx) = mpsc::sync_channel::<FromWorker>(1);
        let (_cancellation, cancellation_rx) = CancellationHandle::new();
        let mut stream =
            streaming_request_body(body_rx, out_tx, "request-1".to_string(), cancellation_rx);
        drop(body_tx);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");
        let item = runtime
            .block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(1),
                    std::future::poll_fn(|cx| std::pin::Pin::new(&mut stream).poll_next(cx)),
                )
                .await
            })
            .expect("body stream should terminate")
            .expect("truncated body must yield an item");
        let error = item.expect_err("truncated body must fail closed");
        assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn cancelled_request_body_is_not_reported_as_clean_eof() {
        let (_body_tx, body_rx) = mpsc::sync_channel::<BodyChunk>(1);
        let (out_tx, _out_rx) = mpsc::sync_channel::<FromWorker>(1);
        let (cancellation, cancellation_rx) = CancellationHandle::new();
        let mut stream =
            streaming_request_body(body_rx, out_tx, "request-1".to_string(), cancellation_rx);
        assert!(cancellation.cancel());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");
        let item = runtime
            .block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(1),
                    std::future::poll_fn(|cx| std::pin::Pin::new(&mut stream).poll_next(cx)),
                )
                .await
            })
            .expect("body stream should terminate")
            .expect("cancelled body must yield an item");
        assert_eq!(
            item.expect_err("cancelled body must fail closed").kind(),
            io::ErrorKind::BrokenPipe
        );
    }

    #[test]
    fn a_body_over_the_buffer_cap_keeps_its_prefix_and_streams_the_rest() {
        let (body_tx, body_rx) = mpsc::sync_channel(4);
        body_tx
            .send(BodyChunk {
                data: vec![1; 4],
                last: false,
            })
            .expect("a");
        body_tx
            .send(BodyChunk {
                data: vec![2; 4],
                last: false,
            })
            .expect("b");
        let (tx, _rx) = mpsc::sync_channel(RELAY_WORKER_OUTBOUND_CAPACITY);
        match buffer_body_prefix(&body_rx, &tx, "r", 6) {
            BufferedBody::Prefix(prefix) => assert_eq!(prefix, vec![vec![1; 4], vec![2; 4]]),
            _ => panic!("expected a prefix"),
        }
        drop(body_tx);
        assert!(matches!(
            buffer_body_prefix(&body_rx, &tx, "r", 6),
            BufferedBody::Aborted
        ));
    }

    /// A body longer than its declared length fails instead of being cut
    /// (or smuggling the rest as a second request).
    #[test]
    fn a_body_longer_than_declared_fails_closed() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime");
        let chunks = vec![Ok(b"12345".to_vec()), Ok(b"678".to_vec())];
        let mut body = exact_length_body(Box::pin(tokio_stream_of(chunks)), 6);
        let first = runtime.block_on(next_item(&mut body));
        assert!(matches!(first, Some(Ok(_))));
        let second = runtime.block_on(next_item(&mut body));
        assert!(matches!(second, Some(Err(_))));
        assert!(runtime.block_on(next_item(&mut body)).is_none());

        let mut short = exact_length_body(Box::pin(tokio_stream_of(vec![Ok(b"12".to_vec())])), 6);
        assert!(matches!(
            runtime.block_on(next_item(&mut short)),
            Some(Ok(_))
        ));
        assert!(matches!(
            runtime.block_on(next_item(&mut short)),
            Some(Err(_))
        ));
    }

    type TestBodyItem = std::result::Result<Vec<u8>, io::Error>;

    struct VecStream(std::collections::VecDeque<TestBodyItem>);

    impl Stream for VecStream {
        type Item = TestBodyItem;
        fn poll_next(
            mut self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<TestBodyItem>> {
            std::task::Poll::Ready(self.0.pop_front())
        }
    }

    fn tokio_stream_of(items: Vec<TestBodyItem>) -> VecStream {
        VecStream(items.into())
    }

    async fn next_item<S: Stream<Item = TestBodyItem> + Unpin>(
        stream: &mut S,
    ) -> Option<TestBodyItem> {
        std::future::poll_fn(|cx| std::pin::Pin::new(&mut *stream).poll_next(cx)).await
    }
}
