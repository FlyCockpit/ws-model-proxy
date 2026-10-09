//! Subcommand implementations.
//!
//! One module per subcommand. Each module exposes:
//!   - an `Args` struct (clap-derived) describing its flags/positionals, and
//!   - a `run(args: &Args) -> anyhow::Result<()>` function with the logic.
//!
//! `src/cli.rs` wires the `Args` into the top-level `Command` enum; `main.rs`
//! calls `run`. To add a command, follow the shape of an existing module, then
//! register it in both places.

pub mod completions;
pub mod config;
pub mod hardware;
pub mod login;
pub mod logout;
pub mod recover;
pub mod run;
pub mod runtime;
pub mod secret;
pub mod service;
pub mod status;
pub mod terminal;
pub mod trust;
