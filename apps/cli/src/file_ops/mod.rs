//! Node file tools: the CLI-side library (plan `mcp-node-file-tools-plan.md`).
//!
//! Pure functions over the local filesystem; there is no wire, admission, or
//! mode logic here (later phases). Every operation is fd-based and
//! symlink-safe, refuses to run as root unless allowed, and returns bounded,
//! masked results. The public entry points are the methods of [`FileOps`] (typed
//! args and results that mirror the MCP tool schemas) and [`FileOps::execute`]
//! (JSON in, JSON out, for the relay dispatcher).
//!
//! Layout: `resolve` (fd walk) + `policy` (protected set, roots, root user) are
//! the only path enforcement point; `redact` masks secrets before anything is
//! windowed; `etag` keys content hashes; `atomic` implements the replace
//! sequence; `read`, `stat`, `list`, `search`, `edit`, `write`, `mutate` are the
//! tools; `pool` runs them off the relay loop.

use std::collections::HashSet;
use std::path::PathBuf;
#[cfg(test)]
use std::sync::atomic::AtomicU8;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::Value;

pub(crate) mod atomic;
pub(crate) mod diff;
pub mod edit;
pub mod error;
pub mod etag;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod exchange;
pub(crate) mod fmt;
pub(crate) mod glob;
pub mod list;
pub mod mutate;
pub mod policy;
pub mod pool;
pub mod read;
pub mod redact;
pub(crate) mod resolve;
pub mod search;
pub mod stat;
pub mod supervised;
pub(crate) mod text;
pub(crate) mod walk;
pub mod write;

pub use error::{ErrorCode, FileError, FileResult};
pub use etag::EtagKey;
pub use policy::Policy;
pub use supervised::{
    AllowedPreview, PreparedSupervised, SupervisedChildInput, SupervisedPreview,
    preview_supervised_child,
};

#[cfg(test)]
mod tests;

/// Cooperative cancellation, checked between files, chunks, and before the
/// commit point of a mutation.
#[derive(Debug, Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> FileResult<()> {
        if self.is_cancelled() {
            Err(FileError::cancelled())
        } else {
            Ok(())
        }
    }
}

/// Observable steps of the atomic replace, in order. A hook may fail a step
/// (test fault injection) or change the world between steps (race tests).
/// `EtagRechecked` is also emitted by `delete` just before its own pre-unlink
/// re-check, whose only purpose there is to give the same seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    SupervisedBeforePin,
    SupervisedPinVerified,
    SupervisedBeforeOpen,
    SupervisedOpened,
    SupervisedOpenedVerified,
    PinBeforeOpen,
    PinOpened,
    BeforeIdentity,
    IdentityChecked,
    TempCreated,
    TempWritten,
    TempSynced,
    Chowned,
    Chmodded,
    EtagRechecked,
    SupervisedSnapshotRead,
    SupervisedPreviewRead,
    Renamed,
    BeforeDirSync,
    DirSynced,
}

pub type StepHook = Arc<dyn Fn(Step) -> FileResult<()> + Send + Sync>;

/// Tunable budgets; the defaults are the plan's values.
#[derive(Debug, Clone)]
pub struct Limits {
    pub search_deadline: Duration,
    pub lock_wait: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            search_deadline: Duration::from_secs(20),
            lock_wait: Duration::from_secs(10),
        }
    }
}

/// At most one mutating operation per physical path at a time.
#[derive(Debug, Default)]
struct PathLocks {
    held: Mutex<HashSet<PathBuf>>,
    released: Condvar,
}

/// Namespace guard: file mutations (edit, write, mkdir) share it; rename and
/// delete hold it exclusively, so a directory cannot be moved or removed while a
/// change below it is in flight (its path lock and its held parent fd would
/// otherwise name different directories). Reads do not take it.
#[derive(Debug, Default)]
struct Namespace {
    state: Mutex<NsState>,
    changed: Condvar,
}

#[derive(Debug, Default)]
struct NsState {
    shared: usize,
    exclusive: bool,
    /// Exclusive requests waiting: new shared holders queue behind them, so a
    /// steady stream of edits cannot starve a rename or delete.
    waiting_exclusive: usize,
}

pub struct NamespaceGuard<'a> {
    ns: &'a Namespace,
    exclusive: bool,
}

impl Drop for NamespaceGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.ns.state.lock() {
            if self.exclusive {
                state.exclusive = false;
            } else {
                state.shared -= 1;
            }
        }
        self.ns.changed.notify_all();
    }
}

impl Namespace {
    fn acquire(
        &self,
        exclusive: bool,
        cancel: &Cancel,
        wait: Duration,
    ) -> FileResult<NamespaceGuard<'_>> {
        let deadline = std::time::Instant::now() + wait;
        let poisoned = || FileError::new(ErrorCode::IoError, "lock poisoned");
        let mut state = self.state.lock().map_err(|_| poisoned())?;
        if exclusive {
            state.waiting_exclusive += 1;
        }
        let blocked = |state: &NsState| {
            state.exclusive
                || (exclusive && state.shared > 0)
                || (!exclusive && state.waiting_exclusive > 0)
        };
        let result = loop {
            if !blocked(&state) {
                break Ok(());
            }
            if let Err(err) = cancel.check() {
                break Err(err);
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                break Err(FileError::new(
                    ErrorCode::Timeout,
                    "another change is still in progress; retry",
                ));
            }
            let slice = (deadline - now).min(Duration::from_millis(50));
            state = match self.changed.wait_timeout(state, slice) {
                Ok((state, _)) => state,
                Err(_) => return Err(poisoned()),
            };
        };
        if exclusive {
            state.waiting_exclusive -= 1;
        }
        if let Err(err) = result {
            drop(state);
            // a departing waiter may unblock shared requests queued behind it
            self.changed.notify_all();
            return Err(err);
        }
        if exclusive {
            state.exclusive = true;
        } else {
            state.shared += 1;
        }
        Ok(NamespaceGuard {
            ns: self,
            exclusive,
        })
    }
}

pub struct PathGuard<'a> {
    locks: &'a PathLocks,
    path: PathBuf,
}

impl Drop for PathGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut held) = self.locks.held.lock() {
            held.remove(&self.path);
        }
        self.locks.released.notify_all();
    }
}

impl PathLocks {
    fn lock(&self, path: PathBuf, cancel: &Cancel, wait: Duration) -> FileResult<PathGuard<'_>> {
        let deadline = std::time::Instant::now() + wait;
        let mut held = self
            .held
            .lock()
            .map_err(|_| FileError::new(ErrorCode::IoError, "lock poisoned"))?;
        while held.contains(&path) {
            cancel.check()?;
            let now = std::time::Instant::now();
            if now >= deadline {
                return Err(FileError::new(
                    ErrorCode::Timeout,
                    "another change to this path is still in progress",
                ));
            }
            let slice = (deadline - now).min(Duration::from_millis(50));
            held = self
                .released
                .wait_timeout(held, slice)
                .map_err(|_| FileError::new(ErrorCode::IoError, "lock poisoned"))?
                .0;
        }
        held.insert(path.clone());
        Ok(PathGuard { locks: self, path })
    }
}

/// The file-tool engine: policy, the per-daemon etag key, and shared state.
pub struct FileOps {
    pub(crate) policy: Policy,
    pub(crate) key: EtagKey,
    pub(crate) limits: Limits,
    pub(crate) hook: Option<StepHook>,
    locks: PathLocks,
    #[cfg(test)]
    rename_atomic_capability: AtomicU8,
    namespace: Namespace,
}

impl FileOps {
    pub fn new(policy: Policy, key: EtagKey) -> Self {
        Self {
            policy,
            key,
            limits: Limits::default(),
            hook: None,
            locks: PathLocks::default(),
            #[cfg(test)]
            rename_atomic_capability: AtomicU8::new(mutate::platform_rename_capability() as u8),
            namespace: Namespace::default(),
        }
    }

    #[doc(hidden)]
    pub fn with_step_hook(mut self, hook: StepHook) -> Self {
        self.hook = Some(hook);
        self
    }

    #[doc(hidden)]
    pub fn with_limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    pub fn policy(&self) -> &Policy {
        &self.policy
    }

    pub(crate) fn step(&self, step: Step) -> FileResult<()> {
        match &self.hook {
            Some(hook) => hook(step),
            None => Ok(()),
        }
    }

    pub(crate) fn rename_atomic_capability(&self) -> mutate::RenameAtomicCapability {
        #[cfg(test)]
        return mutate::RenameAtomicCapability::from_u8(
            self.rename_atomic_capability.load(Ordering::Relaxed),
        );
        #[cfg(not(test))]
        mutate::platform_rename_capability()
    }

    #[cfg(test)]
    pub(crate) fn set_rename_atomic_capability(&self, capability: mutate::RenameAtomicCapability) {
        self.rename_atomic_capability
            .store(capability as u8, Ordering::Relaxed);
    }

    /// Shared namespace guard for a file mutation (see [`Namespace`]).
    pub(crate) fn namespace_shared(&self, cancel: &Cancel) -> FileResult<NamespaceGuard<'_>> {
        self.namespace.acquire(false, cancel, self.limits.lock_wait)
    }

    /// Exclusive namespace guard for a rename or delete.
    pub(crate) fn namespace_exclusive(&self, cancel: &Cancel) -> FileResult<NamespaceGuard<'_>> {
        self.namespace.acquire(true, cancel, self.limits.lock_wait)
    }

    pub(crate) fn lock_path(&self, path: PathBuf, cancel: &Cancel) -> FileResult<PathGuard<'_>> {
        self.locks.lock(path, cancel, self.limits.lock_wait)
    }

    pub fn read(&self, args: &read::ReadArgs, cancel: &Cancel) -> FileResult<read::ReadOutcome> {
        self.policy.check_process()?;
        read::read(self, args, cancel)
    }

    pub fn stat(&self, args: &stat::StatArgs, cancel: &Cancel) -> FileResult<stat::StatResult> {
        self.policy.check_process()?;
        stat::stat(self, args, cancel)
    }

    pub fn dir_list(&self, args: &list::ListArgs, cancel: &Cancel) -> FileResult<list::ListResult> {
        self.policy.check_process()?;
        list::list(self, args, cancel)
    }

    pub fn search(
        &self,
        args: &search::SearchArgs,
        cancel: &Cancel,
    ) -> FileResult<search::SearchResult> {
        self.policy.check_process()?;
        search::search(self, args, cancel)
    }

    pub fn edit(&self, args: &edit::EditArgs, cancel: &Cancel) -> FileResult<edit::EditResult> {
        self.policy.check_process()?;
        edit::edit(self, args, cancel)
    }

    pub fn write(
        &self,
        args: &write::WriteArgs,
        cancel: &Cancel,
    ) -> FileResult<write::WriteResult> {
        self.policy.check_process()?;
        write::write(self, args, cancel)
    }

    pub fn rename(
        &self,
        args: &mutate::RenameArgs,
        cancel: &Cancel,
    ) -> FileResult<mutate::RenameResult> {
        self.policy.check_process()?;
        mutate::rename(self, args, cancel)
    }

    pub fn dir_create(
        &self,
        args: &mutate::MkdirArgs,
        cancel: &Cancel,
    ) -> FileResult<mutate::MkdirResult> {
        self.policy.check_process()?;
        mutate::mkdir(self, args, cancel)
    }

    pub fn delete(
        &self,
        args: &mutate::DeleteArgs,
        cancel: &Cancel,
    ) -> FileResult<mutate::DeleteResult> {
        self.policy.check_process()?;
        mutate::delete(self, args, cancel)
    }

    /// JSON dispatch for the relay layer: `op` is one of `read|stat|list|search|
    /// edit|write|rename|mkdir|delete`, `args` the strict per-op object (the
    /// MCP inputs minus `cliDeviceId`/`confirm`). Unknown fields are rejected.
    pub fn execute(&self, op: &str, args: Value, cancel: &Cancel) -> FileResult<Value> {
        fn parse<T: serde::de::DeserializeOwned>(args: Value) -> FileResult<T> {
            serde_json::from_value(args)
                .map_err(|err| FileError::invalid(format!("bad arguments: {err}")))
        }
        fn out<T: serde::Serialize>(value: T) -> FileResult<Value> {
            serde_json::to_value(value).map_err(|err| {
                FileError::new(ErrorCode::IoError, format!("result encoding: {err}"))
            })
        }
        match op {
            "read" => out(self.read(&parse(args)?, cancel)?),
            "stat" => out(self.stat(&parse(args)?, cancel)?),
            "list" => out(self.dir_list(&parse(args)?, cancel)?),
            "search" => out(self.search(&parse(args)?, cancel)?),
            "edit" => out(self.edit(&parse(args)?, cancel)?),
            "write" => out(self.write(&parse(args)?, cancel)?),
            "rename" => out(self.rename(&parse(args)?, cancel)?),
            "mkdir" => out(self.dir_create(&parse(args)?, cancel)?),
            "delete" => out(self.delete(&parse(args)?, cancel)?),
            other => Err(FileError::invalid(format!("unknown file op `{other}`"))),
        }
    }
}

/// Validate the optional `reason` carried by write-class tools (it goes to the
/// audit log in a later phase).
pub(crate) fn check_reason(reason: &Option<String>) -> FileResult<()> {
    match reason {
        Some(reason) if reason.chars().count() > 500 => {
            Err(FileError::invalid("reason is longer than 500 characters"))
        }
        _ => Ok(()),
    }
}
