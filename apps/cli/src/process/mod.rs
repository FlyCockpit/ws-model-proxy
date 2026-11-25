//! Processes: children's environment, bounded runs, process trees and sessions, the launch guard,
//! the subreaper, shutdown, the control channel to a running relay, and the link to the Windows
//! ConPTY helper.

pub mod bounded_run;
pub mod child_env;
#[cfg(windows)]
pub(crate) mod conpty_link;
pub mod control;
#[cfg(windows)]
pub(crate) mod job_tree;
pub mod launch_guard;
#[cfg(unix)]
pub(crate) mod process_list;
pub mod shutdown;
pub mod subreaper;
