//! Node file tools: the CLI-side library.
//!
//! Pure functions over the local filesystem; there is no wire, admission, or
//! mode logic here (later phases). Every operation is fd-based and
//! symlink-safe, refuses to run as root unless allowed, and returns bounded,
//! masked results. The public entry points are the methods of [`FileOps`] (typed
//! args and results that mirror the MCP tool schemas) and [`FileOps::execute`]
//! (JSON in, JSON out, for the relay dispatcher).
//!
//! Layout, top down (each layer names only the ones below it):
//! - the facade: [`FileOps`] here, which owns an `OpContext` (`context`:
//!   policy, etag key, budgets, step hook, path and namespace locks) and hands
//!   it to the tools; `pool` runs them off the relay loop;
//! - `ops`, the tools: `read`, `stat`, `list`, `search`, `edit`, `write`,
//!   `mutate`, and the text helpers they share;
//! - `journal`, the crash-safe write layer: `atomic` (the replace sequence)
//!   over `recovery` (per-operation recovery directory and its transactions),
//!   `registry` (its durable index), `intent` (the crash map), `recover`
//!   (`wsmp recover`), and `exchange` (the rename/link syscalls it moves names
//!   with, their errno classes and test fault points);
//! - `fs`, the filesystem primitives: `resolve` (fd walk) + `policy` (protected
//!   set, roots, root user), the only path enforcement point; `sync` (the
//!   directory fsync barrier); `walk`; and `etag` keys content hashes;
//! - beside them, the vocabulary every layer shares: `meta` (`Stat` and
//!   `Kind`, what every layer knows of a file object) and `error` (the error
//!   every layer returns); and `redact`, which masks secrets before anything is
//!   windowed.
//!
//! Windows serves the read tools only (`read`, `stat`, `list`, `search`): its
//! `resolve` and `walk` (`fs/resolve_windows.rs`, `fs/walk_windows.rs`) work on
//! paths and check the object actually opened, and present paths in a POSIX
//! view (`C:\Users\ada` is `/c/Users/ada`). The write side, its recovery
//! journal and `wsmp recover` need fd-relative opens and an atomic exchange, and
//! stay Unix.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;

mod context;
pub mod error;
pub(crate) mod fmt;
pub mod fs;
pub(crate) mod journal;
pub(crate) mod meta;
pub mod ops;
pub mod pool;
pub mod redact;
#[cfg(unix)]
pub(crate) use journal::recover::{RecoverReport, recover_from_registry, recover_scan};
#[cfg(unix)]
pub(crate) use journal::recovery::report_abandoned_recovery;
#[cfg(unix)]
pub(crate) use journal::registry::abandoned_count as abandoned_recovery_count;

pub use error::{ErrorCode, FileError, FileResult};

/// How a node path is shown to the server (file roots, resolved paths): as it
/// is on Unix; on Windows in the POSIX view, `C:\Users\ada` as `/c/Users/ada`.
/// `None` when it has no such form (not UTF-8; a share or device on Windows).
pub fn display_path(path: &std::path::Path) -> Option<String> {
    #[cfg(unix)]
    {
        path.to_str().map(str::to_string)
    }
    #[cfg(windows)]
    {
        fs::resolve::posix_view(path)
    }
}

use context::{Hook, Locks, OpContext};
pub use fs::etag::EtagKey;
pub use fs::policy::{Admission, Policy};
use ops::{edit, list, mutate, read, search, stat, write};

#[cfg(test)]
#[cfg(unix)]
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
/// `Vacating` is the last seam before capturing a public name into recovery.
/// After capture, cancellation finishes or compensates; it cannot abandon a move.
#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
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
    Vacating,
    Vacated,
    DestinationVacating,
    DestinationVacated,
    Publishing,
    LinkProbed,
    Exchanged,
    Captured,
    Restored,
    Disposing,
    Created,
    Linked,
    Moved,
    Renamed,
    BeforeDirSync,
    DirSynced,
}

#[cfg_attr(not(unix), allow(dead_code))]
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

/// The file-tool engine: the public entry points. It owns the [`OpContext`]
/// (policy, the per-daemon etag key, and shared state) and hands it to the
/// tools.
pub struct FileOps {
    ctx: OpContext,
}

impl FileOps {
    pub fn new(policy: Policy, key: EtagKey) -> Self {
        Self {
            ctx: OpContext::new(policy, key, Limits::default(), Hook::default()),
        }
    }

    #[doc(hidden)]
    pub fn with_step_hook(mut self, hook: StepHook) -> Self {
        self.ctx.hook = Hook::new(hook);
        self
    }

    #[doc(hidden)]
    pub fn with_limits(mut self, limits: Limits) -> Self {
        self.ctx.locks = Locks::new(limits.lock_wait);
        self.ctx.limits = limits;
        self
    }

    /// What the relay's admission reads of the policy.
    pub fn admission(&self) -> Admission {
        self.ctx.policy.admission()
    }

    pub fn read(&self, args: &read::ReadArgs, cancel: &Cancel) -> FileResult<read::ReadOutcome> {
        self.ctx.policy.check_process()?;
        read::read(&self.ctx, args, cancel)
    }

    pub fn stat(&self, args: &stat::StatArgs, cancel: &Cancel) -> FileResult<stat::StatResult> {
        self.ctx.policy.check_process()?;
        stat::stat(&self.ctx, args, cancel)
    }

    pub fn dir_list(&self, args: &list::ListArgs, cancel: &Cancel) -> FileResult<list::ListResult> {
        self.ctx.policy.check_process()?;
        list::list(&self.ctx, args, cancel)
    }

    pub fn search(
        &self,
        args: &search::SearchArgs,
        cancel: &Cancel,
    ) -> FileResult<search::SearchResult> {
        self.ctx.policy.check_process()?;
        search::search(&self.ctx, args, cancel)
    }

    pub fn edit(&self, args: &edit::EditArgs, cancel: &Cancel) -> FileResult<edit::EditResult> {
        self.ctx.policy.check_process()?;
        edit::edit(&self.ctx, args, cancel)
    }

    pub fn write(
        &self,
        args: &write::WriteArgs,
        cancel: &Cancel,
    ) -> FileResult<write::WriteResult> {
        self.ctx.policy.check_process()?;
        write::write(&self.ctx, args, cancel)
    }

    pub fn rename(
        &self,
        args: &mutate::RenameArgs,
        cancel: &Cancel,
    ) -> FileResult<mutate::RenameResult> {
        self.ctx.policy.check_process()?;
        mutate::rename(&self.ctx, args, cancel)
    }

    pub fn dir_create(
        &self,
        args: &mutate::MkdirArgs,
        cancel: &Cancel,
    ) -> FileResult<mutate::MkdirResult> {
        self.ctx.policy.check_process()?;
        mutate::mkdir(&self.ctx, args, cancel)
    }

    pub fn delete(
        &self,
        args: &mutate::DeleteArgs,
        cancel: &Cancel,
    ) -> FileResult<mutate::DeleteResult> {
        self.ctx.policy.check_process()?;
        mutate::delete(&self.ctx, args, cancel)
    }

    /// JSON dispatch for the relay layer: `op` is one of `read|stat|list|search|
    /// edit|write|rename|mkdir|delete`, `args` the per-op object (the MCP
    /// inputs minus `cliDeviceId`/`confirm`). A field this build does not know
    /// is ignored: a later server may add one.
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

// Test-only access for the Unix tests that drive a layer directly.
#[cfg(all(test, unix))]
impl FileOps {
    pub(crate) fn policy(&self) -> &Policy {
        &self.ctx.policy
    }

    /// The context the tools run with, for tests that drive a layer directly.
    pub(crate) fn context(&self) -> &OpContext {
        &self.ctx
    }

    pub(crate) fn context_mut(&mut self) -> &mut OpContext {
        &mut self.ctx
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
