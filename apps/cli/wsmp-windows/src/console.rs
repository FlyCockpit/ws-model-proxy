//! Console input echo suppression for local secret prompts.

use std::io;
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Console::{
    ENABLE_ECHO_INPUT, GetConsoleMode, GetStdHandle, STD_INPUT_HANDLE, SetConsoleMode,
};

/// Disables console input echo and restores the exact original mode on drop.
/// The standard input handle is borrowed, never closed by this guard.
pub struct EchoOff {
    handle: HANDLE,
    saved: u32,
}

impl EchoOff {
    /// Suppress echo on standard input. `None` means this is not a Win32
    /// console (for example an MSYS pty); the caller must warn before reading.
    /// Failure to change a console's mode still prevents the secret being read.
    pub fn stdin() -> io::Result<Option<Self>> {
        // SAFETY: STD_INPUT_HANDLE is a valid standard-handle selector.
        let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        Self::for_handle(handle)
    }

    fn for_handle(handle: HANDLE) -> io::Result<Option<Self>> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Ok(None);
        }
        let mut saved = 0;
        // SAFETY: GetConsoleMode checks the borrowed handle; saved is a valid
        // writable output pointer for the duration of this call.
        if unsafe { GetConsoleMode(handle, &mut saved) } == 0 {
            return Ok(None);
        }
        // SAFETY: the console handle was validated above; only the echo flag
        // is removed from the mode returned by GetConsoleMode.
        if unsafe { SetConsoleMode(handle, saved & !ENABLE_ECHO_INPUT) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Some(Self { handle, saved }))
    }
}

impl Drop for EchoOff {
    fn drop(&mut self) {
        // SAFETY: the standard console handle is borrowed for this prompt and
        // remains open; saved is the exact mode returned by GetConsoleMode.
        let _ = unsafe { SetConsoleMode(self.handle, self.saved) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::AsRawHandle;

    #[test]
    fn echo_guard_identifies_non_console_handles_for_visible_input_fallback() {
        assert!(
            EchoOff::for_handle(std::ptr::null_mut())
                .expect("null handle")
                .is_none()
        );
        assert!(
            EchoOff::for_handle(INVALID_HANDLE_VALUE)
                .expect("invalid handle")
                .is_none()
        );
        let file = std::fs::File::open(std::env::current_exe().expect("exe")).expect("file");
        assert!(
            EchoOff::for_handle(file.as_raw_handle())
                .expect("file handle")
                .is_none()
        );
    }

    #[test]
    fn echo_guard_restores_console_mode_when_a_console_is_available() {
        let Ok(console) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("CONIN$")
        else {
            return; // A headless Windows test runner need not have a console.
        };
        let handle = console.as_raw_handle();
        let mut before = 0;
        // SAFETY: console owns a live handle; before is a writable mode pointer.
        assert_ne!(unsafe { GetConsoleMode(handle, &mut before) }, 0);
        {
            let _guard = EchoOff::for_handle(handle)
                .expect("echo off")
                .expect("console guard");
            let mut during = 0;
            // SAFETY: console remains open; during is a writable mode pointer.
            assert_ne!(unsafe { GetConsoleMode(handle, &mut during) }, 0);
            assert_eq!(during & ENABLE_ECHO_INPUT, 0);
        }
        let mut after = 0;
        // SAFETY: console remains open; after is a writable mode pointer.
        assert_ne!(unsafe { GetConsoleMode(handle, &mut after) }, 0);
        assert_eq!(after, before);
    }
}
