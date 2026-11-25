//! Binary entry point.
//!
//! Responsibilities, in order:
//!   1. Parse arguments (clap).
//!   2. Initialize logging.
//!   3. Dispatch to the chosen subcommand.
//!   4. Map any error to a process exit code and a clean stderr message.
//!
//! Keep this file small. Real work belongs in `src/app/commands/`.

use clap::{CommandFactory, Parser};

use wsmp::app::cli::{Cli, Command};
use wsmp::exit::ExitCode;
use wsmp::{app::commands, app::logging, app::output, exit, process::shutdown, services::tls};

fn main() {
    let cli = Cli::parse();
    tls::install_crypto_provider();
    let log_file = match &cli.command {
        Command::Run(args) => args.log_file.as_deref(),
        _ => None,
    };
    logging::init(cli.log_format, cli.verbose, cli.quiet, log_file);
    // End metric-source runs before reporting a panic, including builds that
    // override the normal unwind strategy with abort (no `main` epilogue).
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        #[cfg(unix)]
        let contained_file_panic =
            cfg!(panic = "unwind") && wsmp::services::file_ops::pool::worker_panic_is_contained();
        #[cfg(not(unix))]
        let contained_file_panic = false;
        if !contained_file_panic {
            wsmp::process::bounded_run::kill_all_active_for_panic();
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
            let code = exit::code_for(&err);
            // A restart into an installed update is not an error; the relay
            // already logged it.
            if code != ExitCode::RestartForUpdate {
                let message = exit::message_for(&err);
                // A service relay's stderr may go nowhere (a headless Windows
                // task): its log file gets why it stopped too.
                if log_file.is_some() {
                    tracing::error!(error = %message, "the relay stopped");
                }
                let _ = output::diagnostic(format!("error: {message}"));
            }
            code
        }
    };

    let _ = output::flush_stdout();
    // No metric-source command may outlive the process.
    wsmp::process::bounded_run::kill_all_active();
    std::process::exit(code as i32);
}

/// Dispatch to the selected subcommand. Returning `Result` here keeps `main`
/// free of branching and lets every command use `?`.
fn run(cli: &Cli) -> anyhow::Result<()> {
    match &cli.command {
        Command::Login(args) => commands::setup::login::run(args),
        Command::Trust(args) => commands::setup::trust::run(args),
        Command::Secret(args) => commands::setup::secret::run(args),
        Command::Config(args) => commands::setup::config::run(args),
        Command::Run(args) => commands::operate::run::run(args),
        Command::Runtime(args) => commands::operate::runtime::run(args),
        Command::Service(args) => commands::setup::service::run(args),
        Command::Status(args) => commands::operate::status::run(args),
        Command::Hardware(args) => commands::operate::hardware::run(args),
        Command::Logout(args) => commands::setup::logout::run(args),
        Command::Completions(args) => commands::completions::run(args, Cli::command()),
        Command::Terminal(args) => commands::setup::terminal::run(args),
        Command::Recover(args) => commands::operate::recover::run(args),
        Command::Update(args) => commands::operate::update::run(args),
        Command::LaunchGuard(args) => commands::internal::launch_guard::run(args),
        #[cfg(windows)]
        Command::ConptyHost(args) => commands::internal::conpty_host::run(args),
        #[cfg(windows)]
        Command::RuntimeHost(args) => commands::internal::runtime_host::run(args),
        Command::LaunchGuardExec(args) => commands::internal::launch_guard::exec(args),
    }
}
