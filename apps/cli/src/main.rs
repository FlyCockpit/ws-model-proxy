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
use wsmp::{commands, exit, logging, output, shutdown, tls};

fn main() {
    let cli = Cli::parse();
    tls::install_crypto_provider();
    logging::init(cli.log_format, cli.verbose, cli.quiet);
    // End metric-source runs before reporting a panic, including builds that
    // override the normal unwind strategy with abort (no `main` epilogue).
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        #[cfg(unix)]
        let contained_file_panic =
            cfg!(panic = "unwind") && wsmp::file_ops::pool::worker_panic_is_contained();
        #[cfg(not(unix))]
        let contained_file_panic = false;
        if !contained_file_panic {
            wsmp::bounded_run::kill_all_active_for_panic();
        }
        previous_hook(info);
    }));

    let code = match run(&cli) {
        Ok(()) => ExitCode::Success,
        Err(err) if exit::is_broken_pipe(&err) => ExitCode::Success,
        Err(err) => {
            // A relay stopped by SIGTERM/SIGINT/SIGHUP has already cleaned
            // up; die from the same signal so the parent sees the usual status.
            if let Some(signal) = shutdown::signal_of(&err) {
                let _ = output::flush_stdout();
                shutdown::terminate_by_signal(signal);
            }
            // Identifiers in error messages are wrapped in `backticks`, never
            // 'single quotes' — see AGENTS.md.
            let _ = output::diagnostic(format!("error: {}", exit::message_for(&err)));
            exit::code_for(&err)
        }
    };

    let _ = output::flush_stdout();
    // No metric-source command may outlive the process.
    wsmp::bounded_run::kill_all_active();
    std::process::exit(code as i32);
}

/// Dispatch to the selected subcommand. Returning `Result` here keeps `main`
/// free of branching and lets every command use `?`.
fn run(cli: &Cli) -> anyhow::Result<()> {
    match &cli.command {
        Command::Login(args) => commands::login::run(args),
        Command::Config(args) => commands::config::run(args),
        Command::Run(args) => commands::run::run(args),
        Command::Service(args) => commands::service::run(args),
        Command::Status(args) => commands::status::run(args),
        Command::Logout(args) => commands::logout::run(args),
        Command::Completions(args) => commands::completions::run(args),
        Command::Terminal(args) => commands::terminal::run(args),
        Command::Recover(args) => commands::recover::run(args),
    }
}
