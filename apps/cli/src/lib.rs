//! Shared implementation for the `wsmp` binary.
//!
//! The binary entry point stays thin, while command definitions, config, exit
//! codes, logging, paths, and output helpers live here so they can be tested and
//! documented like normal Rust code.

pub mod auth;
pub mod cli;
pub mod commands;
pub mod config;
pub mod daemon;
pub mod exit;
pub mod logging;
pub mod media;
pub mod output;
pub mod paths;
pub mod probe;
pub mod protocol;
pub mod slug;
pub mod state;
