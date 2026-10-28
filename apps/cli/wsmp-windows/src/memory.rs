//! This machine's physical memory, total and available (`GlobalMemoryStatusEx`):
//! Windows has no `/proc/meminfo`, so without it a node reports no memory and
//! nothing that asks for `cpu` or `unified` memory can be placed on it.

use std::io;

use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

use crate::imp::check;

/// Physical memory, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryStatus {
    /// Installed memory the OS can use (`ullTotalPhys`).
    pub total_bytes: u64,
    /// Memory that can be used right away without writing to the page file
    /// (`ullAvailPhys`: free, zeroed and standby pages), as `MemAvailable` is.
    pub available_bytes: u64,
}

/// The physical memory figures right now.
pub fn memory_status() -> io::Result<MemoryStatus> {
    // SAFETY: an all-zero MEMORYSTATUSEX is a valid value to overwrite.
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    // The call refuses a structure whose length it is not told.
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    // SAFETY: `status` is a valid, writable MEMORYSTATUSEX with `dwLength` set,
    // borrowed for the call only.
    check(unsafe { GlobalMemoryStatusEx(&mut status) })?;
    Ok(MemoryStatus {
        total_bytes: status.ullTotalPhys,
        available_bytes: status.ullAvailPhys,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_is_reported_and_consistent() {
        let status = memory_status().expect("memory status");
        // Any machine that runs the tests has more than 256 MiB.
        assert!(status.total_bytes > 256 << 20, "{status:?}");
        assert!(status.available_bytes <= status.total_bytes, "{status:?}");
    }
}
