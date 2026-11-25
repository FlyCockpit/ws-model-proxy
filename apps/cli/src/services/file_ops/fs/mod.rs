//! The filesystem primitives every file tool and the journal stand on, bottom
//! up: `meta` (`Stat` and `Kind`, what every layer knows of a file object);
//! `exchange` (the rename/link primitives and their errno classes); `policy`
//! (protected set, roots, root user) and `resolve` (the fd walk), together the
//! only path enforcement point; `walk` (the sorted directory walk of `list` and
//! `search`); and `etag` (keyed content hashes and the bounded full reads).
//! Nothing here names the journal or the tools.

pub mod etag;
#[cfg(unix)]
pub(super) mod exchange;
pub(crate) mod meta;
pub mod policy;
#[cfg(unix)]
pub(crate) mod resolve;
#[cfg(windows)]
#[path = "resolve_windows.rs"]
pub(crate) mod resolve;
#[cfg(unix)]
pub(crate) mod walk;
#[cfg(windows)]
#[path = "walk_windows.rs"]
pub(crate) mod walk;
