//! The crash-safe write layer over the filesystem primitives: `exchange` (the
//! rename/link syscalls it moves names with, and their fault points), `atomic` (the
//! replace and exclusive-create sequence) runs on `recovery` (the per-operation
//! recovery directory), which records its plan in `intent` (the crash map) and
//! indexes itself in `registry` (the durable list of live recovery
//! directories); `recover` rolls abandoned ones forward or back for `wsmp
//! recover`. Only `atomic` exists on Windows, which has no journal.

#[cfg(unix)]
pub(crate) mod atomic;
#[cfg(windows)]
#[path = "atomic_windows.rs"]
pub(crate) mod atomic;
#[cfg(unix)]
pub(super) mod exchange;
#[cfg(unix)]
pub(super) mod intent;
#[cfg(unix)]
pub(super) mod recover;
#[cfg(unix)]
pub(super) mod recovery;
#[cfg(unix)]
pub(super) mod registry;
