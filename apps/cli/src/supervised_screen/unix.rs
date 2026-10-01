use anyhow::{Context, Result};

use super::Screen;

/// Time for the screen to reach the browser before keys count.
const SETTLE: std::time::Duration = std::time::Duration::from_millis(300);
const RESIZE_CHECK_MS: i64 = 100;

/// The deliberately small fallback used when the PTY size cannot be read.
pub(crate) const UNKNOWN_SIZE: (usize, usize) = (40, 16);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConfirmAction<'a> {
    /// Enter emits `accepted`, waits for the exact `go` token, and returns.
    Apply,
    /// Enter or a decline key dismisses and emits one blocked marker; none accepts.
    Blocked(&'a str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConfirmOutcome {
    Accepted,
    Declined,
    Dismissed,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Wake {
    Input,
    Resized((usize, usize)),
}

pub(crate) fn wait_for_input_or_resize(
    input: std::os::fd::BorrowedFd<'_>,
    current: (usize, usize),
    mut measure: impl FnMut() -> (usize, usize),
) -> nix::Result<Wake> {
    use std::os::fd::AsRawFd;

    use nix::errno::Errno;
    use nix::sys::select::{FD_SETSIZE, FdSet, select};
    use nix::sys::time::{TimeVal, TimeValLike};

    if usize::try_from(input.as_raw_fd()).map_or(true, |fd| fd >= FD_SETSIZE) {
        return Err(Errno::EBADF);
    }
    loop {
        let mut readable = FdSet::new();
        readable.insert(input);
        let mut timeout = TimeVal::milliseconds(RESIZE_CHECK_MS);
        let ready = match select(None, &mut readable, None, None, &mut timeout) {
            Ok(count) => count > 0 && readable.contains(input),
            Err(Errno::EINTR) => false,
            Err(error) => return Err(error),
        };
        let size = measure();
        if size != current {
            return Ok(Wake::Resized(size));
        }
        if ready {
            return Ok(Wake::Input);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Key {
    Run,
    Decline,
    Scroll(isize),
    PageUp,
    PageDown,
    Top,
    Bottom,
    Ignore,
}

#[derive(Debug, Default)]
pub(crate) struct KeyReader {
    state: KeyState,
    params: Vec<u8>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum KeyState {
    #[default]
    Ground,
    Escape,
    Csi,
    Ss3,
}

impl KeyReader {
    fn plain(byte: u8) -> Key {
        match byte {
            b'\r' | b'\n' => Key::Run,
            0x03 | 0x04 | b'q' | b'Q' => Key::Decline,
            b'j' => Key::Scroll(1),
            b'k' => Key::Scroll(-1),
            b' ' => Key::PageDown,
            b'b' => Key::PageUp,
            b'g' => Key::Top,
            b'G' => Key::Bottom,
            _ => Key::Ignore,
        }
    }

    pub(crate) fn feed(&mut self, byte: u8) -> Key {
        match self.state {
            KeyState::Ground => {
                if byte == 0x1b {
                    self.state = KeyState::Escape;
                    Key::Ignore
                } else {
                    Self::plain(byte)
                }
            }
            KeyState::Escape => match byte {
                b'[' => {
                    self.state = KeyState::Csi;
                    self.params.clear();
                    Key::Ignore
                }
                b'O' => {
                    self.state = KeyState::Ss3;
                    Key::Ignore
                }
                0x1b => Key::Ignore,
                _ => {
                    self.state = KeyState::Ground;
                    Self::plain(byte)
                }
            },
            KeyState::Csi => match byte {
                0x20..=0x3f if self.params.len() < 16 => {
                    self.params.push(byte);
                    Key::Ignore
                }
                0x40..=0x7e => {
                    self.state = KeyState::Ground;
                    match (byte, self.params.as_slice()) {
                        (b'A', _) => Key::Scroll(-1),
                        (b'B', _) => Key::Scroll(1),
                        (b'H', _) | (b'~', b"1" | b"7") => Key::Top,
                        (b'F', _) | (b'~', b"4" | b"8") => Key::Bottom,
                        (b'~', b"5") => Key::PageUp,
                        (b'~', b"6") => Key::PageDown,
                        _ => Key::Ignore,
                    }
                }
                _ => {
                    self.state = KeyState::Ground;
                    if byte < 0x20 {
                        Self::plain(byte)
                    } else {
                        Key::Ignore
                    }
                }
            },
            KeyState::Ss3 => {
                self.state = KeyState::Ground;
                match byte {
                    b'A' => Key::Scroll(-1),
                    b'B' => Key::Scroll(1),
                    b'H' => Key::Top,
                    b'F' => Key::Bottom,
                    _ if byte < 0x20 => Self::plain(byte),
                    _ => Key::Ignore,
                }
            }
        }
    }
}

pub(crate) fn scrolled(screen: &Screen, key: Key) -> Option<usize> {
    let page = screen.height.saturating_sub(1).max(1);
    let next = match key {
        Key::Scroll(delta) => screen.offset.saturating_add_signed(delta),
        Key::PageUp => screen.offset.saturating_sub(page),
        Key::PageDown => screen.offset.saturating_add(page),
        Key::Top => 0,
        Key::Bottom => screen.max_offset,
        Key::Run | Key::Decline | Key::Ignore => return None,
    };
    Some(next.min(screen.max_offset))
}

pub(crate) struct TokenMatcher<'a> {
    token: &'a [u8],
    matched: usize,
}

impl<'a> TokenMatcher<'a> {
    pub(crate) fn new(token: &'a [u8]) -> Self {
        Self { token, matched: 0 }
    }

    pub(crate) fn feed(&mut self, byte: u8) -> bool {
        if self.token.get(self.matched) == Some(&byte) {
            self.matched += 1;
        } else {
            self.matched = usize::from(self.token.first() == Some(&byte));
        }
        self.matched == self.token.len()
    }
}

fn terminal_size() -> (usize, usize) {
    terminal_size::terminal_size_of(std::io::stdout())
        .or_else(|| terminal_size::terminal_size_of(std::io::stdin()))
        .map_or(UNKNOWN_SIZE, |(width, height)| {
            (usize::from(width.0), usize::from(height.0))
        })
}

pub(crate) struct RawMode<F: std::os::fd::AsFd> {
    fd: F,
    original: nix::sys::termios::Termios,
}

impl<F: std::os::fd::AsFd> RawMode<F> {
    pub(crate) fn enter(
        fd: F,
        make_raw: impl FnOnce(&mut nix::sys::termios::Termios),
    ) -> Result<Self> {
        use nix::sys::termios::{self, SetArg};
        let original = termios::tcgetattr(&fd).context("reading terminal settings")?;
        let mut raw = original.clone();
        make_raw(&mut raw);
        let guard = Self { fd, original };
        termios::tcsetattr(&guard.fd, SetArg::TCSANOW, &raw).context("entering raw mode")?;
        Ok(guard)
    }

    pub(crate) fn fd(&self) -> &F {
        &self.fd
    }

    pub(crate) fn original(&self) -> &nix::sys::termios::Termios {
        &self.original
    }

    pub(crate) fn restore(self) {
        drop(self);
    }
}

impl<F: std::os::fd::AsFd> Drop for RawMode<F> {
    fn drop(&mut self) {
        use nix::sys::termios::{self, SetArg};
        let _ = termios::tcsetattr(&self.fd, SetArg::TCSANOW, &self.original);
    }
}

pub(crate) fn confirm_raw_mode(raw: &mut nix::sys::termios::Termios) {
    use nix::sys::termios::{InputFlags, LocalFlags, SpecialCharacterIndices};
    raw.local_flags
        .remove(LocalFlags::ICANON | LocalFlags::ECHO | LocalFlags::ISIG | LocalFlags::IEXTEN);
    raw.input_flags.remove(InputFlags::IXON | InputFlags::ICRNL);
    raw.control_chars[SpecialCharacterIndices::VMIN as usize] = 1;
    raw.control_chars[SpecialCharacterIndices::VTIME as usize] = 0;
}

pub(crate) fn restore_terminal_on_panic<F>(fd: F, original: nix::sys::termios::Termios)
where
    F: std::os::fd::AsFd + Send + Sync + 'static,
{
    let original = std::sync::Mutex::new(original);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Ok(original) = original.lock() {
            let _ =
                nix::sys::termios::tcsetattr(&fd, nix::sys::termios::SetArg::TCSANOW, &original);
        }
        previous(info);
    }));
}

fn read_byte(stdin: &std::io::Stdin) -> Result<Option<u8>> {
    use std::os::fd::AsFd;
    let mut byte = [0_u8; 1];
    loop {
        match nix::unistd::read(stdin.as_fd(), &mut byte) {
            Ok(0) => return Ok(None),
            Ok(_) => return Ok(Some(byte[0])),
            Err(nix::errno::Errno::EINTR) => {}
            Err(error) => return Err(error).context("reading the confirm key"),
        }
    }
}

/// Draw, flush type-ahead, emit ready, and collect the authoritative decision.
pub(crate) fn interact(
    marker: &str,
    action: ConfirmAction<'_>,
    mut layout: impl FnMut(usize, usize, usize) -> Screen,
) -> Result<ConfirmOutcome> {
    use std::io::Write;
    use std::os::fd::AsFd;

    use nix::sys::termios::{self, FlushArg};

    let raw_mode = RawMode::enter(std::io::stdin(), confirm_raw_mode)?;
    restore_terminal_on_panic(std::io::stdin(), raw_mode.original().clone());
    let stdin = raw_mode.fd();
    let _ = termios::tcflush(stdin, FlushArg::TCIFLUSH);
    let mut stdout = std::io::stdout().lock();
    let mut size = terminal_size();
    let mut screen = layout(size.0, size.1, 0);
    stdout
        .write_all(screen.paint().as_bytes())
        .and_then(|()| stdout.flush())
        .context("drawing the confirm screen")?;
    std::thread::sleep(SETTLE);
    let _ = termios::tcflush(stdin, FlushArg::TCIFLUSH);
    stdout
        .write_all(&crate::sessions::supervised_marker("ready", marker))
        .and_then(|()| stdout.flush())
        .context("drawing the confirm screen")?;

    let mut keys = KeyReader::default();
    loop {
        match wait_for_input_or_resize(stdin.as_fd(), size, terminal_size)
            .context("waiting for the confirm key")?
        {
            Wake::Input => {}
            Wake::Resized(new_size) => {
                size = new_size;
                screen = layout(size.0, size.1, screen.offset);
                let _ = stdout
                    .write_all(screen.paint().as_bytes())
                    .and_then(|()| stdout.flush());
                continue;
            }
        }
        let byte = read_byte(stdin)?
            .ok_or_else(|| anyhow::anyhow!("terminal closed before the request was answered"))?;
        let key = keys.feed(byte);
        match (action, key) {
            (ConfirmAction::Apply, Key::Run) => break,
            (ConfirmAction::Apply, Key::Decline) => {
                raw_mode.restore();
                let _ = stdout.write_all(b"\r\nDeclined.\r\n");
                let _ = stdout.flush();
                return Ok(ConfirmOutcome::Declined);
            }
            (ConfirmAction::Blocked(code), Key::Run | Key::Decline) => {
                let kind = format!("blocked;{code}");
                let _ = stdout.write_all(b"\r\nDismissed.\r\n");
                let _ = stdout.write_all(&crate::sessions::supervised_marker(&kind, marker));
                let _ = stdout.flush();
                raw_mode.restore();
                return Ok(ConfirmOutcome::Dismissed);
            }
            _ => {
                if let Some(offset) = scrolled(&screen, key)
                    && offset != screen.offset
                {
                    screen = layout(size.0, size.1, offset);
                    let _ = stdout
                        .write_all(screen.paint().as_bytes())
                        .and_then(|()| stdout.flush());
                }
            }
        }
    }

    let _ = stdout.write_all(b"\r\n");
    let _ = stdout.write_all(&crate::sessions::supervised_marker("accepted", marker));
    let _ = stdout.flush();
    let go = crate::sessions::supervised_marker("go", marker);
    let mut matcher = TokenMatcher::new(&go);
    loop {
        match read_byte(stdin)? {
            Some(byte) if matcher.feed(byte) => break,
            Some(_) => {}
            None => anyhow::bail!("terminal closed before the request could start"),
        }
    }
    raw_mode.restore();
    drop(stdout);
    Ok(ConfirmOutcome::Accepted)
}

// Panic hooks are process-global; both confirm children share this test lock.
#[cfg(test)]
pub(crate) fn panic_tests_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nix::sys::termios::{LocalFlags, Termios, tcgetattr};

    fn assert_restored(before: &Termios, after: &Termios) {
        assert_eq!(before.input_flags, after.input_flags);
        assert_eq!(before.output_flags, after.output_flags);
        assert_eq!(before.control_flags, after.control_flags);
        assert_eq!(before.control_chars, after.control_chars);
        // BSD may set the kernel-state bit PENDIN on return to canonical mode.
        assert_eq!(
            before.local_flags.difference(LocalFlags::PENDIN),
            after.local_flags.difference(LocalFlags::PENDIN)
        );
    }

    #[test]
    fn gap_file_raw_guard_restores_on_early_return() {
        let pty = nix::pty::openpty(None, None).expect("pty");
        let before = tcgetattr(&pty.slave).expect("original settings");
        let early = || -> Result<()> {
            let guard = RawMode::enter(&pty.slave, confirm_raw_mode)?;
            assert!(
                !tcgetattr(guard.fd())?
                    .local_flags
                    .contains(LocalFlags::ICANON)
            );
            anyhow::bail!("file confirm input closed")
        };
        assert!(early().is_err());
        assert_restored(&before, &tcgetattr(&pty.slave).expect("restored settings"));
    }

    #[test]
    fn gap_file_raw_guard_restores_on_unwinding() {
        let _serial = panic_tests_lock();
        let pty = nix::pty::openpty(None, None).expect("pty");
        let before = tcgetattr(&pty.slave).expect("original settings");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let guard = RawMode::enter(&pty.slave, confirm_raw_mode).expect("raw");
            assert!(
                !tcgetattr(guard.fd())
                    .unwrap()
                    .local_flags
                    .contains(LocalFlags::ICANON)
            );
            panic!("file confirm unwinds");
        }));
        assert!(result.is_err());
        assert_restored(&before, &tcgetattr(&pty.slave).expect("restored settings"));
    }

    #[test]
    fn gap_file_panic_hook_restores_without_destructor() {
        let _serial = panic_tests_lock();
        let pty = nix::pty::openpty(None, None).expect("pty");
        let before = tcgetattr(&pty.slave).expect("original settings");
        let guard = RawMode::enter(&pty.slave, confirm_raw_mode).expect("raw");
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        restore_terminal_on_panic(pty.slave.try_clone().unwrap(), guard.original().clone());
        std::mem::forget(guard);
        assert!(
            !tcgetattr(&pty.slave)
                .unwrap()
                .local_flags
                .contains(LocalFlags::ICANON)
        );
        let result = std::panic::catch_unwind(|| panic!("file confirm abort simulation"));
        std::panic::set_hook(previous);
        assert!(result.is_err());
        assert_restored(
            &before,
            &tcgetattr(&pty.slave).expect("hook restored settings"),
        );
    }
}
