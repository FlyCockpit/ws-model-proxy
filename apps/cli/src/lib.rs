//! Shared implementation for the `wsmp` binary.
//!
//! The binary entry point stays thin, while command definitions, config, exit
//! codes, logging, paths, and output helpers live here so they can be tested and
//! documented like normal Rust code.
//!
//! The modules sit in layers, each using only the ones below it (top first):
//! `app` (the command line), `relay` (the running relay), `services` (the work
//! the node does), `host` (the machine), `node` (what the node is, on disk),
//! `process` (child processes) and `wire` (the relay wire format). The leaves
//! every layer uses (`paths`, `slug`, `time`, `exit`, `display_escape`) stay
//! at the crate root.

pub mod app;
pub mod display_escape;
pub mod exit;
pub mod host;
pub mod node;
pub mod paths;
pub mod process;
pub mod relay;
pub mod services;
pub mod slug;
pub mod time;
pub mod wire;

#[cfg(all(test, windows))]
#[path = "../tests/support/windows_tree.rs"]
mod windows_test_tree;
