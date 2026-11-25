//! The filesystem primitives every file tool and the journal stand on, bottom
//! up (all on `file_ops::meta`, the `Stat`/`Kind` vocabulary):
//! `sync` (the directory fsync barrier and its errno class); `policy`
//! (protected set, roots, root user) and `resolve` (the fd walk), together the
//! only path enforcement point; `walk` (the sorted directory walk of `list` and
//! `search`); and `etag` (keyed content hashes and the bounded full reads).
//! Nothing here names the journal or the tools.

pub mod etag;
pub mod policy;
#[cfg(unix)]
pub(crate) mod resolve;
#[cfg(windows)]
#[path = "resolve_windows.rs"]
pub(crate) mod resolve;
#[cfg(unix)]
pub(super) mod sync;
#[cfg(unix)]
pub(crate) mod walk;
#[cfg(windows)]
#[path = "walk_windows.rs"]
pub(crate) mod walk;
