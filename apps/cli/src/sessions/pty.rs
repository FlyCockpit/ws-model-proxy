//! A terminal's process: on Unix a shell on a PTY, on Windows the `wsmp __conpty-host` helper
//! that owns the pseudoconsole. Its input queue and writer thread never block the relay loop.

use std::collections::VecDeque;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::JoinHandle;
#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
use super::children::status_parts;
use super::children::{LiveChild, LiveChildGuard};
#[cfg(unix)]
use super::children::{end_shell_session, reap_after_signal, reap_pid};
#[cfg(unix)]
use super::pump::pump_polled;
#[cfg(windows)]
use super::pump::pump_reader;
use super::pump::{READ_POLL, send_note};
use crate::relay_bus::FromWorker;

/// Pending (queued plus in-flight) input bytes per terminal. Input beyond this
/// is dropped rather than blocking the relay loop.
const INPUT_QUEUE_LIMIT: usize = 256 * 1024;
/// Room past [`INPUT_QUEUE_LIMIT`] for Windows resize frames.
#[cfg(windows)]
const CONTROL_SLACK: usize = 4 * 1024;

/// Browser input waiting for a terminal's writer thread.
struct InputQueue {
    state: Mutex<InputState>,
    ready: Condvar,
}

#[derive(Default)]
struct InputState {
    chunks: VecDeque<Vec<u8>>,
    /// Queued plus in-flight bytes.
    pending: usize,
    closed: bool,
    failed: bool,
}

impl InputQueue {
    fn new() -> Self {
        Self {
            state: Mutex::new(InputState::default()),
            ready: Condvar::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, InputState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Never blocks on the PTY. `Ok(false)` means the queue is full and the
    /// bytes were dropped. An error means the writer has failed or stopped.
    fn push(&self, bytes: Vec<u8>) -> std::io::Result<bool> {
        let mut state = self.lock();
        if state.failed || state.closed {
            return Err(std::io::Error::other("terminal input is closed"));
        }
        if bytes.is_empty() {
            return Ok(true);
        }
        if state.pending.saturating_add(bytes.len()) > INPUT_QUEUE_LIMIT {
            return Ok(false);
        }
        state.pending += bytes.len();
        state.chunks.push_back(bytes);
        drop(state);
        self.ready.notify_one();
        Ok(true)
    }

    /// The next chunk for the writer, or `None` once the terminal closes.
    fn next(&self, stop: &AtomicBool) -> Option<Vec<u8>> {
        let mut state = self.lock();
        loop {
            if state.closed || stop.load(Ordering::Relaxed) {
                return None;
            }
            if let Some(chunk) = state.chunks.pop_front() {
                return Some(chunk);
            }
            state = self
                .ready
                .wait_timeout(state, READ_POLL)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    /// A resize for the Windows helper. Never dropped while input fits,
    /// since a lost resize leaves the console the wrong size; a writer stuck
    /// far behind drops it rather than queue without bound.
    #[cfg(windows)]
    fn push_control(&self, bytes: Vec<u8>) -> std::io::Result<()> {
        let mut state = self.lock();
        if state.failed || state.closed {
            return Err(std::io::Error::other("terminal input is closed"));
        }
        if state.pending > INPUT_QUEUE_LIMIT + CONTROL_SLACK {
            return Ok(());
        }
        state.pending += bytes.len();
        state.chunks.push_back(bytes);
        drop(state);
        self.ready.notify_one();
        Ok(())
    }

    fn written(&self, count: usize) {
        let mut state = self.lock();
        state.pending = state.pending.saturating_sub(count);
    }

    fn fail(&self) {
        self.lock().failed = true;
    }

    fn close(&self) {
        let mut state = self.lock();
        state.closed = true;
        state.chunks.clear();
        state.pending = 0;
        drop(state);
        self.ready.notify_all();
    }
}

/// Write all of `bytes` to a non-blocking PTY master, waiting for room with
/// `poll`. `Ok(false)` means `stop` was set first.
#[cfg(unix)]
fn write_polled(
    writer: &mut filedescriptor::FileDescriptor,
    bytes: &[u8],
    stop: &AtomicBool,
) -> std::io::Result<bool> {
    let timeout =
        nix::poll::PollTimeout::try_from(READ_POLL).unwrap_or(nix::poll::PollTimeout::ZERO);
    let mut offset = 0;
    while offset < bytes.len() {
        if stop.load(Ordering::Relaxed) {
            return Ok(false);
        }
        match writer.write(&bytes[offset..]) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "terminal write failed",
                ));
            }
            Ok(count) => offset += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                let mut fds = [nix::poll::PollFd::new(
                    std::os::fd::AsFd::as_fd(writer),
                    nix::poll::PollFlags::POLLOUT,
                )];
                match nix::poll::poll(&mut fds, timeout) {
                    Ok(_) | Err(nix::errno::Errno::EINTR) => {}
                    Err(errno) => return Err(std::io::Error::from(errno)),
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

/// The per-terminal writer thread. A write error marks the queue failed and
/// asks the relay loop to close the terminal; it never closes it itself.
#[cfg(unix)]
fn pump_input(
    mut writer: filedescriptor::FileDescriptor,
    input: Arc<InputQueue>,
    tx: SyncSender<FromWorker>,
    stop: Arc<AtomicBool>,
    terminal_id: String,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        while let Some(chunk) = input.next(&stop) {
            let result = write_polled(&mut writer, &chunk, &stop);
            input.written(chunk.len());
            match result {
                Ok(true) => {}
                Ok(false) => return,
                Err(error) => {
                    tracing::debug!(error = %error, terminal_id, "terminal input write failed");
                    input.fail();
                    send_note(&tx, FromWorker::TerminalWriteFailed { terminal_id }, &stop);
                    return;
                }
            }
        }
    })
}

#[cfg(unix)]
pub(super) struct PtyRuntime {
    /// Registered with the subreaper, so its scan never reaps the shell.
    pub(super) child: crate::subreaper::Owned<Box<dyn portable_pty::Child + Send + Sync>>,
    pub(super) master: Box<dyn portable_pty::MasterPty + Send>,
    input: Arc<InputQueue>,
    writer: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    pub(super) pid: Option<u32>,
    /// The shell (or guard) as it was when it was spawned, so no signal or session kill after it
    /// was reaped reaches a process that got its pid back.
    leader: Option<crate::process_list::Process>,
    /// It runs a launch guard (an operator command): close sends it SIGTERM and never kills its
    /// session, so its lock outlasts what the command started.
    pub(super) guarded: bool,
    /// Dropped after `shutdown_pty` has killed and reaped the session.
    _tracked: Option<LiveChildGuard>,
}

/// End a terminal's process and its session. `exited`: the status `poll` already reaped
/// (`TerminalPhase::Exited`); `None` while it runs.
#[cfg(unix)]
pub(super) fn shutdown_pty(
    mut runtime: PtyRuntime,
    exited: Option<(Option<i32>, Option<i32>)>,
) -> (Option<i32>, Option<i32>) {
    runtime.stop.store(true, Ordering::SeqCst);
    runtime.input.close();
    if runtime.guarded {
        return shutdown_guard_pty(runtime, exited);
    }
    if let Some(shell) = runtime.leader {
        // A shell that `poll` already reaped is not signalled by pid again.
        end_shell_session(shell, exited.is_none());
    }
    // The reader and writer notice `stop` within their poll timeout. Joining
    // either would block: the reader while a background job still holds the
    // slave, the writer while the PTY input buffer is full.
    drop(runtime.writer.take());
    drop(runtime.reader.take());
    let status = exited.unwrap_or_else(|| reap_after_signal(runtime.pid));
    drop(runtime.child);
    drop(runtime.master);
    status
}

#[cfg(unix)]
impl PtyRuntime {
    /// The shell's exit status once it has exited (reaping it).
    pub(super) fn reap(&mut self) -> Option<(Option<i32>, Option<i32>)> {
        let (code, signal) = reap_pid(self.pid);
        (code.is_some() || signal.is_some()).then_some((code, signal))
    }

    /// Queues input for the writer thread. `Ok(false)`: the queue is full.
    pub(super) fn push_input(&self, bytes: Vec<u8>) -> std::io::Result<bool> {
        self.input.push(bytes)
    }

    pub(super) fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        self.master
            .resize(portable_pty::PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| std::io::Error::other(error.to_string()))
    }
}

/// A Windows terminal: the `wsmp __conpty-host` helper, which owns the
/// pseudoconsole and the shell, in a kill-on-close job of its own.
#[cfg(windows)]
pub(super) struct PtyRuntime {
    /// Ending its job ends the helper, the shell and all they started.
    child: crate::job_tree::Child,
    input: Arc<InputQueue>,
    writer: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    /// Lets a forced shutdown end the job from another thread.
    _tracked: LiveChildGuard,
}

#[cfg(windows)]
impl PtyRuntime {
    /// The shell's exit code once it has exited: the helper exits with it.
    pub(super) fn reap(&mut self) -> Option<(Option<i32>, Option<i32>)> {
        self.child.try_wait().ok().flatten().map(status_parts)
    }

    /// Queues input for the helper, framed. `Ok(false)`: the queue is full.
    pub(super) fn push_input(&self, bytes: Vec<u8>) -> std::io::Result<bool> {
        // An empty write has nothing to frame.
        if bytes.is_empty() {
            return Ok(true);
        }
        self.input
            .push(crate::commands::conpty_host::input_frame(&bytes))
    }

    /// The helper resizes its console between input frames, in order.
    pub(super) fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        self.input
            .push_control(crate::commands::conpty_host::resize_frame(cols, rows))
    }
}

/// As on Unix: `exited` is the status `poll` (or the EOF) already read.
#[cfg(windows)]
pub(super) fn shutdown_pty(
    mut runtime: PtyRuntime,
    exited: Option<(Option<i32>, Option<i32>)>,
) -> (Option<i32>, Option<i32>) {
    runtime.stop.store(true, Ordering::SeqCst);
    runtime.input.close();
    // Ending the job breaks both pipes, so neither thread stays blocked.
    // A failure here leaves the kill to the child's drop, which retries.
    let _ = runtime
        .child
        .ensure_terminated(Instant::now() + Duration::from_millis(200));
    drop(runtime.writer.take());
    drop(runtime.reader.take());
    exited.unwrap_or((None, None))
}

/// The per-terminal writer thread on Windows: input and resize frames reach
/// the helper's stdin in order. A write blocks while the shell is not
/// reading; closing the terminal ends the job, which breaks the pipe.
#[cfg(windows)]
fn pump_input(
    mut writer: std::process::ChildStdin,
    input: Arc<InputQueue>,
    tx: SyncSender<FromWorker>,
    stop: Arc<AtomicBool>,
    terminal_id: String,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        while let Some(chunk) = input.next(&stop) {
            let result = writer.write_all(&chunk).and_then(|()| writer.flush());
            input.written(chunk.len());
            if let Err(error) = result {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                tracing::debug!(error = %error, terminal_id, "terminal input write failed");
                input.fail();
                send_note(&tx, FromWorker::TerminalWriteFailed { terminal_id }, &stop);
                return;
            }
        }
    })
}

/// [`shutdown_pty`] of an operator command's launch guard. A guard still running gets SIGTERM
/// and ends its session itself, holding its lock until it has: a scan of its session can be
/// stale by the time a kill lands (the guard may have started its command since), so its
/// session is never killed while it lives. One someone else killed left its session to this.
/// What has not ended by the time the terminal closes [`crate::launch_guard::linger`]s, so no
/// rank is proven idle before it has.
#[cfg(unix)]
fn shutdown_guard_pty(
    mut runtime: PtyRuntime,
    exited: Option<(Option<i32>, Option<i32>)>,
) -> (Option<i32>, Option<i32>) {
    drop(runtime.writer.take());
    drop(runtime.reader.take());
    let (Some(pid), Some(guard)) = (runtime.pid, runtime.leader) else {
        drop(runtime.child);
        drop(runtime.master);
        return exited.unwrap_or((None, None));
    };
    if exited.is_none() {
        // Unreaped, so the pid is still the guard's.
        crate::launch_guard::terminate_unreaped(guard);
    }
    let status = exited.unwrap_or_else(|| reap_after_signal(Some(pid)));
    drop(runtime.master);
    match status {
        (None, None) => {
            // Still ending its session. The child stays owned (the subreaper leaves it alone)
            // until it is reaped here.
            let child = runtime.child;
            let mut reaped = false;
            crate::launch_guard::linger(move || {
                let _owned = &child;
                if !reaped {
                    match reap_guard(pid) {
                        GuardReap::Running => return false,
                        GuardReap::Exited | GuardReap::Gone => return true,
                        GuardReap::Killed => reaped = true,
                    }
                }
                crate::process_list::kill_session(guard).settled()
            });
        }
        (_, Some(_)) => {
            drop(runtime.child);
            crate::launch_guard::end_killed_session(guard);
        }
        (Some(_), None) => drop(runtime.child),
    }
    status
}

/// What a non-blocking reap of a guard found.
#[cfg(unix)]
enum GuardReap {
    Running,
    /// It exited, so it ended its session itself.
    Exited,
    /// Someone else's signal killed it: its session is left to the caller.
    Killed,
    /// Not our child any more (reaped elsewhere).
    Gone,
}

#[cfg(unix)]
fn reap_guard(pid: u32) -> GuardReap {
    use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
    let Ok(raw) = i32::try_from(pid) else {
        return GuardReap::Gone;
    };
    match waitpid(nix::unistd::Pid::from_raw(raw), Some(WaitPidFlag::WNOHANG)) {
        Ok(WaitStatus::Exited(..)) => GuardReap::Exited,
        Ok(WaitStatus::Signaled(..)) => GuardReap::Killed,
        Err(nix::errno::Errno::ECHILD) => GuardReap::Gone,
        _ => GuardReap::Running,
    }
}

/// Borrows a raw descriptor long enough for `filedescriptor` to `dup` it.
/// The number stays valid because the `MasterPty` that owns it is still alive.
#[cfg(unix)]
pub(super) struct RawFdHandle(pub(super) std::os::fd::RawFd);

#[cfg(unix)]
impl std::os::fd::AsRawFd for RawFdHandle {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        self.0
    }
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_pty(
    program: &std::ffi::OsStr,
    args: &[String],
    cwd: &Path,
    env: &[(String, String)],
    cols: u16,
    rows: u16,
    tx: &SyncSender<FromWorker>,
    terminal_id: &str,
) -> anyhow::Result<PtyRuntime> {
    let system = portable_pty::native_pty_system();
    let pair = system.openpty(portable_pty::PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut command = portable_pty::CommandBuilder::new(program);
    command.env_clear();
    for arg in args {
        command.arg(arg);
    }
    command.cwd(cwd);
    for (name, value) in env {
        command.env(name, value);
    }
    // portable-pty's reader is a private fd with no safe `AsFd`. Opening
    // `/proc/self/fd/N` follows `/dev/ptmx` and allocates a different pty, so
    // duplicate the master with `dup(2)` and poll that copy. Do this before
    // spawn so a failed dup does not leave a child running.
    let raw = pair
        .master
        .as_raw_fd()
        .ok_or_else(|| anyhow::anyhow!("pty master has no file descriptor"))?;
    let reader = filedescriptor::FileDescriptor::dup(&RawFdHandle(raw))?;
    // The writer thread gets its own copy of the master and writes it
    // non-blocking, so a full PTY input buffer never pins that thread past
    // close. `O_NONBLOCK` is shared by every copy of the master; the reader
    // polls before it reads and treats `WouldBlock` as "try again".
    let writer = filedescriptor::FileDescriptor::dup(&RawFdHandle(raw))?;
    let flags = nix::fcntl::OFlag::from_bits_truncate(nix::fcntl::fcntl(
        &writer,
        nix::fcntl::FcntlArg::F_GETFL,
    )?);
    nix::fcntl::fcntl(
        &writer,
        nix::fcntl::FcntlArg::F_SETFL(flags | nix::fcntl::OFlag::O_NONBLOCK),
    )?;
    let child = crate::subreaper::spawn(
        || pair.slave.spawn_command(command),
        |child| child.process_id(),
    )?;
    let pid = child.process_id();
    // Not reaped yet: the pid is the shell's own.
    let leader = pid.map(crate::process_list::Process::of);
    let guarded = args
        .first()
        .is_some_and(|arg| arg == crate::launch_guard::SUBCOMMAND);
    let tracked = leader.map(|leader| {
        LiveChildGuard::track(if guarded {
            LiveChild::GuardSession(leader)
        } else {
            LiveChild::PtySession(leader)
        })
    });
    let stop = Arc::new(AtomicBool::new(false));
    let input = Arc::new(InputQueue::new());
    let writer_thread = pump_input(
        writer,
        Arc::clone(&input),
        tx.clone(),
        Arc::clone(&stop),
        terminal_id.to_string(),
    );
    let terminal_id = terminal_id.to_string();
    let eof_id = terminal_id.clone();
    let thread = pump_polled(
        reader,
        tx.clone(),
        Arc::clone(&stop),
        move |bytes| FromWorker::TerminalBytes {
            terminal_id: terminal_id.clone(),
            bytes,
        },
        move || FromWorker::TerminalEof {
            terminal_id: eof_id.clone(),
        },
    );
    Ok(PtyRuntime {
        child,
        master: pair.master,
        input,
        writer: Some(writer_thread),
        reader: Some(thread),
        stop,
        pid,
        leader,
        guarded,
        _tracked: tracked,
    })
}

/// Starts the `wsmp __conpty-host` helper for one terminal, in a
/// kill-on-close job, with the shell's environment and working directory.
#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_pty(
    program: &std::ffi::OsStr,
    args: &[String],
    cwd: &Path,
    env: &[(String, String)],
    cols: u16,
    rows: u16,
    tx: &SyncSender<FromWorker>,
    terminal_id: &str,
) -> anyhow::Result<PtyRuntime> {
    spawn_conpty(
        program,
        args,
        false,
        cwd,
        env,
        (cols, rows),
        tx,
        terminal_id,
    )
}

/// [`spawn_pty`] for `program` with `tail` as the rest of its command line, as is
/// (`cmd.exe /d /s /c "..."`).
#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_pty_raw(
    program: &std::ffi::OsStr,
    tail: &str,
    cwd: &Path,
    env: &[(String, String)],
    cols: u16,
    rows: u16,
    tx: &SyncSender<FromWorker>,
    terminal_id: &str,
) -> anyhow::Result<PtyRuntime> {
    spawn_conpty(
        program,
        &[tail.to_string()],
        true,
        cwd,
        env,
        (cols, rows),
        tx,
        terminal_id,
    )
}

#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
fn spawn_conpty(
    program: &std::ffi::OsStr,
    args: &[String],
    raw: bool,
    cwd: &Path,
    env: &[(String, String)],
    (cols, rows): (u16, u16),
    tx: &SyncSender<FromWorker>,
    terminal_id: &str,
) -> anyhow::Result<PtyRuntime> {
    use anyhow::Context;

    let mut command =
        crate::commands::conpty_host::command(program, args, raw, cols, rows, cwd, env)?;
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = crate::job_tree::spawn(command).context("starting the console host")?;
    let tracked = LiveChildGuard::track(LiveChild::ExecJob(child.job()));
    let writer = child
        .stdin
        .take()
        .context("the console host has no stdin")?;
    let reader = child
        .stdout
        .take()
        .context("the console host has no stdout")?;
    let stop = Arc::new(AtomicBool::new(false));
    let input = Arc::new(InputQueue::new());
    let writer_thread = pump_input(
        writer,
        Arc::clone(&input),
        tx.clone(),
        Arc::clone(&stop),
        terminal_id.to_string(),
    );
    let terminal_id = terminal_id.to_string();
    let eof_id = terminal_id.clone();
    let reader_thread = pump_reader(
        reader,
        tx.clone(),
        Arc::clone(&stop),
        move |bytes| FromWorker::TerminalBytes {
            terminal_id: terminal_id.clone(),
            bytes,
        },
        move || FromWorker::TerminalEof {
            terminal_id: eof_id.clone(),
        },
    );
    Ok(PtyRuntime {
        child,
        input,
        writer: Some(writer_thread),
        reader: Some(reader_thread),
        stop,
        _tracked: tracked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::sessions::test_support::channel;
    #[cfg(unix)]
    use std::time::Duration;

    #[test]
    fn input_queue_drops_past_the_limit_and_accepts_again_once_written() {
        let queue = InputQueue::new();
        assert!(queue.push(vec![0; INPUT_QUEUE_LIMIT]).expect("push"));
        assert!(!queue.push(vec![0; 1]).expect("full"));
        let stop = AtomicBool::new(false);
        let chunk = queue.next(&stop).expect("chunk");
        // Still in flight: in-flight bytes count against the limit.
        assert!(!queue.push(vec![0; 1]).expect("in flight"));
        queue.written(chunk.len());
        assert!(queue.push(vec![0; 1]).expect("room again"));
        queue.close();
        assert!(queue.push(vec![0; 1]).is_err());
        assert!(queue.next(&stop).is_none());
    }

    #[test]
    #[cfg(unix)]
    fn a_writer_error_asks_the_relay_loop_to_close_the_terminal() {
        let pipe = filedescriptor::Pipe::new().expect("pipe");
        drop(pipe.read);
        let (tx, rx) = channel();
        let input = Arc::new(InputQueue::new());
        let stop = Arc::new(AtomicBool::new(false));
        let _writer = pump_input(
            pipe.write,
            Arc::clone(&input),
            tx,
            Arc::clone(&stop),
            "broken".to_string(),
        );
        assert!(input.push(b"hello".to_vec()).expect("queued"));
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(FromWorker::TerminalWriteFailed { terminal_id }) => {
                assert_eq!(terminal_id, "broken");
            }
            _ => panic!("the writer did not report its failure"),
        }
        assert!(input.push(b"more".to_vec()).is_err());
        stop.store(true, Ordering::SeqCst);
    }
}
