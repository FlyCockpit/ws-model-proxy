//! The job a runtime host (`wsmp __runtime-host`) holds its runtime in.
//!
//! The host joins a new kill-on-close job before it starts anything, so
//! every process of the runtime is a member from its first instruction (no
//! suspended-start dance) and none can leave: the job does not allow
//! breakaway. The host counts the members to know whether anything of the
//! runtime still runs, and when the host ends, however it ends, closing its
//! handle kills whatever is left.

use std::io;
use std::os::windows::io::{AsHandle, OwnedHandle};
use std::ptr::null;

use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, GenerateConsoleCtrlEvent};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

use crate::imp::{check, owned, raw};

/// A kill-on-close job holding this process and everything it starts.
#[derive(Debug)]
pub struct HostJob {
    job: OwnedHandle,
}

impl HostJob {
    /// Creates an unnamed kill-on-close job and puts this process in it.
    /// The job nests inside any job this process is already in (the
    /// relay's, Task Scheduler's).
    pub fn create_and_join() -> io::Result<Self> {
        // SAFETY: null attributes and name make an unnamed job with default
        // security; the returned handle is checked by `owned`.
        let job = owned(unsafe { CreateJobObjectW(null(), null()) })?;
        // SAFETY: an all-zero JOBOBJECT_EXTENDED_LIMIT_INFORMATION is a valid
        // value (no limits); only the flag below is set.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: a valid job handle (all access, as its creator); `limits`
        // is a live value of the class's struct, its size passed with it.
        check(unsafe {
            SetInformationJobObject(
                raw(job.as_handle()),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                    .map_err(|_| io::Error::other("job limits do not fit"))?,
            )
        })?;
        // SAFETY: no preconditions; the pseudo handle needs no closing.
        let me = unsafe { GetCurrentProcess() };
        // SAFETY: a valid job handle and the current-process pseudo handle.
        check(unsafe { AssignProcessToJobObject(raw(job.as_handle()), me) })?;
        Ok(Self { job })
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
    fn a_host_job_counts_its_members_and_ends_them_on_break() {
        if std::env::var_os("WSMP_WINDOWS_HOST_JOB_CHILD").is_none() {
            let status = Command::new(std::env::current_exe().expect("test binary"))
                .args([
                    "--exact",
                    "host_job::tests::a_host_job_counts_its_members_and_ends_them_on_break",
                    "--nocapture",
                ])
                .env("WSMP_WINDOWS_HOST_JOB_CHILD", "1")
                .status()
                .expect("child test runs");
            assert!(status.success(), "{status}");
            return;
        }
        let job = HostJob::create_and_join().expect("job");
        assert_eq!(job.active_processes().expect("count"), 1);
        let mut child = ping(30)
            .creation_flags(CREATE_NEW_PROCESS_GROUP)
            .spawn()
            .expect("ping");
        assert_eq!(job.active_processes().expect("count"), 2);
        send_ctrl_break(child.id()).expect("break");
        let until = Instant::now() + Duration::from_secs(10);
        while child.try_wait().expect("wait").is_none() {
            assert!(Instant::now() < until, "ping ignored Ctrl+Break");
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(job.active_processes().expect("count"), 1);
    }
}
