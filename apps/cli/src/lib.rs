//! Shared implementation for the `wsmp` binary.
//!
//! The binary entry point stays thin, while command definitions, config, exit
//! codes, logging, paths, and output helpers live here so they can be tested and
//! documented like normal Rust code.

pub mod approvals;
pub mod auth;
pub mod bounded_run;
pub mod child_env;
pub mod cli;
pub mod commands;
pub mod config;
pub mod control;
pub mod daemon;
pub mod display_escape;
pub mod engine;
pub mod engine_adapter;
pub mod exit;
#[cfg(unix)]
pub mod file_ops;
#[cfg(unix)]
pub mod file_relay;
pub mod hostname;
#[cfg(windows)]
mod job_tree;
pub mod logging;
pub mod machine_id;
pub mod media;
pub mod metric_sources;
pub mod output;
pub mod output_mask;
pub mod paths;
pub mod probe;
pub mod protocol;
pub mod relay_bus;
pub mod sessions;
pub mod shutdown;
pub mod slug;
pub mod startup;
pub mod state;
pub mod supervised_file;
pub mod supervised_run;
pub mod supervised_screen;
pub mod telemetry;
pub mod telemetry_bounds;
pub mod terminal_crypto;
pub mod terminal_identity;
pub mod terminal_parse;
pub mod tls;
pub mod tokens;

#[cfg(all(test, windows))]
#[path = "../tests/support/windows_tree.rs"]
mod windows_test_tree;
