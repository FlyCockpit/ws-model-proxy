//! `wsmp __conpty-host`: the hidden helper behind a Windows browser terminal.
//!
//! The relay starts it in a kill-on-close job (`job_tree::spawn`), with
//! stdin and stdout piped. It creates a pseudoconsole and starts the shell on
//! it, so the shell and everything it starts are in the same job, and closing
//! the terminal (or the relay dying) ends all of them.
//!
//! - stdout carries the console's VT output, unframed.
//! - stdin carries frames from the relay: a kind byte, a little-endian `u32`
//!   length, then the payload. Kind 0 is input for the console; kind 1 is a
//!   resize (`u16` columns, `u16` rows, little-endian). When stdin ends, the
//!   relay is gone and the helper exits; the relay ends the job anyway.
//! - The exit code is the shell's.
//!
//! The shell inherits this helper's environment and working directory, which
//! the relay set (the scrubbed child environment and the user's home).

use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use clap::Args as ClapArgs;

const KIND_INPUT: u8 = 0;
const KIND_RESIZE: u8 = 1;
/// A frame larger than this is a protocol error, not input.
const FRAME_MAX: usize = 1024 * 1024;
/// After the shell exits, how long its last output may take to drain.
const OUTPUT_DRAIN: Duration = Duration::from_secs(2);

#[derive(Debug, ClapArgs)]
pub struct Args {
    /// Console width in cells.
    #[arg(long)]
    pub cols: u16,
    /// Console height in cells.
    #[arg(long)]
    pub rows: u16,
    /// The shell program, then its arguments.
    #[arg(required = true, num_args = 1.., last = true)]
    pub command: Vec<OsString>,
}

/// Unit tests run the test binary as the helper (see `tests::host_entry`),
/// passing the helper's arguments here, separated by U+001F.
#[cfg(test)]
const TEST_ARGS: &str = "WSMP_TEST_CONPTY_HOST_ARGS";

/// The helper for one terminal running `program` with `args` on a
/// `cols` x `rows` console, with `env` as its whole environment and `cwd`
/// as its directory (both of which the shell inherits).
pub(crate) fn command(
    program: &OsStr,
    args: &[String],
    cols: u16,
    rows: u16,
    cwd: &Path,
    env: &[(String, String)],
) -> Result<std::process::Command> {
    let exe = std::env::current_exe().context("finding the wsmp executable")?;
    let mut helper_args: Vec<OsString> = vec![
        "--cols".into(),
        cols.to_string().into(),
        "--rows".into(),
        rows.to_string().into(),
        "--".into(),
        program.to_os_string(),
    ];
    helper_args.extend(args.iter().map(OsString::from));
    let mut command = std::process::Command::new(exe);
    command.current_dir(cwd).env_clear();
    for (name, value) in env {
        command.env(name, value);
    }
    #[cfg(not(test))]
    command.arg("__conpty-host").args(&helper_args);
    #[cfg(test)]
    {
        let joined = helper_args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("\u{1f}");
        command
            .args([
                "--exact",
                "commands::conpty_host::tests::host_entry",
                "--nocapture",
                "--test-threads=1",
                "-q",
            ])
            .env(TEST_ARGS, joined);
    }
    Ok(command)
}

/// An input frame for the helper's stdin.
pub(crate) fn input_frame(bytes: &[u8]) -> Vec<u8> {
    frame(KIND_INPUT, bytes)
}

/// A resize frame for the helper's stdin.
pub(crate) fn resize_frame(cols: u16, rows: u16) -> Vec<u8> {
    let mut size = cols.to_le_bytes().to_vec();
    size.extend(rows.to_le_bytes());
    frame(KIND_RESIZE, &size)
}

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let len = u32::try_from(payload.len()).unwrap_or(u32::MAX);
    let mut bytes = Vec::with_capacity(5 + payload.len());
    bytes.push(kind);
    bytes.extend(len.to_le_bytes());
    bytes.extend(payload);
    bytes
}

#[derive(Debug, PartialEq, Eq)]
enum Frame {
    Input(Vec<u8>),
    Resize(u16, u16),
}

/// The next frame, `None` at a clean end of stream.
fn read_frame(reader: &mut impl Read) -> std::io::Result<Option<Frame>> {
    let mut header = [0_u8; 5];
    match reader.read_exact(&mut header[..1]) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    reader.read_exact(&mut header[1..])?;
    let len = usize::try_from(u32::from_le_bytes([
        header[1], header[2], header[3], header[4],
    ]))
    .unwrap_or(usize::MAX);
    if len > FRAME_MAX {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "conpty frame is too large",
        ));
    }
    let mut payload = vec![0_u8; len];
    reader.read_exact(&mut payload)?;
    match (header[0], payload.as_slice()) {
        (KIND_INPUT, _) => Ok(Some(Frame::Input(payload))),
        (KIND_RESIZE, [c0, c1, r0, r1]) => Ok(Some(Frame::Resize(
            u16::from_le_bytes([*c0, *c1]),
            u16::from_le_bytes([*r0, *r1]),
        ))),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unknown conpty frame",
        )),
    }
}

/// A Windows command line for `program` and `args`, quoted the way
/// `CommandLineToArgvW` and the MSVC runtime split it.
pub(crate) fn command_line(program: &OsString, args: &[OsString]) -> OsString {
    let mut line = OsString::new();
    for (index, part) in std::iter::once(program).chain(args).enumerate() {
        if index > 0 {
            line.push(" ");
        }
        line.push(quote(&part.to_string_lossy()));
    }
    line
}

fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{b}', '"']) {
        return arg.to_string();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                // Backslashes before a quote are doubled, and the quote escaped.
                quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat_n('\\', backslashes));
                quoted.push(ch);
                backslashes = 0;
            }
        }
    }
    // Backslashes before the closing quote are doubled.
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

pub fn run(args: &Args) -> Result<()> {
    let Some((program, rest)) = args.command.split_first() else {
        anyhow::bail!("no shell given");
    };
    let wsmp_windows::ConPty {
        console,
        input,
        mut output,
    } = wsmp_windows::PseudoConsole::open(args.cols, args.rows)
        .context("creating the pseudoconsole")?;
    let console = Arc::new(Mutex::new(Some(console)));
    let child = console
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .context("the pseudoconsole is closed")?
        .spawn(&command_line(program, rest))
        .with_context(|| format!("starting `{}`", PathBuf::from(program).display()))?;

    let pump = std::thread::spawn(move || {
        let mut stdout = std::io::stdout().lock();
        let mut buf = [0_u8; 8 * 1024];
        loop {
            match output.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(count) => {
                    if stdout.write_all(&buf[..count]).is_err() || stdout.flush().is_err() {
                        return;
                    }
                }
            }
        }
    });

    let input_console = Arc::clone(&console);
    std::thread::spawn(move || {
        let mut input = input;
        let mut stdin = std::io::stdin().lock();
        loop {
            match read_frame(&mut stdin) {
                Ok(Some(Frame::Input(bytes))) => {
                    if input.write_all(&bytes).is_err() {
                        break;
                    }
                }
                Ok(Some(Frame::Resize(cols, rows))) => {
                    if let Some(console) = input_console
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .as_ref()
                    {
                        let _ = console.resize(cols, rows);
                    }
                }
                Ok(None) | Err(_) => break,
            }
        }
        // The relay hung up (or sent garbage): nothing is left to serve.
        std::process::exit(1);
    });

    let code = child.wait().context("waiting for the shell")?;
    // Closing the console flushes what the shell wrote last and ends the
    // output pipe, so the pump finishes.
    drop(
        console
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take(),
    );
    let until = Instant::now() + OUTPUT_DRAIN;
    while !pump.is_finished() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = std::io::stdout().lock().flush();
    // Exit codes are `u32` on Windows; `exit` takes the same bits as `i32`.
    std::process::exit(i32::from_ne_bytes(code.to_ne_bytes()));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The helper, when a terminal test started this binary as one (see
    /// [`command`]). Does nothing in a normal test run.
    #[test]
    fn host_entry() {
        use clap::Parser;

        #[derive(Parser)]
        struct Host {
            #[command(flatten)]
            args: Args,
        }
        let Some(raw) = std::env::var_os(TEST_ARGS) else {
            return;
        };
        let raw = raw.to_string_lossy().into_owned();
        let host = Host::try_parse_from(std::iter::once("wsmp").chain(raw.split('\u{1f}')))
            .expect("helper arguments");
        run(&host.args).expect("helper");
    }

    #[test]
    fn frames_round_trip_and_garbage_is_refused() {
        let mut bytes = input_frame(b"dir\r");
        bytes.extend(resize_frame(120, 40));
        bytes.extend(input_frame(b""));
        let mut reader = bytes.as_slice();
        assert_eq!(
            read_frame(&mut reader).expect("input"),
            Some(Frame::Input(b"dir\r".to_vec()))
        );
        assert_eq!(
            read_frame(&mut reader).expect("resize"),
            Some(Frame::Resize(120, 40))
        );
        assert_eq!(
            read_frame(&mut reader).expect("empty"),
            Some(Frame::Input(Vec::new()))
        );
        assert_eq!(read_frame(&mut reader).expect("end"), None);

        for bad in [
            frame(7, b"x"),
            frame(KIND_RESIZE, b"abc"),
            vec![KIND_INPUT, 0xff, 0xff, 0xff, 0xff],
            vec![KIND_INPUT, 3, 0],
        ] {
            assert!(read_frame(&mut bad.as_slice()).is_err());
        }
    }

    #[test]
    fn command_lines_quote_like_the_msvc_runtime() {
        let line = command_line(
            &OsString::from(r"C:\Program Files\PowerShell\7\pwsh.exe"),
            &[
                OsString::from("-NoLogo"),
                OsString::from(""),
                OsString::from(r#"a "b" c"#),
                OsString::from(r"dir\"),
                OsString::from(r"with space\"),
            ],
        );
        assert_eq!(
            line,
            OsString::from(
                r#""C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo "" "a \"b\" c" dir\ "with space\\""#
            )
        );
    }
}
