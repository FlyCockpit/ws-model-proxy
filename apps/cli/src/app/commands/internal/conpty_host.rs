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

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use clap::Args as ClapArgs;

use crate::process::conpty_link::{Frame, read_frame};

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
    /// The one argument after the shell is the rest of its command line, passed as is
    /// (`cmd.exe`'s `/d /s /c "..."`, which does not split arguments the way they are quoted).
    #[arg(long)]
    pub raw: bool,
    /// The shell program, then its arguments.
    #[arg(required = true, num_args = 1.., last = true)]
    pub command: Vec<OsString>,
}

/// A Windows command line for `program` and `args`, quoted the way
/// `CommandLineToArgvW` and the MSVC runtime split it.
pub(crate) fn command_line(program: &OsString, args: &[OsString]) -> OsString {
    let mut line = OsString::new();
    for (index, part) in std::iter::once(program).chain(args).enumerate() {
        if index > 0 {
            line.push(" ");
        }
        line.push(quote(part));
    }
    line
}

/// `program`, then the one argument after it as is.
fn raw_command_line(program: &OsString, rest: &[OsString]) -> Result<OsString> {
    let [tail] = rest else {
        anyhow::bail!("a raw command line is one argument");
    };
    let mut line = quote(program);
    line.push(" ");
    line.push(tail);
    Ok(line)
}

/// `arg` quoted for the command line, as the OS string it is: on Windows its UTF-16 units go
/// through as they are (a path with an unpaired surrogate keeps it, never turned into U+FFFD).
/// Quoting only looks at ASCII units (space, tab, newline, vertical tab, `"`, `\\`).
fn quote(arg: &std::ffi::OsStr) -> OsString {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        OsString::from_wide(&quote_units(&arg.encode_wide().collect::<Vec<_>>()))
    }
    #[cfg(not(windows))]
    {
        // No console host runs here (tests only); text is quoted the same way.
        let units: Vec<u16> = arg.to_string_lossy().encode_utf16().collect();
        OsString::from(String::from_utf16_lossy(&quote_units(&units)))
    }
}

fn quote_units(arg: &[u16]) -> Vec<u16> {
    const BACKSLASH: u16 = b'\\' as u16;
    const QUOTE: u16 = b'"' as u16;
    let special = |unit: &u16| {
        [b' ', b'\t', b'\n', 0x0b, b'"']
            .iter()
            .any(|ch| u16::from(*ch) == *unit)
    };
    if !arg.is_empty() && !arg.iter().any(special) {
        return arg.to_vec();
    }
    let mut quoted = vec![QUOTE];
    let mut backslashes = 0;
    for &unit in arg {
        match unit {
            BACKSLASH => backslashes += 1,
            QUOTE => {
                // Backslashes before a quote are doubled, and the quote escaped.
                quoted.extend(std::iter::repeat_n(BACKSLASH, backslashes * 2 + 1));
                quoted.push(QUOTE);
                backslashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat_n(BACKSLASH, backslashes));
                quoted.push(unit);
                backslashes = 0;
            }
        }
    }
    // Backslashes before the closing quote are doubled.
    quoted.extend(std::iter::repeat_n(BACKSLASH, backslashes * 2));
    quoted.push(QUOTE);
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
        .spawn(&if args.raw {
            raw_command_line(program, rest)?
        } else {
            command_line(program, rest)
        })
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
    use crate::process::conpty_link::TEST_ARGS;

    /// The helper, when a terminal test started this binary as one (see
    /// [`command`](crate::process::conpty_link::command)). Does nothing in a normal test run.
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
