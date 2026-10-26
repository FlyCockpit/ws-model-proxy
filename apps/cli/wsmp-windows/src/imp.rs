//! Every `unsafe` block below is one Win32 call (or the read of what one
//! wrote) with its preconditions stated. Handles are owned by `OwnedHandle`
//! and `LocalAlloc` blocks by `LocalBox`, so no path leaks or double-frees.

use std::ffi::{OsStr, c_void};
use std::io;
use std::os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};

use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::{ERROR_SUCCESS, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SDDL_REVISION_1, SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    RevertToSelf, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
};
use windows_sys::Win32::System::Pipes::{GetNamedPipeClientProcessId, ImpersonateNamedPipeClient};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, OpenProcess, OpenProcessToken, OpenThreadToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::core::BOOL;

fn check(ok: BOOL) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn raw(handle: BorrowedHandle<'_>) -> HANDLE {
    handle.as_raw_handle()
}

/// The current-process pseudo handle (never closed, always valid).
fn current_process() -> HANDLE {
    // SAFETY: no preconditions.
    unsafe { GetCurrentProcess() }
}

/// The current-thread pseudo handle (never closed, always valid).
fn current_thread() -> HANDLE {
    // SAFETY: no preconditions.
    unsafe { GetCurrentThread() }
}

/// Takes ownership of a handle a Win32 call just returned (null on failure).
fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a non-null handle fresh from a Win32 open/create call, owned by
    // no one else; `OwnedHandle` closes it exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

/// Memory Windows allocated with `LocalAlloc` for the caller to free.
struct LocalBox(*mut c_void);

impl Drop for LocalBox {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer came from a Win32 call documented to return
            // `LocalAlloc` memory, and it is freed only here.
            unsafe { LocalFree(self.0) };
        }
    }
}

/// A token's user SID, kept in the `TOKEN_USER` buffer it points into.
struct UserSid {
    // u64s so the buffer is aligned for `TOKEN_USER`.
    buffer: Vec<u64>,
}

impl UserSid {
    fn of_token(token: BorrowedHandle<'_>) -> io::Result<Self> {
        let mut len = 0_u32;
        // SAFETY: a size query (null buffer, zero length); `len` is a valid
        // out pointer. It fails with ERROR_INSUFFICIENT_BUFFER by design.
        unsafe { GetTokenInformation(raw(token), TokenUser, null_mut(), 0, &mut len) };
        if (len as usize) < size_of::<TOKEN_USER>() {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0_u64; (len as usize).div_ceil(size_of::<u64>())];
        // SAFETY: `buffer` is writable for at least `len` bytes and aligned
        // for `TOKEN_USER`; `len` is a valid out pointer.
        check(unsafe {
            GetTokenInformation(
                raw(token),
                TokenUser,
                buffer.as_mut_ptr().cast(),
                len,
                &mut len,
            )
        })?;
        Ok(Self { buffer })
    }

    fn current() -> io::Result<Self> {
        let mut token: HANDLE = null_mut();
        // SAFETY: the current-process pseudo handle; `token` is a valid out
        // pointer that receives a new handle on success.
        check(unsafe { OpenProcessToken(current_process(), TOKEN_QUERY, &mut token) })?;
        Self::of_token(owned(token)?.as_handle())
    }

    fn sid(&self) -> PSID {
        let user = self.buffer.as_ptr().cast::<TOKEN_USER>();
        // SAFETY: `of_token` filled the buffer's start with a `TOKEN_USER`
        // (its length was checked), and the SID it points to lies inside the
        // same buffer, which lives as long as `self`.
        unsafe { (*user).User.Sid }
    }

    fn equals(&self, other: PSID) -> bool {
        // SAFETY: both are valid SIDs: ours lives in `self.buffer`, and the
        // caller's is borrowed for this call.
        unsafe { EqualSid(self.sid(), other) != 0 }
    }

    /// The `S-1-5-21-â€¦` form, for a security descriptor string.
    fn to_sddl(&self) -> io::Result<String> {
        let mut text: *mut u16 = null_mut();
        // SAFETY: a valid SID; `text` is a valid out pointer that receives a
        // `LocalAlloc` string on success.
        check(unsafe { ConvertSidToStringSidW(self.sid(), &mut text) })?;
        let text = LocalBox(text.cast());
        let start = text.0.cast::<u16>();
        let mut len = 0;
        // SAFETY: Windows returned a NUL-terminated UTF-16 string, so every
        // index up to and including the NUL is in bounds.
        while unsafe { *start.wrapping_add(len) } != 0 {
            len += 1;
        }
        // SAFETY: `len` UTF-16 units at `start` are initialized (see above)
        // and stay alive while `text` does.
        let units = unsafe { std::slice::from_raw_parts(start, len) };
        String::from_utf16(units).map_err(|_| io::Error::other("SID string is not UTF-16"))
    }
}

/// This process's user SID in its `S-1-5-21-…` string form (what a Task
/// Scheduler principal names).
pub fn current_user_sid() -> io::Result<String> {
    UserSid::current()?.to_sddl()
}

/// Creates one instance of the relay's control pipe at `name`, inside a
/// tokio runtime.
///
/// - Only this user may open it: its owner and its only ACE are the current
///   user's SID, with inheritance blocked (`O:<sid>D:P(A;;GA;;;<sid>)`). So
///   an elevated or a non-elevated relay of the same user both get an owner
///   that [`pipe_owner_is_current_user`] accepts.
/// - Remote clients are rejected.
/// - With `first`, creation fails if any process already serves `name`, so a
///   pipe squatter cannot sit in front of the relay.
pub fn create_control_pipe(name: &OsStr, first: bool) -> io::Result<NamedPipeServer> {
    let sid = UserSid::current()?.to_sddl()?;
    let sddl: Vec<u16> = format!("O:{sid}D:P(A;;GA;;;{sid})")
        .encode_utf16()
        .chain([0])
        .collect();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: `sddl` is NUL-terminated UTF-16; `descriptor` is a valid out
    // pointer that receives `LocalAlloc` memory; the size out pointer may be
    // null.
    check(unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    })?;
    let descriptor = LocalBox(descriptor);
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>()).unwrap_or(u32::MAX),
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .access_inbound(true)
        .access_outbound(true);
    // SAFETY: `attributes` is a valid SECURITY_ATTRIBUTES and its descriptor
    // (`descriptor`) outlives this call; CreateNamedPipeW copies both.
    unsafe { options.create_with_security_attributes_raw(name, (&raw mut attributes).cast()) }
}

/// The process id of the client connected to `pipe` (a server handle). The
/// client cannot pick it: the kernel records it when the client opens the
/// pipe.
pub fn pipe_client_pid(pipe: BorrowedHandle<'_>) -> io::Result<u32> {
    let mut pid = 0_u32;
    // SAFETY: a valid pipe handle (borrowed for the call); `pid` is a valid
    // out pointer.
    check(unsafe { GetNamedPipeClientProcessId(raw(pipe), &mut pid) })?;
    Ok(pid)
}

/// Whether the client connected to `pipe` (a server handle) runs as this
/// process's user, read from its token by impersonating it for the length of
/// the check. The server must have read from the pipe first (a Windows rule
/// for impersonation). This thread's own identity is restored before
/// returning; if Windows cannot restore it, the process aborts rather than
/// go on running as the client.
pub fn pipe_client_is_current_user(pipe: BorrowedHandle<'_>) -> io::Result<bool> {
    let me = UserSid::current()?;
    // SAFETY: a valid pipe server handle, borrowed for the call.
    check(unsafe { ImpersonateNamedPipeClient(raw(pipe)) })?;
    let mut token: HANDLE = null_mut();
    // SAFETY: the current-thread pseudo handle; `token` is a valid out
    // pointer. OpenAsSelf (1) checks access as this process, not as the
    // client, which may impersonate at identification level only.
    let opened = check(unsafe { OpenThreadToken(current_thread(), TOKEN_QUERY, 1, &mut token) });
    // SAFETY: no preconditions; it ends the impersonation started above.
    if unsafe { RevertToSelf() } == 0 {
        std::process::abort();
    }
    opened?;
    let client = UserSid::of_token(owned(token)?.as_handle())?;
    Ok(me.equals(client.sid()))
}

/// Whether the pipe a client opened (`pipe`, a client handle with
/// `READ_CONTROL`) is owned by this process's user, as
/// [`create_control_pipe`] makes it.
pub fn pipe_owner_is_current_user(pipe: BorrowedHandle<'_>) -> io::Result<bool> {
    let me = UserSid::current()?;
    let mut owner: PSID = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: a valid handle (borrowed); the owner and descriptor out
    // pointers are valid, the others may be null. The owner points into the
    // descriptor, which Windows allocates with `LocalAlloc`.
    let status = unsafe {
        GetSecurityInfo(
            raw(pipe),
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    };
    let descriptor = LocalBox(descriptor);
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(
            i32::try_from(status).unwrap_or(i32::MAX),
        ));
    }
    if owner.is_null() {
        return Ok(false);
    }
    let same = me.equals(owner);
    drop(descriptor);
    Ok(same)
}

/// A job object the relay joins at startup, so that every process it starts,
/// and every process those start, is a member.
///
/// Jobs nest (Windows 8 and later): the per-command kill-on-close jobs are
/// created inside this one. A member cannot break away, since this job does
/// not allow it, so stripping `WSMP_JOB` from the environment does not hide
/// a process from [`RelayJob::contains`]. No limits are set; the job only
/// answers membership.
///
/// Not covered: a member can ask another process outside the job to start
/// something (Task Scheduler, WMI, Explorer), which is then not a member.
#[derive(Debug)]
pub struct RelayJob {
    job: OwnedHandle,
}

impl RelayJob {
    /// Creates an unnamed job and puts this process in it.
    pub fn create_and_join() -> io::Result<Self> {
        // SAFETY: null attributes and name make an unnamed job with default
        // security; the returned handle is checked by `owned`.
        let job = owned(unsafe { CreateJobObjectW(null(), null()) })?;
        // SAFETY: a valid job handle (all access, as its creator) and the
        // current-process pseudo handle.
        check(unsafe { AssignProcessToJobObject(raw(job.as_handle()), current_process()) })?;
        Ok(Self { job })
    }

    /// Whether process `pid` is in this job: this process or something it
    /// started. Errors when the process cannot be opened (gone, or a
    /// protected process); callers fail closed.
    pub fn contains(&self, pid: u32) -> io::Result<bool> {
        // SAFETY: plain open by pid; failure returns null, checked by `owned`.
        let process = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
        let mut member: BOOL = 0;
        // SAFETY: valid process and job handles; `member` is a valid out
        // pointer.
        check(unsafe {
            IsProcessInJob(
                raw(process.as_handle()),
                raw(self.job.as_handle()),
                &mut member,
            )
        })?;
        Ok(member != 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Write};
    use std::process::{Command, Stdio};

    fn pipe_name(tag: &str) -> String {
        format!(r"\\.\pipe\wsmp-windows-test-{tag}-{}", std::process::id())
    }

    #[test]
    fn the_sid_string_is_the_users() {
        let sid = UserSid::current()
            .and_then(|user| user.to_sddl())
            .expect("sid");
        assert!(sid.starts_with("S-1-5-"), "{sid}");
    }

    #[tokio::test]
    async fn the_control_pipe_knows_its_client_and_refuses_a_second_server() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let name = pipe_name("pipe");
        let server = create_control_pipe(OsStr::new(&name), true).expect("first instance");
        // Someone else serving the same name first: refused.
        assert!(create_control_pipe(OsStr::new(&name), true).is_err());

        let client_name = name.clone();
        let client = std::thread::spawn(move || {
            let mut file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&client_name)
                .expect("open pipe");
            let owner_ok = pipe_owner_is_current_user(file.as_handle()).expect("owner");
            file.write_all(b"ping\n").expect("write");
            // Pipes have no half-close: the answer ends at its newline.
            let mut answer = String::new();
            std::io::BufReader::new(&mut file)
                .read_line(&mut answer)
                .expect("read");
            (owner_ok, answer)
        });

        let mut server = server;
        server.connect().await.expect("connect");
        let mut line = [0_u8; 5];
        server.read_exact(&mut line).await.expect("read");
        assert_eq!(&line, b"ping\n");
        assert_eq!(
            pipe_client_pid(server.as_handle()).expect("client pid"),
            std::process::id()
        );
        assert!(pipe_client_is_current_user(server.as_handle()).expect("client user"));
        server.write_all(b"pong\n").await.expect("write");
        // DisconnectNamedPipe would drop the unread answer: wait for the
        // client to hang up instead.
        let mut rest = [0_u8; 1];
        assert!(matches!(server.read(&mut rest).await, Ok(0) | Err(_)));
        drop(server);

        let (owner_ok, answer) = client.join().expect("client");
        assert!(owner_ok);
        assert_eq!(answer, "pong\n");
    }

    #[test]
    fn the_relay_job_holds_what_starts_after_joining_and_not_before() {
        let spawn = || {
            Command::new("cmd")
                .args(["/C", "ping -n 30 127.0.0.1 >nul"])
                .stdout(Stdio::null())
                .spawn()
                .expect("spawn")
        };
        let mut before = spawn();
        let job = RelayJob::create_and_join().expect("join");
        let mut after = spawn();
        assert!(job.contains(std::process::id()).expect("self"));
        assert!(job.contains(after.id()).expect("after"));
        assert!(!job.contains(before.id()).expect("before"));
        for child in [&mut before, &mut after] {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
