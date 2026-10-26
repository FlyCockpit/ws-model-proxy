//! A Windows pseudoconsole (ConPTY) for browser terminals.
//!
//! The console is created with no flags. In particular it does not inherit
//! the cursor (`PSEUDOCONSOLE_INHERIT_CURSOR`): with that flag, conhost asks
//! the terminal for the cursor position on start and holds output back until
//! it gets an answer, which a browser that has not joined yet cannot give.
//!
//! As in the rest of the crate, each `unsafe` block is one Win32 call.

use std::ffi::OsStr;
use std::io::{self, PipeReader, PipeWriter};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsHandle, AsRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, S_OK, WAIT_OBJECT_0};
use windows_sys::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

use crate::imp::{check, raw};

fn coord(cols: u16, rows: u16) -> COORD {
    // A console is at most `i16::MAX` cells on either side.
    let side = |value: u16| i16::try_from(value.max(1)).unwrap_or(i16::MAX);
    COORD {
        X: side(cols),
        Y: side(rows),
    }
}

fn hresult(result: i32, what: &str) -> io::Result<()> {
    if result == S_OK {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{what} failed: HRESULT {result:#010x}"
        )))
    }
}

/// A pseudoconsole. Dropping it closes the console: programs attached to it
/// lose their console, and its output pipe reaches EOF once drained. The
/// output must keep being read until then, or closing can block.
#[derive(Debug)]
pub struct PseudoConsole {
    handle: HPCON,
}

/// What [`PseudoConsole::open`] returns: the console, the pipe its input is
/// written to, and the pipe its VT output is read from.
#[derive(Debug)]
pub struct ConPty {
    /// The console.
    pub console: PseudoConsole,
    /// Keystrokes and VT input for the console.
    pub input: PipeWriter,
    /// The console's rendered VT output.
    pub output: PipeReader,
}

impl PseudoConsole {
    /// Creates a console of `cols` x `rows` cells with its two pipes.
    pub fn open(cols: u16, rows: u16) -> io::Result<ConPty> {
        let (console_in, input) = io::pipe()?;
        let (output, console_out) = io::pipe()?;
        let mut handle: HPCON = 0;
        // SAFETY: two valid synchronous pipe handles, borrowed for the call
        // (the console duplicates them); `handle` is a valid out pointer.
        let result = unsafe {
            CreatePseudoConsole(
                coord(cols, rows),
                console_in.as_raw_handle(),
                console_out.as_raw_handle(),
                0,
                &mut handle,
            )
        };
        hresult(result, "CreatePseudoConsole")?;
        // The console holds its own copies of its pipe ends. Dropping ours
        // lets `output` reach EOF once the console closes.
        drop(console_in);
        drop(console_out);
        Ok(ConPty {
            console: Self { handle },
            input,
            output,
        })
    }

    /// Resizes the console to `cols` x `rows` cells.
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        // SAFETY: a live console handle owned by `self`.
        let result = unsafe { ResizePseudoConsole(self.handle, coord(cols, rows)) };
        hresult(result, "ResizePseudoConsole")
    }

    /// Starts `command_line` (program and quoted arguments, as `CreateProcessW`
    /// parses them) attached to this console. The child gets this process's
    /// environment and current directory, and inherits no handles.
    pub fn spawn(&self, command_line: &OsStr) -> io::Result<ConsoleChild> {
        let mut command_line: Vec<u16> = command_line.encode_wide().chain([0]).collect();
        if command_line[..command_line.len() - 1].contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "command line contains NUL",
            ));
        }
        let mut attributes = AttributeList::with_console(self.handle)?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = u32::try_from(size_of::<STARTUPINFOEXW>()).unwrap_or(u32::MAX);
        // Without explicit (invalid) standard handles, a console program can
        // pick up this process's redirected stdio instead of the console's.
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
        startup.lpAttributeList = attributes.as_mut_ptr();
        let mut info = PROCESS_INFORMATION::default();
        // SAFETY: `command_line` is a writable NUL-terminated UTF-16 buffer;
        // `startup` is a valid STARTUPINFOEXW (size set, flag
        // EXTENDED_STARTUPINFO_PRESENT) whose attribute list stays alive and
        // initialized for the call; null application name, security
        // attributes, environment and directory mean "parse the command line"
        // and "inherit"; no handles are inherited; `info` is a valid out
        // pointer.
        check(unsafe {
            CreateProcessW(
                null(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT,
                null(),
                null(),
                &raw const startup.StartupInfo,
                &mut info,
            )
        })?;
        drop(crate::imp::owned(info.hThread)?);
        Ok(ConsoleChild {
            process: crate::imp::owned(info.hProcess)?,
            pid: info.dwProcessId,
        })
    }
}

impl Drop for PseudoConsole {
    fn drop(&mut self) {
        // SAFETY: a live console handle owned by `self`, closed only here.
        unsafe { ClosePseudoConsole(self.handle) };
    }
}

/// A `PROC_THREAD_ATTRIBUTE_LIST` that attaches a child to a console.
struct AttributeList {
    // u64s so the buffer is pointer-aligned.
    buffer: Vec<u64>,
}

impl AttributeList {
    fn with_console(console: HPCON) -> io::Result<Self> {
        let mut size = 0_usize;
        // SAFETY: a size query (null list); `size` is a valid out pointer. It
        // fails with ERROR_INSUFFICIENT_BUFFER by design.
        unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size) };
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut list = Self {
            buffer: vec![0_u64; size.div_ceil(size_of::<u64>())],
        };
        // SAFETY: the buffer is writable for at least `size` bytes and
        // aligned; `size` is a valid in/out pointer.
        check(unsafe { InitializeProcThreadAttributeList(list.as_mut_ptr(), 1, 0, &mut size) })
            .inspect_err(|_| list.buffer.clear())?;
        // SAFETY: an initialized list with room for one attribute. The value
        // is the console handle itself (the attribute takes the HPCON by
        // value, so `lpValue` carries it and `cbSize` is its size), and the
        // console outlives every use of this list.
        check(unsafe {
            UpdateProcThreadAttribute(
                list.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                console as *const std::ffi::c_void,
                size_of::<HPCON>(),
                null_mut(),
                null(),
            )
        })?;
        Ok(list)
    }

    fn as_mut_ptr(&mut self) -> *mut std::ffi::c_void {
        self.buffer.as_mut_ptr().cast()
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if !self.buffer.is_empty() {
            // SAFETY: the list was initialized (an empty buffer marks a failed
            // initialization) and is deleted only here.
            unsafe { DeleteProcThreadAttributeList(self.as_mut_ptr()) };
        }
    }
}

/// A process started on a [`PseudoConsole`].
#[derive(Debug)]
pub struct ConsoleChild {
    process: OwnedHandle,
    pid: u32,
}

impl ConsoleChild {
    /// The process id.
    pub fn id(&self) -> u32 {
        self.pid
    }

    /// Waits for the process to exit and returns its exit code.
    pub fn wait(&self) -> io::Result<u32> {
        // SAFETY: a valid process handle owned by `self`, borrowed for the call.
        if unsafe { WaitForSingleObject(raw(self.process.as_handle()), INFINITE) } != WAIT_OBJECT_0
        {
            return Err(io::Error::last_os_error());
        }
        let mut code = 0_u32;
        // SAFETY: a valid process handle; `code` is a valid out pointer.
        check(unsafe { GetExitCodeProcess(raw(self.process.as_handle()), &mut code) })?;
        Ok(code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};

    /// Reads `output` on a thread until EOF, returning everything read.
    fn drain(mut output: PipeReader) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut all = Vec::new();
            let mut buf = [0_u8; 4096];
            while let Ok(count) = output.read(&mut buf) {
                if count == 0 {
                    break;
                }
                all.extend_from_slice(&buf[..count]);
            }
            all
        })
    }

    #[test]
    fn a_program_on_the_console_writes_vt_output_and_reports_its_exit_code() {
        let ConPty {
            console,
            input,
            output,
        } = PseudoConsole::open(80, 24).expect("open");
        let reader = drain(output);
        let child = console
            .spawn(OsStr::new("cmd.exe /D /C echo conpty-ok && exit 7"))
            .expect("spawn");
        assert!(child.id() > 0);
        assert_eq!(child.wait().expect("wait"), 7);
        drop(input);
        drop(console);
        let text = String::from_utf8_lossy(&reader.join().expect("reader")).into_owned();
        assert!(text.contains("conpty-ok"), "{text:?}");
        // No cursor-position request: nothing has to answer the console.
        assert!(!text.contains("\x1b[6n"), "{text:?}");
    }

    #[test]
    fn input_reaches_the_program_and_resizing_works() {
        let ConPty {
            console,
            mut input,
            output,
        } = PseudoConsole::open(80, 24).expect("open");
        let reader = drain(output);
        let child = console
            .spawn(OsStr::new("cmd.exe /D /Q /K"))
            .expect("spawn");
        console.resize(120, 40).expect("resize");
        input
            .write_all(b"echo typed-%COMSPEC:~0,0%ok\r")
            .expect("type");
        input.write_all(b"exit 3\r").expect("type exit");
        let started = Instant::now();
        let code = child.wait().expect("wait");
        assert!(started.elapsed() < Duration::from_secs(20));
        assert_eq!(code, 3);
        drop(input);
        drop(console);
        let text = String::from_utf8_lossy(&reader.join().expect("reader")).into_owned();
        assert!(text.contains("typed-ok"), "{text:?}");
    }

    #[test]
    fn a_nul_in_the_command_line_is_refused() {
        let ConPty { console, .. } = PseudoConsole::open(80, 24).expect("open");
        assert!(console.spawn(OsStr::new("cmd\0x")).is_err());
    }
}
