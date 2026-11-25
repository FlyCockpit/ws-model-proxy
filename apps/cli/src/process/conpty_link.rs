//! The relay's side of the Windows ConPTY helper (`wsmp __conpty-host`):
//! the command that starts it for one terminal, and the frames on its stdin
//! (a kind byte, a little-endian `u32` length, then the payload; kind 0 is
//! console input, kind 1 a resize of `u16` columns and `u16` rows). The
//! helper command reads the same frames.

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::Path;

use anyhow::{Context, Result};

const KIND_INPUT: u8 = 0;
const KIND_RESIZE: u8 = 1;
/// A frame larger than this is a protocol error, not input.
const FRAME_MAX: usize = 1024 * 1024;

/// Unit tests run the test binary as the helper (see `crate::app::commands::internal::conpty_host` tests),
/// passing the helper's arguments here, separated by U+001F.
#[cfg(test)]
pub(crate) const TEST_ARGS: &str = "WSMP_TEST_CONPTY_HOST_ARGS";

/// The helper for one terminal running `program` with `args` on a
/// `cols` x `rows` console, with `env` as its whole environment and `cwd`
/// as its directory (both of which the shell inherits).
pub(crate) fn command(
    program: &OsStr,
    args: &[String],
    raw: bool,
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
    ];
    if raw {
        anyhow::ensure!(args.len() == 1, "a raw command line is one argument");
        helper_args.push("--raw".into());
    }
    helper_args.extend(["--".into(), program.to_os_string()]);
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
                "app::commands::internal::conpty_host::tests::host_entry",
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
pub(crate) enum Frame {
    Input(Vec<u8>),
    Resize(u16, u16),
}

/// The next frame, `None` at a clean end of stream.
pub(crate) fn read_frame(reader: &mut impl Read) -> std::io::Result<Option<Frame>> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
