//! The Windows FFI that the `wsmp` CLI needs and std cannot express safely.
//!
//! The `wsmp` crate forbids `unsafe`. The few Win32 calls it cannot avoid
//! live here instead, each behind a safe function:
//!
//! - the relay's local control pipe: an owner-only security descriptor, the
//!   connected client's process id and user, and the pipe's owner as a
//!   client sees it;
//! - the relay job: a job object the relay joins so that it can tell whether
//!   a process descends from it.
//!
//! On other platforms the crate is empty.

#[cfg(windows)]
mod imp;

#[cfg(windows)]
pub use imp::{
    RelayJob, create_control_pipe, pipe_client_is_current_user, pipe_client_pid,
    pipe_owner_is_current_user,
};
