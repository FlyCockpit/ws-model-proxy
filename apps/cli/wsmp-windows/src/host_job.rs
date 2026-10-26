//! The job a runtime host (`wsmp __runtime-host`) holds its runtime in.
//!
//! The host joins a new kill-on-close job before it starts anything, so
//! every process of the runtime is a member from its first instruction (no
//! suspended-start dance) and none can leave: the job does not allow
//! breakaway. The host counts the members to know whether anything of the
//! runtime still runs, and when the host ends, however it ends, closing its
//! handle kills whatever is left.
//!
//! A runtime outlives the relay that started it, and a later relay has a
//! relay job of its own, so the trust check cannot rely on the relay job for
//! it. Each host job is therefore named, in this session's namespace, from a
//! fixed set: `Local\wsmp-runtime-<user SID>-<slot>`, for slots below
//! [`HOST_JOB_SLOTS`]. [`in_host_job`] asks every slot, with no file or
//! environment variable involved. Someone else holding a slot name only takes
//! that slot away (or, with a job that refuses queries, makes the check fail
//! closed); it never makes a member look like a stranger.

use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsHandle, OwnedHandle};
use std::ptr::null;

use windows_sys::Win32::Foundation::{
    ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_INVALID_HANDLE, GetLastError,
};
use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, GenerateConsoleCtrlEvent};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation, OpenJobObjectW,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::core::BOOL;

use crate::imp::{check, current_user_sid, owned, raw};

/// How many runtime host jobs one user can have at once in a session: each
/// holds one slot name.
pub const HOST_JOB_SLOTS: u32 = 256;

/// `JOB_OBJECT_QUERY` (winnt.h): the right `IsProcessInJob` needs.
const JOB_OBJECT_QUERY: u32 = 0x0004;

/// `Local\wsmp-runtime-<sid>-<slot>`, NUL-terminated.
fn slot_name(sid: &str, slot: u32) -> Vec<u16> {
    OsStr::new(&format!(r"Local\wsmp-runtime-{sid}-{slot}"))
        .encode_wide()
        .chain([0])
        .collect()
}

/// A kill-on-close job holding this process and everything it starts.
#[derive(Debug)]
pub struct HostJob {
    job: OwnedHandle,
    slot: u32,
}

impl HostJob {
    /// Creates a kill-on-close job in the first free slot name and puts this
    /// process in it. The job nests inside any job this process is already in
    /// (the relay's, Task Scheduler's). Fails when every slot is taken.
    pub fn create_and_join() -> io::Result<Self> {
        let sid = current_user_sid()?;
        for slot in 0..HOST_JOB_SLOTS {
            let name = slot_name(&sid, slot);
            // SAFETY: null attributes give default security; `name` is a
            // NUL-terminated UTF-16 string that outlives the call.
            let handle = unsafe { CreateJobObjectW(null(), name.as_ptr()) };
            // SAFETY: no preconditions; read right after the call it reports on.
            let error = unsafe { GetLastError() };
            if handle.is_null() {
                // A non-job object holds this name: try the next.
                if error == ERROR_INVALID_HANDLE {
                    continue;
                }
                return Err(io::Error::from_raw_os_error(
                    i32::try_from(error).unwrap_or(i32::MAX),
                ));
            }
            let job = owned(handle)?;
            if error == ERROR_ALREADY_EXISTS {
                // Another host's (or someone else's): never join it.
                continue;
            }
            set_kill_on_close(&job)?;
            // SAFETY: no preconditions; the pseudo handle needs no closing.
            let me = unsafe { GetCurrentProcess() };
            // SAFETY: a valid job handle (all access, as its creator) and the
            // current-process pseudo handle.
            check(unsafe { AssignProcessToJobObject(raw(job.as_handle()), me) })?;
            return Ok(Self { job, slot });
        }
        Err(io::Error::other("every runtime job slot is taken"))
    }

    /// The slot this job's name holds.
    pub fn slot(&self) -> u32 {
        self.slot
    }

    /// How many processes of the job are running, this one included.
    pub fn active_processes(&self) -> io::Result<u32> {
        // SAFETY: an all-zero accounting struct is a valid value to overwrite.
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: a valid job handle; `info` is writable for its whole size,
        // which is passed with it; the returned length is not needed.
        check(unsafe {
            QueryInformationJobObject(
                raw(self.job.as_handle()),
                JobObjectBasicAccountingInformation,
                (&raw mut info).cast(),
                u32::try_from(size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>())
                    .map_err(|_| io::Error::other("job accounting does not fit"))?,
                std::ptr::null_mut(),
            )
        })?;
        Ok(info.ActiveProcesses)
    }

    /// Ends every process of the job at once, this one included.
    pub fn terminate(&self, exit_code: u32) -> io::Result<()> {
        // SAFETY: a valid job handle with all access.
        check(unsafe { TerminateJobObject(raw(self.job.as_handle()), exit_code) })
    }
}

fn set_kill_on_close(job: &OwnedHandle) -> io::Result<()> {
    // SAFETY: an all-zero JOBOBJECT_EXTENDED_LIMIT_INFORMATION is a valid
    // value (no limits); only the flag below is set.
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: a valid job handle (all access, as its creator); `limits` is a
    // live value of the class's struct, its size passed with it.
    check(unsafe {
        SetInformationJobObject(
            raw(job.as_handle()),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                .map_err(|_| io::Error::other("job limits do not fit"))?,
        )
    })
}

/// Whether process `pid` is in any runtime host job of this user in this
/// session: a runtime, or something a runtime started, whichever relay
/// started it and whether or not a relay still runs. Errors when the process
/// or a slot's job cannot be checked; callers fail closed.
pub fn in_host_job(pid: u32) -> io::Result<bool> {
    // SAFETY: plain open by pid; failure returns null, checked by `owned`.
    let process = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    let sid = current_user_sid()?;
    for slot in 0..HOST_JOB_SLOTS {
        let name = slot_name(&sid, slot);
        // SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the
        // call; the handle is not inheritable.
        let handle = unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, 0, name.as_ptr()) };
        if handle.is_null() {
            // SAFETY: no preconditions; read right after the failed open.
            match unsafe { GetLastError() } {
                // No such job, or the name is not a job's: nothing is in it.
                ERROR_FILE_NOT_FOUND | ERROR_INVALID_HANDLE => continue,
                error => {
                    return Err(io::Error::from_raw_os_error(
                        i32::try_from(error).unwrap_or(i32::MAX),
                    ));
                }
            }
        }
        let job = owned(handle)?;
        let mut member: BOOL = 0;
        // SAFETY: valid process and job handles (query access); `member` is a
        // valid out pointer.
        check(unsafe {
            IsProcessInJob(raw(process.as_handle()), raw(job.as_handle()), &mut member)
        })?;
        if member != 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Sends Ctrl+Break to the processes of console process group `group` (a
/// child started with `CREATE_NEW_PROCESS_GROUP`; the group id is its pid)
/// that share this process's console. Console programs take it as an
/// interrupt; this process is not in that group.
pub fn send_ctrl_break(group: u32) -> io::Result<()> {
    // SAFETY: no pointers; an unknown group only makes the call fail.
    check(unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, group) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::time::{Duration, Instant};

    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    fn ping(seconds: u32) -> Command {
        let mut command = Command::new("ping");
        command
            .args(["-n", &seconds.to_string(), "127.0.0.1"])
            .stdout(std::process::Stdio::null());
        command
    }

    /// Runs in a child test process of its own: joining a job is for good.
    #[test]
    fn a_host_job_counts_its_members_tells_them_and_ends_them_on_break() {
        if std::env::var_os("WSMP_WINDOWS_HOST_JOB_CHILD").is_none() {
            // Not in a host job: neither this test process nor a stranger.
            assert!(!in_host_job(std::process::id()).expect("check"));
            let status = Command::new(std::env::current_exe().expect("test binary"))
                .args([
                    "--exact",
                    "host_job::tests::a_host_job_counts_its_members_tells_them_and_ends_them_on_break",
                    "--nocapture",
                ])
                .env("WSMP_WINDOWS_HOST_JOB_CHILD", "1")
                .status()
                .expect("child test runs");
            assert!(status.success(), "{status}");
            return;
        }
        let job = HostJob::create_and_join().expect("job");
        assert!(job.slot() < HOST_JOB_SLOTS);
        assert_eq!(job.active_processes().expect("count"), 1);
        assert!(in_host_job(std::process::id()).expect("check"));
        // The slot's name opens this job.
        let sid = current_user_sid().expect("sid");
        let name = slot_name(&sid, job.slot());
        // SAFETY: as in `in_host_job`.
        let same = unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, 0, name.as_ptr()) };
        assert!(!same.is_null(), "the slot name is the job's");
        drop(owned(same).expect("handle"));
        let mut child = ping(30)
            .creation_flags(CREATE_NEW_PROCESS_GROUP)
            .spawn()
            .expect("ping");
        assert_eq!(job.active_processes().expect("count"), 2);
        assert!(in_host_job(child.id()).expect("check"), "a member's child");
        send_ctrl_break(child.id()).expect("break");
        let until = Instant::now() + Duration::from_secs(10);
        while child.try_wait().expect("wait").is_none() {
            assert!(Instant::now() < until, "ping ignored Ctrl+Break");
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(job.active_processes().expect("count"), 1);
    }
}
