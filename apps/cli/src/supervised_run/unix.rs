//! The Unix side of `wsmp terminal supervised-run`: raw-mode key input,
//! the `ready`/`accepted` markers, the wait for the daemon's `go` token and
//! the final `exec`. Supervised commands need a Unix PTY, so none of this is
//! built elsewhere (the daemon refuses `term.spawn` there with `unsupported`).

use anyhow::{Context, Result};

use super::{Request, Screen, layout};
use crate::sessions::{
    SUPERVISED_ENV_COMMAND, SUPERVISED_ENV_MARKER, SUPERVISED_ENV_NAMES, SUPERVISED_ENV_REASON,
    SUPERVISED_ENV_REQUESTER, SUPERVISED_ENV_SHARE,
};

/// Time for the screen to reach the browser before keys count. Anything
/// typed meanwhile is flushed with the rest of the type-ahead.
const SETTLE: std::time::Duration = std::time::Duration::from_millis(300);

/// How often the key loop re-reads the terminal size while no key arrives.
///
/// The size is polled (a cheap ioctl) instead of waiting for SIGWINCH:
/// SIGWINCH is ignored by default, and on macOS a signal the process ignores
/// is discarded when it is sent, even while it is blocked, so `sigwait` never
/// sees it (XNU `psignal_internal` checks `p_sigignore` first). Only a real
/// handler would change that, which needs `unsafe`.
const RESIZE_CHECK_MS: i64 = 100;

/// Why [`wait_for_input_or_resize`] returned.
#[derive(Debug, PartialEq, Eq)]
enum Wake {
    /// A read on the input will not block.
    Input,
    /// The terminal now has this `(cols, rows)` size.
    Resized((usize, usize)),
}

/// Waits until `input` is readable or `measure` reports a size other than
/// `current`, whichever comes first (a resize wins a tie; the input stays
/// readable for the next call). Uses select(2), which supports ttys
/// everywhere, rather than poll(2), which on macOS only works for devices
/// with a kqueue filter. Nothing is read from `input`.
fn wait_for_input_or_resize(
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

/// The size assumed when the PTY size cannot be read. Small on purpose:
/// every row is narrower than 40 columns and there are at most 16 rows, so
/// on any terminal at least that big nothing wraps or scrolls away, and the
/// "not shown" notice and the Enter prompt stay on screen (the layout keeps
/// both at this size; see `an_unknown_size_still_shows_the_notice_and_prompt`).
pub(super) const UNKNOWN_SIZE: (usize, usize) = (40, 16);

fn required_env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| {
        format!(
            "`{name}` is not set; `wsmp terminal supervised-run` is started by the relay daemon"
        )
    })
}

/// The working directory as confirm-screen text. Fails closed (before
/// anything is drawn) instead of a lossy rendering: the daemon already refuses
/// a non-UTF-8 physical cwd, and this catches a directory swapped afterwards.
fn directory_text(path: std::path::PathBuf) -> Result<String> {
    path.into_os_string()
        .into_string()
        .map_err(|_| anyhow::anyhow!("the working directory is not valid UTF-8"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Key {
    Run,
    Decline,
    /// Scroll the body by this many rows (negative is up).
    Scroll(isize),
    PageUp,
    PageDown,
    Top,
    Bottom,
    Ignore,
}

/// Turns input bytes into keys. Escape sequences (arrows, PgUp/PgDn,
/// Home/End) are consumed whole, so none of their bytes can count as Enter
/// or `q`; a control byte inside one ends it and counts on its own.
#[derive(Debug, Default)]
struct KeyReader {
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

    fn feed(&mut self, byte: u8) -> Key {
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

/// The new body offset after `key`, or `None` if the key does not scroll.
fn scrolled(screen: &Screen, key: Key) -> Option<usize> {
    let page = screen.height.saturating_sub(1).max(1);
    let offset = screen.offset;
    let next = match key {
        Key::Scroll(delta) => offset.saturating_add_signed(delta),
        Key::PageUp => offset.saturating_sub(page),
        Key::PageDown => offset.saturating_add(page),
        Key::Top => 0,
        Key::Bottom => screen.max_offset,
        Key::Run | Key::Decline | Key::Ignore => return None,
    };
    Some(next.min(screen.max_offset))
}

/// Watches for the byte sequence `token` in a stream, one byte at a time.
struct TokenMatcher<'a> {
    token: &'a [u8],
    matched: usize,
}

impl<'a> TokenMatcher<'a> {
    fn new(token: &'a [u8]) -> Self {
        Self { token, matched: 0 }
    }

    /// True once the whole token has been seen. The token starts with ESC
    /// and holds no other ESC, so a mismatch restarts at that byte.
    fn feed(&mut self, byte: u8) -> bool {
        if self.token.get(self.matched) == Some(&byte) {
            self.matched += 1;
        } else {
            self.matched = usize::from(self.token.first() == Some(&byte));
        }
        self.matched == self.token.len()
    }
}

/// The PTY size as `(cols, rows)`, read from our terminal (an ioctl; no
/// process is started). If it cannot be read, a deliberately small size is
/// assumed so the drawn screen fits any real terminal at least that big.
fn terminal_size() -> (usize, usize) {
    terminal_size::terminal_size_of(std::io::stdout())
        .or_else(|| terminal_size::terminal_size_of(std::io::stdin()))
        .map_or(UNKNOWN_SIZE, |(width, height)| {
            (usize::from(width.0), usize::from(height.0))
        })
}

pub fn run() -> Result<()> {
    use std::io::Write;
    use std::os::fd::AsFd;
    use std::os::unix::process::CommandExt;

    use nix::sys::termios::{
        self, FlushArg, InputFlags, LocalFlags, SetArg, SpecialCharacterIndices,
    };

    let command = required_env(SUPERVISED_ENV_COMMAND)?;
    let reason = required_env(SUPERVISED_ENV_REASON)?;
    let requester = required_env(SUPERVISED_ENV_REQUESTER)?;
    let marker = required_env(SUPERVISED_ENV_MARKER)?;
    let share_output = match required_env(SUPERVISED_ENV_SHARE)?.as_str() {
        "1" => true,
        "0" => false,
        _ => anyhow::bail!("`{SUPERVISED_ENV_SHARE}` must be `0` or `1`"),
    };
    if command.is_empty() {
        anyhow::bail!("`{SUPERVISED_ENV_COMMAND}` is empty");
    }
    if marker.len() != 32 || !marker.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        anyhow::bail!("`{SUPERVISED_ENV_MARKER}` is malformed");
    }
    let directory =
        directory_text(std::env::current_dir().context("reading the working directory")?)?;
    let request = Request {
        requester: &requester,
        reason: &reason,
        directory: &directory,
        command: &command,
        share_output,
    };

    let stdin = std::io::stdin();
    let original = termios::tcgetattr(&stdin).context("reading terminal settings")?;
    let mut raw = original.clone();
    raw.local_flags
        .remove(LocalFlags::ICANON | LocalFlags::ECHO | LocalFlags::ISIG | LocalFlags::IEXTEN);
    raw.input_flags.remove(InputFlags::IXON | InputFlags::ICRNL);
    raw.control_chars[SpecialCharacterIndices::VMIN as usize] = 1;
    raw.control_chars[SpecialCharacterIndices::VTIME as usize] = 0;
    termios::tcsetattr(&stdin, SetArg::TCSANOW, &raw).context("entering raw mode")?;
    let restore = |stdin: &std::io::Stdin| {
        let _ = termios::tcsetattr(stdin, SetArg::TCSANOW, &original);
    };
    let _ = termios::tcflush(&stdin, FlushArg::TCIFLUSH);

    let mut stdout = std::io::stdout().lock();
    // Re-read by the key loop while it waits (see `RESIZE_CHECK_MS`).
    let mut size = terminal_size();
    let mut screen = layout(&request, size.0, size.1, 0);
    let drawn = stdout
        .write_all(screen.paint().as_bytes())
        .and_then(|()| stdout.flush());
    if let Err(error) = drawn {
        restore(&stdin);
        return Err(error).context("drawing the confirm screen");
    }
    // Keys pressed before the screen could be seen do not count.
    std::thread::sleep(SETTLE);
    let _ = termios::tcflush(&stdin, FlushArg::TCIFLUSH);
    let ready = stdout
        .write_all(&crate::sessions::supervised_marker("ready", &marker))
        .and_then(|()| stdout.flush());
    if let Err(error) = ready {
        restore(&stdin);
        return Err(error).context("drawing the confirm screen");
    }

    // Unbuffered one-byte reads: nothing past the deciding key is consumed.
    let read_byte = |stdin: &std::io::Stdin| -> Result<Option<u8>> {
        let mut byte = [0_u8; 1];
        loop {
            match nix::unistd::read(stdin.as_fd(), &mut byte) {
                Ok(0) => return Ok(None),
                Ok(_) => return Ok(Some(byte[0])),
                Err(nix::errno::Errno::EINTR) => {}
                Err(error) => return Err(error).context("reading the confirm key"),
            }
        }
    };

    let mut keys = KeyReader::default();
    'confirm: loop {
        match wait_for_input_or_resize(stdin.as_fd(), size, terminal_size) {
            Ok(Wake::Input) => {}
            Ok(Wake::Resized(new_size)) => {
                size = new_size;
                screen = layout(&request, size.0, size.1, screen.offset);
                let _ = stdout
                    .write_all(screen.paint().as_bytes())
                    .and_then(|()| stdout.flush());
                continue;
            }
            Err(error) => {
                restore(&stdin);
                return Err(error).context("waiting for the confirm key");
            }
        }
        let byte = match read_byte(&stdin) {
            Ok(Some(byte)) => byte,
            Ok(None) => {
                restore(&stdin);
                anyhow::bail!("terminal closed before the command was confirmed");
            }
            Err(error) => {
                restore(&stdin);
                return Err(error);
            }
        };
        let key = keys.feed(byte);
        match key {
            Key::Run => break 'confirm,
            Key::Decline => {
                restore(&stdin);
                let _ = stdout.write_all(b"\r\nDeclined.\r\n");
                let _ = stdout.flush();
                return Ok(());
            }
            _ => {
                if let Some(offset) = scrolled(&screen, key)
                    && offset != screen.offset
                {
                    screen = layout(&request, size.0, size.1, offset);
                    let _ = stdout
                        .write_all(screen.paint().as_bytes())
                        .and_then(|()| stdout.flush());
                }
            }
        }
    }

    // Enter: tell the daemon, then wait (still raw, no echo) for its go.
    let _ = stdout.write_all(b"\r\n");
    let _ = stdout.write_all(&crate::sessions::supervised_marker("accepted", &marker));
    let _ = stdout.flush();
    let go = crate::sessions::supervised_marker("go", &marker);
    let mut matcher = TokenMatcher::new(&go);
    loop {
        match read_byte(&stdin) {
            Ok(Some(byte)) => {
                if matcher.feed(byte) {
                    break;
                }
            }
            Ok(None) => {
                restore(&stdin);
                anyhow::bail!("terminal closed before the command could start");
            }
            Err(error) => {
                restore(&stdin);
                return Err(error);
            }
        }
    }
    restore(&stdin);
    drop(stdout);

    let (program, flag) = crate::child_env::exec_shell();
    let mut process = std::process::Command::new(program);
    process.arg(flag).arg(&command);
    for name in SUPERVISED_ENV_NAMES {
        process.env_remove(name);
    }
    let error = process.exec();
    let _ = crate::output::diagnostic(format!("wsmp: could not run the command: {error}"));
    std::process::exit(127);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervised_run::tests::request;

    #[test]
    fn directory_text_refuses_non_utf8_instead_of_rendering_it_lossily() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let bad = std::path::PathBuf::from(OsStr::from_bytes(b"/tmp/a\xff"));
        let error = directory_text(bad).expect_err("non-utf8 refused");
        assert!(error.to_string().contains("not valid UTF-8"), "{error}");
        assert_eq!(
            directory_text(std::path::PathBuf::from("/tmp/a\u{FFFD}")).expect("utf8"),
            "/tmp/a\u{FFFD}"
        );
    }

    #[test]
    fn keys_scroll_run_or_decline_and_escape_sequences_never_run() {
        let feed = |bytes: &[u8]| {
            let mut reader = KeyReader::default();
            bytes
                .iter()
                .map(|byte| reader.feed(*byte))
                .collect::<Vec<_>>()
        };
        assert_eq!(feed(b"\r"), vec![Key::Run]);
        assert_eq!(feed(b"\n"), vec![Key::Run]);
        for byte in [0x03, 0x04, b'q', b'Q'] {
            assert_eq!(feed(&[byte]), vec![Key::Decline]);
        }
        for byte in [b'y', 0x7f, b'x'] {
            assert_eq!(feed(&[byte]), vec![Key::Ignore]);
        }
        let last = |bytes: &[u8]| *feed(bytes).last().expect("a key");
        assert_eq!(last(b"\x1b[A"), Key::Scroll(-1));
        assert_eq!(last(b"\x1b[B"), Key::Scroll(1));
        assert_eq!(last(b"\x1bOA"), Key::Scroll(-1));
        assert_eq!(last(b"\x1b[5~"), Key::PageUp);
        assert_eq!(last(b"\x1b[6~"), Key::PageDown);
        assert_eq!(last(b"\x1b[H"), Key::Top);
        assert_eq!(last(b"\x1b[4~"), Key::Bottom);
        // Sequences ending in `q` or carrying Enter-like bytes do not act.
        assert!(!feed(b"\x1b[1;5q\x1b[M\x1bOM").contains(&Key::Run));
        assert!(!feed(b"\x1b[1;5q").contains(&Key::Decline));
        // A control byte inside a sequence ends it and counts on its own.
        assert_eq!(last(b"\x1b[1\r"), Key::Run);
        assert_eq!(last(b"\x1b\r"), Key::Run);
    }

    #[test]
    fn scrolling_stays_within_the_body() {
        let command = (0..100)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let screen = layout(&request(&command, "", false), 80, 24, 0);
        assert_eq!(scrolled(&screen, Key::Scroll(-1)), Some(0));
        assert_eq!(scrolled(&screen, Key::Scroll(1)), Some(1));
        assert_eq!(scrolled(&screen, Key::Bottom), Some(screen.max_offset));
        assert_eq!(scrolled(&screen, Key::PageDown), Some(screen.height - 1));
        assert_eq!(scrolled(&screen, Key::Run), None);
        let end = layout(&request(&command, "", false), 80, 24, screen.max_offset);
        assert_eq!(scrolled(&end, Key::PageDown), Some(end.max_offset));
    }

    #[test]
    fn the_go_token_is_found_among_other_bytes() {
        let token = crate::sessions::supervised_marker("go", "00112233445566778899aabbccddeeff");
        let mut matcher = TokenMatcher::new(&token);
        let mut stream = b"\r\x1b[Axx\x1b]7717;".to_vec();
        stream.extend(&token);
        let found = stream.iter().position(|byte| matcher.feed(*byte));
        assert_eq!(found, Some(stream.len() - 1));
        let mut other = TokenMatcher::new(&token);
        let wrong = crate::sessions::supervised_marker("go", "ffffffffffffffffffffffffffffffff");
        assert!(!wrong.iter().any(|byte| other.feed(*byte)));
    }

    #[test]
    fn a_resize_is_seen_while_no_key_arrives() {
        use std::os::fd::AsFd;

        // An open pipe with nothing written stands in for an idle terminal.
        let (idle, _writer) = std::io::pipe().expect("pipe");
        let mut checks = 0;
        let started = std::time::Instant::now();
        let wake = wait_for_input_or_resize(idle.as_fd(), (80, 24), || {
            checks += 1;
            if checks < 3 { (80, 24) } else { (40, 12) }
        })
        .expect("wait");
        assert_eq!(wake, Wake::Resized((40, 12)));
        assert_eq!(checks, 3);
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn waiting_leaves_a_ready_key_unread() {
        use std::io::{Read, Write};
        use std::os::fd::AsFd;

        let (mut reader, mut writer) = std::io::pipe().expect("pipe");
        writer.write_all(b"qx").expect("write");
        let wake = wait_for_input_or_resize(reader.as_fd(), (80, 24), || (80, 24)).expect("wait");
        assert_eq!(wake, Wake::Input);
        // A resize reported at the same time wins; the key is still there.
        let wake = wait_for_input_or_resize(reader.as_fd(), (80, 24), || (40, 12)).expect("wait");
        assert_eq!(wake, Wake::Resized((40, 12)));
        let mut both = [0_u8; 2];
        reader.read_exact(&mut both).expect("read");
        assert_eq!(&both, b"qx");
    }
}
