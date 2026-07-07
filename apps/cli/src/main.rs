//! Binary entry point.
//!
//! Responsibilities, in order:
//!   1. Parse arguments (clap).
//!   2. Initialize logging.
//!   3. Dispatch to the chosen subcommand.
//!   4. Map any error to a process exit code and a clean stderr message.
//!
//! Keep this file small. Real work belongs in `src/commands/`.

use clap::Parser;

use wsmp::cli::{Cli, Command};
use wsmp::exit::ExitCode;
use wsmp::{commands, exit, logging, output};

fn main() {
    let cli = Cli::parse();
    logging::init(cli.log_format, cli.verbose, cli.quiet);

    let code = match run(&cli) {
        Ok(()) => ExitCode::Success,
        Err(err) if exit::is_broken_pipe(&err) => ExitCode::Success,
        Err(err) => {
            // Identifiers in error messages are wrapped in `backticks`, never
            // 'single quotes' — see AGENTS.md.
            let _ = output::diagnostic(format!("error: {}", exit::message_for(&err)));
            exit::code_for(&err)
        }
    };

    let _ = output::flush_stdout();
    std::process::exit(code as i32);
}

/// Dispatch to the selected subcommand. Returning `Result` here keeps `main`
/// free of branching and lets every command use `?`.
fn run(cli: &Cli) -> anyhow::Result<()> {
    match &cli.command {
        Command::Login(args) => commands::login::run(args),
        Command::Token(args) => commands::token::run(args),
        Command::Config(args) => commands::config::run(args),
        Command::Endpoints(args) => commands::endpoints::run(args),
        Command::Connect(args) => commands::connect::run(args),
        Command::Reload(args) => commands::reload::run(args),
        Command::Logout(args) => commands::logout::run(args),
        Command::Completions(args) => commands::completions::run(args),
    }
}
