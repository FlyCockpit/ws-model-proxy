//! Reader threads: a child's output, read chunk by chunk, sent to the relay loop.

use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::relay_bus::FromWorker;

const READ_CHUNK: usize = 8 * 1024;
const SEND_WAIT: Duration = Duration::from_millis(200);

pub(super) const READ_POLL: Duration = Duration::from_millis(200);

pub(super) fn send_note(tx: &SyncSender<FromWorker>, mut note: FromWorker, stop: &AtomicBool) {
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        // `SyncSender::send_timeout` is not stable on the 1.89 MSRV. Poll with
        // try_send so a full channel still applies backpressure without dropping
        // output, and so shutdown can unblock the reader.
        match tx.try_send(note) {
            Ok(()) => return,
            Err(mpsc::TrySendError::Full(returned)) => {
                note = returned;
                std::thread::sleep(SEND_WAIT);
            }
            Err(mpsc::TrySendError::Disconnected(_)) => return,
        }
    }
}

#[cfg(not(unix))]
pub(super) fn pump_reader<R>(
    mut reader: R,
    tx: SyncSender<FromWorker>,
    stop: Arc<AtomicBool>,
    make_bytes: impl Fn(Vec<u8>) -> FromWorker + Send + 'static,
    make_eof: impl Fn() -> FromWorker + Send + 'static,
) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut buf = [0_u8; READ_CHUNK];
        loop {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            match reader.read(&mut buf) {
                Ok(0) => {
                    send_note(&tx, make_eof(), &stop);
                    return;
                }
                Ok(count) => {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    send_note(&tx, make_bytes(buf[..count].to_vec()), &stop);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    send_note(&tx, make_eof(), &stop);
                    return;
                }
            }
        }
    })
}

#[cfg(unix)]
pub(super) fn pump_polled<R>(
    mut reader: R,
    tx: SyncSender<FromWorker>,
    stop: Arc<AtomicBool>,
    make_bytes: impl Fn(Vec<u8>) -> FromWorker + Send + 'static,
    make_eof: impl Fn() -> FromWorker + Send + 'static,
) -> JoinHandle<()>
where
    R: Read + std::os::fd::AsFd + Send + 'static,
{
    std::thread::spawn(move || {
        let timeout =
            nix::poll::PollTimeout::try_from(READ_POLL).unwrap_or(nix::poll::PollTimeout::ZERO);
        let mut buf = [0_u8; READ_CHUNK];
        loop {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            let events = {
                let mut fds = [nix::poll::PollFd::new(
                    reader.as_fd(),
                    nix::poll::PollFlags::POLLIN | nix::poll::PollFlags::POLLHUP,
                )];
                match nix::poll::poll(&mut fds, timeout) {
                    Ok(0) => continue,
                    Err(nix::errno::Errno::EINTR) => continue,
                    Err(_) => {
                        send_note(&tx, make_eof(), &stop);
                        return;
                    }
                    Ok(_) => fds[0].revents().unwrap_or(nix::poll::PollFlags::empty()),
                }
            };
            if stop.load(Ordering::Relaxed) {
                return;
            }
            if events.contains(nix::poll::PollFlags::POLLNVAL) {
                send_note(&tx, make_eof(), &stop);
                return;
            }
            let readable = events.contains(nix::poll::PollFlags::POLLIN)
                || events.contains(nix::poll::PollFlags::POLLHUP)
                || events.contains(nix::poll::PollFlags::POLLERR);
            if !readable {
                continue;
            }
            match reader.read(&mut buf) {
                Ok(0) => {
                    send_note(&tx, make_eof(), &stop);
                    return;
                }
                Ok(count) => {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    send_note(&tx, make_bytes(buf[..count].to_vec()), &stop);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(error) if error.raw_os_error() == Some(nix::errno::Errno::EIO as i32) => {
                    send_note(&tx, make_eof(), &stop);
                    return;
                }
                Err(_) => {
                    send_note(&tx, make_eof(), &stop);
                    return;
                }
            }
        }
    })
}

#[cfg(unix)]
pub(super) fn pump_exec_reader<R>(
    reader: R,
    tx: SyncSender<FromWorker>,
    stop: Arc<AtomicBool>,
    make_bytes: impl Fn(Vec<u8>) -> FromWorker + Send + 'static,
    make_eof: impl Fn() -> FromWorker + Send + 'static,
) -> JoinHandle<()>
where
    R: Read + std::os::fd::AsFd + Send + 'static,
{
    pump_polled(reader, tx, stop, make_bytes, make_eof)
}

#[cfg(not(unix))]
pub(super) fn pump_exec_reader<R>(
    reader: R,
    tx: SyncSender<FromWorker>,
    stop: Arc<AtomicBool>,
    make_bytes: impl Fn(Vec<u8>) -> FromWorker + Send + 'static,
    make_eof: impl Fn() -> FromWorker + Send + 'static,
) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    pump_reader(reader, tx, stop, make_bytes, make_eof)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::sessions::test_support::channel;

    #[test]
    #[cfg(unix)]
    fn reader_stop_does_not_require_the_fd_to_close() {
        let (reader, _writer) = std::os::unix::net::UnixStream::pair().expect("socket pair");
        reader.set_nonblocking(false).expect("blocking");
        let (tx, _rx) = channel();
        let stop = Arc::new(AtomicBool::new(false));
        let (done_tx, done_rx) = mpsc::channel();
        let stop_flag = Arc::clone(&stop);
        let handle = pump_polled(
            reader,
            tx,
            Arc::clone(&stop),
            |_| FromWorker::TerminalBytes {
                terminal_id: "t".to_string(),
                bytes: Vec::new(),
            },
            || FromWorker::TerminalEof {
                terminal_id: "t".to_string(),
            },
        );
        std::thread::spawn(move || {
            stop_flag.store(true, Ordering::SeqCst);
            let _ = handle.join();
            let _ = done_tx.send(());
        });
        done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("reader did not notice the stop flag");
    }
}
