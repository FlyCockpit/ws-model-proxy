//! The Windows enforcement point for bounded children. The owner retains the
//! wrapper for the entire run, even after the root exits; registries retain
//! clones solely so shutdown can terminate the job from another thread.
//!
//! Lock order: callers release registry locks before acquiring a job lock.
//! A job lock covers only pipe extraction or nonblocking OS calls. Never read
//! a pipe, sleep, or wait for process exit while holding it. Poisoned locks
//! remain usable; shutdown retries contended locks only until its deadline.
//!
//! Tokio is used synchronously, without a runtime. No async wait or pipe I/O
//! is polled, so Windows Child::waiting stays None. ChildDropGuard only calls
//! std Child::kill; dropping the job closes its handles without waiting.

use std::io;
use std::process::{ChildStderr, ChildStdout, Command, ExitStatus};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::thread;
use std::time::{Duration, Instant};

use process_wrap::tokio::{
    ChildWrapper as TokioChildWrapper, CommandWrap as TokioCommandWrap, JobObject, KillOnDrop,
};

const LOCK_GRACE: Duration = Duration::from_millis(200);
const POLL: Duration = Duration::from_millis(5);

pub(crate) fn lock_until<T>(lock: &Mutex<T>, until: Instant) -> io::Result<MutexGuard<'_, T>> {
    loop {
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Ok(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) if Instant::now() < until => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(TryLockError::WouldBlock) => {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "job lock is busy",
                ));
            }
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct JobTree {
    child: Arc<Mutex<Box<dyn TokioChildWrapper>>>,
    pid: u32,
}

impl JobTree {
    #[cfg(test)]
    pub(crate) fn id(&self) -> u32 {
        self.pid
    }

    /// The shared job-terminate path. Never use wrapper.kill()/wait(): those
    /// wait for the whole job and could block a timeout or shutdown forever.
    pub(crate) fn terminate_until(&self, until: Instant) -> io::Result<()> {
        lock_until(&self.child, until)?.start_kill()
    }

    pub(crate) fn terminate(&self) -> io::Result<()> {
        self.terminate_until(Instant::now() + LOCK_GRACE)
    }
}

pub(crate) struct Child {
    job: JobTree,
    pub(crate) stdout: Option<ChildStdout>,
    pub(crate) stderr: Option<ChildStderr>,
    #[cfg(test)]
    terminate_on_drop: bool,
}

impl Child {
    pub(crate) fn id(&self) -> u32 {
        self.job.pid
    }

    pub(crate) fn job(&self) -> JobTree {
        self.job.clone()
    }

    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        // JobObjectChild::try_wait uses a zero-duration completion-port poll,
        // then returns the root status. Root exit must not wait for helpers.
        lock_until(&self.job.child, Instant::now())?.try_wait()
    }

    /// Only the background reaper calls this, after job termination. It keeps
    /// the run's Budget permit alive, without pinning the shutdown lock.
    pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            match self.try_wait() {
                Ok(Some(status)) => return Ok(status),
                Ok(None) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error),
            }
            thread::sleep(POLL);
        }
    }

    #[cfg(test)]
    fn drop_wrapper_without_termination(mut self) {
        assert_eq!(
            Arc::strong_count(&self.job.child),
            1,
            "registry still owns job"
        );
        // Only the test can bypass owner termination. Dropping the sole Arc
        // drops the boxed Tokio wrapper and closes its job handle directly.
        self.terminate_on_drop = false;
        drop(self);
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        #[cfg(test)]
        if !self.terminate_on_drop {
            return;
        }
        // Also handles early errors, unwind, and session Drop while registry
        // clones remain live. Explicit kills use the shared enforcement point;
        // the last wrapper drop also closes the job with kill-on-close.
        let _ = self.job.terminate();
    }
}

pub(crate) fn spawn(command: Command) -> io::Result<Child> {
    spawn_with(command, |_| {})
}

fn spawn_with(
    command: Command,
    configure: impl FnOnce(&mut TokioCommandWrap),
) -> io::Result<Child> {
    let mut command = TokioCommandWrap::from(tokio::process::Command::from(command));
    configure(&mut command);
    // process-wrap creates the root suspended, assigns it, then resumes it.
    // Its failure paths terminate the suspended root; there is no bare-spawn
    // fallback if job creation, assignment, or resume fails.
    let mut wrapped = command.wrap(JobObject).wrap(KillOnDrop).spawn()?;
    let Some(pid) = wrapped.id() else {
        let _ = wrapped.start_kill();
        return Err(io::Error::other("job child has no process ID"));
    };
    // Windows spawn/stdio only wrap std handles. Convert before any async I/O
    // can start so all reads stay synchronous and require no Tokio runtime.
    // On conversion errors the wrapper drops, closing the kill-on-close job.
    let stdout = wrapped
        .stdout()
        .take()
        .map(|pipe| pipe.into_owned_handle().map(ChildStdout::from))
        .transpose()?;
    let stderr = wrapped
        .stderr()
        .take()
        .map(|pipe| pipe.into_owned_handle().map(ChildStderr::from))
        .transpose()?;
    Ok(Child {
        job: JobTree {
            child: Arc::new(Mutex::new(wrapped)),
            pid,
        },
        stdout,
        stderr,
        #[cfg(test)]
        terminate_on_drop: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows_test_tree::{Tree, assert_dead, process_exists};
    use process_wrap::tokio::CommandWrapper;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Force JobObject's assignment setup to fail after the suspended spawn.
    /// This terminal wrapper deliberately exposes no native process handle.
    #[derive(Debug)]
    struct MissingHandle(Box<dyn TokioChildWrapper>);

    impl TokioChildWrapper for MissingHandle {
        fn inner(&self) -> &dyn TokioChildWrapper {
            self
        }
        fn inner_mut(&mut self) -> &mut dyn TokioChildWrapper {
            self
        }
        fn into_inner(self: Box<Self>) -> Box<dyn TokioChildWrapper> {
            self
        }
        fn id(&self) -> Option<u32> {
            self.0.id()
        }
        fn stdout(&mut self) -> &mut Option<tokio::process::ChildStdout> {
            self.0.stdout()
        }
        fn stderr(&mut self) -> &mut Option<tokio::process::ChildStderr> {
            self.0.stderr()
        }
        fn start_kill(&mut self) -> io::Result<()> {
            self.0.start_kill()
        }
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            self.0.try_wait()
        }
    }

    #[derive(Debug)]
    struct FailAssignment(Arc<AtomicU32>);

    impl CommandWrapper for FailAssignment {
        fn wrap_child(
            &mut self,
            inner: Box<dyn TokioChildWrapper>,
            _: &TokioCommandWrap,
        ) -> io::Result<Box<dyn TokioChildWrapper>> {
            self.0
                .store(inner.id().expect("spawned PID"), Ordering::SeqCst);
            Ok(Box::new(MissingHandle(inner)))
        }
    }

    #[derive(Debug)]
    struct MissingId(Box<dyn TokioChildWrapper>);

    impl TokioChildWrapper for MissingId {
        fn inner(&self) -> &dyn TokioChildWrapper {
            self.0.as_ref()
        }
        fn inner_mut(&mut self) -> &mut dyn TokioChildWrapper {
            self.0.as_mut()
        }
        fn into_inner(self: Box<Self>) -> Box<dyn TokioChildWrapper> {
            self.0
        }
        fn process_handle(&self) -> Option<std::os::windows::io::BorrowedHandle<'_>> {
            self.0.process_handle()
        }
        fn id(&self) -> Option<u32> {
            None
        }
    }

    #[derive(Debug)]
    struct HideId(Arc<AtomicU32>);

    impl CommandWrapper for HideId {
        fn wrap_child(
            &mut self,
            inner: Box<dyn TokioChildWrapper>,
            _: &TokioCommandWrap,
        ) -> io::Result<Box<dyn TokioChildWrapper>> {
            self.0
                .store(inner.id().expect("spawned PID"), Ordering::SeqCst);
            Ok(Box::new(MissingId(inner)))
        }
    }

    #[test]
    fn failed_job_setup_never_resumes_or_leaves_the_suspended_root_alive() {
        let tree = Tree::new();
        let pid = Arc::new(AtomicU32::new(0));
        let mut command = Command::new("cmd");
        command.args(tree.command("hang"));
        let result = spawn_with(command, |command| {
            command.wrap(FailAssignment(Arc::clone(&pid)));
        });
        let pid = pid.load(Ordering::SeqCst);
        if pid > 0 {
            // Cleanup can also reach a suspended root if a failure-path kill
            // is removed: that root cannot write its own marker yet.
            std::fs::write(&tree.root, pid.to_string()).expect("cleanup PID");
        }
        if result.is_ok() {
            // If the JobObject guard is removed, let the fixture record the
            // grandchild before the assertion fails, so Drop can clean it up.
            let _ = tree.read_marker();
        }
        assert!(result.is_err(), "job setup failure must fail closed");
        assert!(!tree.marker.exists(), "a child ran before job assignment");
        assert!(
            pid > 0,
            "failure injection did not reach the suspended root"
        );
        assert_dead(pid);
    }

    #[test]
    fn owner_drop_kills_the_tree_even_while_a_registry_clone_is_alive() {
        let tree = Tree::new();
        let mut command = Command::new("cmd");
        command.args(tree.command("detach"));
        let child = spawn(command).expect("job spawn");
        let registry_clone = child.job();
        let grandchild = tree.read_marker().parse().expect("grandchild PID");
        drop(child);
        assert_dead(grandchild);
        drop(registry_clone);
    }

    #[test]
    fn a_missing_child_id_fails_closed_and_kills_the_assigned_root() {
        let tree = Tree::new();
        let pid = Arc::new(AtomicU32::new(0));
        let mut command = Command::new("cmd");
        command.args(tree.command("hang"));
        let result = spawn_with(command, |command| {
            command.wrap(HideId(Arc::clone(&pid)));
        });
        let pid = pid.load(Ordering::SeqCst);
        assert!(pid > 0, "failure injection did not reach the root");
        std::fs::write(&tree.root, pid.to_string()).expect("cleanup PID");
        assert!(result.is_err(), "a missing PID must fail closed");
        assert_dead(pid);
        if tree.marker.exists() {
            assert_dead(tree.read_marker().parse().expect("grandchild PID"));
        }
    }

    #[test]
    fn piped_output_can_be_read_synchronously_without_a_runtime() {
        use std::io::Read;
        use std::process::Stdio;

        let mut command = Command::new("cmd");
        command
            .args(["/C", "echo stdout & echo stderr 1>&2"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = spawn(command).expect("job spawn without a runtime");
        let until = Instant::now() + Duration::from_secs(5);
        while child.try_wait().expect("root status").is_none() {
            assert!(Instant::now() < until, "root did not exit");
            thread::sleep(POLL);
        }
        let mut stdout = String::new();
        let mut stderr = String::new();
        child
            .stdout
            .take()
            .expect("std stdout pipe")
            .read_to_string(&mut stdout)
            .expect("synchronous stdout read");
        child
            .stderr
            .take()
            .expect("std stderr pipe")
            .read_to_string(&mut stderr)
            .expect("synchronous stderr read");
        assert_eq!(stdout.trim(), "stdout");
        assert_eq!(stderr.trim(), "stderr");
    }

    #[test]
    fn closing_the_last_job_handle_kills_grandchildren_without_explicit_termination() {
        for mode in ["detach", "success"] {
            let tree = Tree::new();
            let mut command = Command::new("cmd");
            command.args(tree.command(mode));
            let mut child = spawn(command).expect("job spawn without a runtime");
            let registry_clone = child.job();
            let grandchild = tree.read_marker().parse().expect("grandchild PID");
            if mode == "success" {
                let until = Instant::now() + Duration::from_secs(5);
                while child.try_wait().expect("root status").is_none() {
                    assert!(Instant::now() < until, "root did not exit");
                    thread::sleep(POLL);
                }
            }
            assert!(
                process_exists(grandchild),
                "grandchild exited before job close"
            );
            drop(registry_clone);
            let started = Instant::now();
            child.drop_wrapper_without_termination();
            assert!(
                started.elapsed() < Duration::from_secs(1),
                "wrapper drop blocked"
            );
            // Removing .wrap(KillOnDrop) makes this fail: JobObject then sets
            // kill_on_close=false, and no JobTree::terminate ran. Tokio's root
            // kill-on-drop cannot kill a detached grandchild; in the success
            // case the root has already exited and been reaped anyway.
            assert_dead(grandchild);
        }
    }

    #[test]
    fn termination_never_blocks_on_a_held_child_lock() {
        let mut command = Command::new("cmd");
        command.args(["/C", "ping -n 60 127.0.0.1 >nul"]);
        let child = spawn(command).expect("job spawn");
        let job = child.job();
        let guard = lock_until(&job.child, Instant::now()).expect("child lock");
        let started = Instant::now();
        assert_eq!(
            job.terminate().expect_err("busy lock").kind(),
            io::ErrorKind::WouldBlock
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(guard);
        job.terminate().expect("terminate after lock release");
        assert_dead(child.id());
    }
}
