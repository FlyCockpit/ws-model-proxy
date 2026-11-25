//! The file tools, one module each: `read`, `stat`, `list`, `search`, `edit`,
//! `write`, and `mutate` (rename, mkdir, delete; `mutate_args` holds their
//! arguments and results on every platform), with the text helpers they share:
//! `text` (binary sniff, line counting, end of line), `glob` (the patterns of
//! `list` and `search`) and `diff` (the edit and write diffs). Each takes the
//! facade's `OpContext` and works through the journal and the filesystem
//! primitives below it.

pub(crate) mod diff;
pub mod edit;
pub(crate) mod glob;
pub mod list;
#[cfg(unix)]
pub mod mutate;
#[cfg(windows)]
#[path = "mutate_windows.rs"]
pub mod mutate;
pub(super) mod mutate_args;
pub mod read;
pub mod search;
pub mod stat;
pub(crate) mod text;
pub mod write;
