//! Shared implementation for the `wsmp` binary.
//!
//! The binary entry point stays thin, while command definitions, config, exit
//! codes, logging, paths, and output helpers live here so they can be tested and
//! documented like normal Rust code.

pub mod approvals;
pub mod auth;
pub mod child_env;
pub mod cli;
pub mod commands;
pub mod config;
pub mod control;
pub mod daemon;
pub mod display_escape;
pub mod engine;
pub mod exit;
#[cfg(unix)]
pub mod file_ops;
pub mod hostname;
pub mod logging;
pub mod media;
pub mod output;
pub mod paths;
pub mod probe;
pub mod protocol;
pub mod relay_bus;
pub mod sessions;
pub mod shutdown;
pub mod slug;
pub mod startup;
pub mod state;
pub mod supervised_run;
pub mod telemetry;
pub mod telemetry_bounds;
pub mod terminal_crypto;
pub mod terminal_identity;
pub mod terminal_parse;
pub mod tls;
pub mod tokens;
