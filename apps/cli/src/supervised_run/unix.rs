//! The Unix side of `wsmp terminal supervised-run`: raw-mode key input,
//! the `ready`/`accepted` markers, the wait for the daemon's `go` token and
//! the final `exec`. Supervised commands need a Unix PTY, so none of this is
//! built elsewhere (the daemon refuses `term.spawn` there with `unsupported`).

use anyhow::{Context, Result};

use super::{Request, layout};
use crate::sessions::{
    SUPERVISED_ENV_COMMAND, SUPERVISED_ENV_MARKER, SUPERVISED_ENV_NAMES, SUPERVISED_ENV_REASON,
    SUPERVISED_ENV_REQUESTER, SUPERVISED_ENV_SHARE,
};
#[cfg(test)]
pub(super) use crate::supervised_screen::UNKNOWN_SIZE;
use crate::supervised_screen::{ConfirmAction, ConfirmOutcome, interact};
#[cfg(test)]
use crate::supervised_screen::{
    Key, KeyReader, RawMode, TokenMatcher, Wake, confirm_raw_mode, restore_terminal_on_panic,
    scrolled, wait_for_input_or_resize,
};

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

pub fn run() -> Result<()> {
    use std::os::unix::process::CommandExt;

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

    match interact(&marker, ConfirmAction::Apply, |cols, rows, offset| {
        layout(&request, cols, rows, offset)
    })? {
        ConfirmOutcome::Accepted => {}
        ConfirmOutcome::Declined => return Ok(()),
        ConfirmOutcome::Dismissed => anyhow::bail!("apply screen returned a blocked outcome"),
    }

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

    fn local_flags(fd: &impl std::os::fd::AsFd) -> nix::sys::termios::LocalFlags {
        nix::sys::termios::tcgetattr(fd)
            .expect("reading pty settings")
            .local_flags
    }

    /// The two tests that panic on purpose: the panic hook one installs is
    /// process-global, so a sibling's panic must not run it mid-test.
    static PANIC_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn panic_tests_lock() -> std::sync::MutexGuard<'static, ()> {
        PANIC_TESTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[test]
    fn raw_mode_is_restored_when_the_run_panics() {
        use nix::sys::termios::LocalFlags;

        let _serial = panic_tests_lock();

        let pty = nix::pty::openpty(None, None).expect("opening a pty");
        let tty = pty.slave;
        let cooked = LocalFlags::ICANON | LocalFlags::ECHO | LocalFlags::ISIG;
        assert!(local_flags(&tty).contains(cooked));

        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let raw_mode = RawMode::enter(&tty, confirm_raw_mode).expect("entering raw mode");
            assert!(!local_flags(raw_mode.fd()).intersects(cooked));
            panic!("forced panic inside the supervised run");
        }));

        assert!(outcome.is_err());
        assert!(local_flags(&tty).contains(cooked));
    }

    #[test]
    fn the_panic_hook_restores_the_terminal_when_no_destructor_runs() {
        use nix::sys::termios::LocalFlags;

        let _serial = panic_tests_lock();

        let pty = nix::pty::openpty(None, None).expect("opening a pty");
        let tty = pty.slave;
        let hook_fd = tty.try_clone().expect("duplicating the pty fd");
        let raw_mode = RawMode::enter(&tty, confirm_raw_mode).expect("entering raw mode");
        restore_terminal_on_panic(hook_fd, raw_mode.original().clone());
        // What `panic = "abort"` does to the guard: its drop never runs.
        std::mem::forget(raw_mode);
        assert!(!local_flags(&tty).contains(LocalFlags::ICANON));

        let outcome = std::panic::catch_unwind(|| panic!("forced panic with no unwinding drop"));

        assert!(outcome.is_err());
        assert!(local_flags(&tty).contains(LocalFlags::ICANON | LocalFlags::ECHO));
    }

    #[test]
    fn raw_mode_is_restored_on_an_early_return() {
        use nix::sys::termios::LocalFlags;

        let pty = nix::pty::openpty(None, None).expect("opening a pty");
        let tty = pty.slave;
        let early = || -> Result<()> {
            let _raw_mode = RawMode::enter(&tty, confirm_raw_mode)?;
            anyhow::bail!("terminal closed before the command was confirmed")
        };
        assert!(early().is_err());
        assert!(local_flags(&tty).contains(LocalFlags::ICANON | LocalFlags::ECHO));
    }

    #[test]
    fn raw_mode_restore_puts_back_the_saved_settings_exactly() {
        let pty = nix::pty::openpty(None, None).expect("opening a pty");
        let tty = pty.slave;
        let before = nix::sys::termios::tcgetattr(&tty).expect("reading pty settings");
        let raw_mode = RawMode::enter(&tty, confirm_raw_mode).expect("entering raw mode");
        raw_mode.restore();
        let after = nix::sys::termios::tcgetattr(&tty).expect("reading pty settings");
        // PENDIN is kernel state, not a setting: BSD kernels (macOS) set it
        // when a terminal returns to canonical mode.
        let settings = |flags: nix::sys::termios::LocalFlags| {
            flags.difference(nix::sys::termios::LocalFlags::PENDIN)
        };
        assert_eq!(settings(after.local_flags), settings(before.local_flags));
        assert_eq!(after.input_flags, before.input_flags);
        assert_eq!(after.control_chars, before.control_chars);
    }

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
