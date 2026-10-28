//! What the node file tools need about an open file and the process: the
//! file's identity and final path from its handle (so a check is made on the
//! object actually opened, not on a name that may have been swapped), a rename
//! that never replaces its destination, and whether this process is elevated
//! (the Windows stand-in for running as root).

use std::fs::File;
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsHandle, AsRawHandle};
use std::path::{Path, PathBuf};
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::{
    GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_NAME_NORMALIZED, GetFileInformationByHandle,
    GetFinalPathNameByHandleW, MoveFileExW, VOLUME_NAME_DOS,
};
use windows_sys::Win32::System::Threading::OpenProcessToken;

use crate::imp::{check, current_process, owned, raw};

/// A file's identity on this machine: two handles name the same file when
/// both values match (what `st_dev`/`st_ino` are on Unix).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    /// The volume's serial number.
    pub volume: u32,
    /// The file's index on that volume.
    pub index: u64,
    /// How many names (hard links) the file has.
    pub links: u32,
}

fn handle_of(file: &File) -> HANDLE {
    file.as_handle().as_raw_handle()
}

/// The identity of the file `file` is open on.
pub fn file_identity(file: &File) -> io::Result<FileIdentity> {
    // SAFETY: an all-zero BY_HANDLE_FILE_INFORMATION is a valid value to overwrite.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: a valid open file handle, borrowed for the call; `info` is a
    // valid out pointer for the whole struct.
    check(unsafe { GetFileInformationByHandle(handle_of(file), &mut info) })?;
    Ok(FileIdentity {
        volume: info.dwVolumeSerialNumber,
        index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        links: info.nNumberOfLinks,
    })
}

/// The normalized path of the file `file` is open on, with drive letters
/// (`\\?\C:\...`, or `\\?\UNC\...` for a share): the object actually opened,
/// whatever links led there.
pub fn final_path(file: &File) -> io::Result<PathBuf> {
    let mut buffer = vec![0_u16; 512];
    loop {
        let capacity =
            u32::try_from(buffer.len()).map_err(|_| io::Error::other("path too long"))?;
        // SAFETY: a valid open file handle; `buffer` is writable for
        // `capacity` UTF-16 units.
        let written = unsafe {
            GetFinalPathNameByHandleW(
                handle_of(file),
                buffer.as_mut_ptr(),
                capacity,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        };
        let written = written as usize;
        if written == 0 {
            return Err(io::Error::last_os_error());
        }
        // Too small: the return value is the size needed, NUL included.
        if written >= buffer.len() {
            if written > 32_768 {
                return Err(io::Error::other("path too long"));
            }
            buffer.resize(written, 0);
            continue;
        }
        buffer.truncate(written);
        return Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer)));
    }
}

/// Rename `from` to `to` on one volume, failing with `AlreadyExists` when `to`
/// exists (std's `rename` replaces it). A directory moves with its contents.
pub fn move_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    let wide = |path: &Path| -> Vec<u16> { path.as_os_str().encode_wide().chain([0]).collect() };
    let (from, to) = (wide(from), wide(to));
    // SAFETY: both are NUL-terminated UTF-16 paths that outlive the call; no
    // flags: the move fails rather than replace `to` or copy across volumes.
    check(unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) })
}

/// Whether this process runs elevated (an administrator's full token): the
/// node file tools treat it as running as root.
pub fn process_is_elevated() -> io::Result<bool> {
    let mut token: HANDLE = null_mut();
    // SAFETY: the current-process pseudo handle; `token` is a valid out
    // pointer that receives a new handle on success.
    check(unsafe { OpenProcessToken(current_process(), TOKEN_QUERY, &mut token) })?;
    let token = owned(token)?;
    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut len = 0_u32;
    let size = u32::try_from(size_of::<TOKEN_ELEVATION>())
        .map_err(|_| io::Error::other("token information does not fit"))?;
    // SAFETY: a valid token handle with query access; `elevation` is
    // writable for `size` bytes and `len` is a valid out pointer.
    check(unsafe {
        GetTokenInformation(
            raw(token.as_handle()),
            TokenElevation,
            (&raw mut elevation).cast(),
            size,
            &mut len,
        )
    })?;
    Ok(elevation.TokenIsElevated != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_handles_on_one_file_share_its_identity_and_final_path() {
        let dir = std::env::temp_dir().join(format!("wsmp-file-info-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("a.txt");
        std::fs::write(&path, b"a").expect("file");
        std::fs::hard_link(&path, dir.join("b.txt")).expect("link");
        let a = File::open(&path).expect("a");
        let b = File::open(dir.join("b.txt")).expect("b");
        let other = File::open(std::env::current_exe().expect("exe")).expect("other");
        let id = file_identity(&a).expect("identity");
        assert_eq!(id, file_identity(&b).expect("identity"));
        assert_eq!(id.links, 2);
        assert_ne!(id, file_identity(&other).expect("identity"));
        let real = final_path(&a).expect("final path");
        assert_eq!(real, std::fs::canonicalize(&path).expect("canonical"));
        assert!(final_path(&b).expect("final path").ends_with("b.txt"));
        drop((a, b));
        let _ = std::fs::remove_dir_all(&dir);
        process_is_elevated().expect("elevation is readable");
    }

    #[test]
    fn a_move_never_replaces_its_destination() {
        let dir = std::env::temp_dir().join(format!("wsmp-move-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let (a, b, c) = (dir.join("a"), dir.join("b"), dir.join("c"));
        std::fs::write(&a, b"a").expect("a");
        std::fs::write(&b, b"b").expect("b");
        let error = move_no_replace(&a, &b).expect_err("b exists");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&b).expect("b"), b"b");
        move_no_replace(&a, &c).expect("c is free");
        assert_eq!(std::fs::read(&c).expect("c"), b"a");
        assert!(!a.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
