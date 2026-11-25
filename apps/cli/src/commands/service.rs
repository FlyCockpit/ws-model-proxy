//! `wsmp service`: install, uninstall, restart, and show the status and the
//! logs of the per-user relay service (`crate::service`, which knows the
//! service managers), printing what it did.

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
use std::fs;
#[cfg(any(target_os = "macos", windows))]
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::process::Command;

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
use anyhow::Context;
use anyhow::Result;
use clap::Subcommand;

use crate::output;

#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(subcommand)]
    command: CommandName,
}

#[derive(Debug, Subcommand)]
enum CommandName {
    /// Install, enable, and start the per-user relay service.
    Install,
    /// Stop, disable, and remove the per-user relay service.
    Uninstall,
    /// Print the per-user relay service status.
    Status,
    /// Restart the per-user relay service (after `wsmp login`, or to apply
    /// settings read only at start).
    Restart,
    /// Print the relay service's logs (journald on Linux, the launchd log
    /// files on macOS, the relay's own log file on Windows).
    Logs(LogsArgs),
}

#[derive(Debug, clap::Args)]
struct LogsArgs {
    /// Keep printing new lines as they come.
    #[arg(short, long)]
    follow: bool,
    /// How many of the latest lines to print first.
    #[arg(short = 'n', long, default_value_t = 100)]
    lines: u32,
}

pub fn run(args: &Args) -> Result<()> {
    match &args.command {
        CommandName::Install => {
            crate::trust::refuse_in_job("wsmp service install")?;
            install(false)
        }
        CommandName::Uninstall => {
            crate::trust::refuse_in_job("wsmp service uninstall")?;
            uninstall()
        }
        CommandName::Status => status(),
        CommandName::Restart => {
            crate::trust::refuse_in_job("wsmp service restart")?;
            restart()
        }
        // Read-only.
        CommandName::Logs(logs_args) => logs(logs_args),
    }
}

/// The binary `wsmp service install` makes the service run: this one, except
/// that a Homebrew keg's versioned `Cellar/wsmp/<version>/bin/wsmp` becomes
/// the stable `<prefix>/opt/wsmp/bin/wsmp` link (`brew upgrade` and `brew
/// cleanup` remove old kegs). A Homebrew update passes its own stable path to
/// [`ensure_stable_executable`](crate::service::files::ensure_stable_executable) instead.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn executable() -> Result<String> {
    let exe = std::env::current_exe().context("resolving the wsmp executable")?;
    let exe = std::fs::canonicalize(&exe)
        .ok()
        .and_then(|canonical| crate::update::homebrew::stable_path(&canonical))
        .filter(|stable| stable.exists())
        .unwrap_or(exe);
    exe.into_os_string()
        .into_string()
        .map_err(|_| anyhow::anyhow!("wsmp executable path is not valid UTF-8"))
}

/// After `wsmp login`, a relay service that stopped on a rejected credential
/// (exit 4, which systemd does not restart) needs a manual restart.
pub fn restart_hint_after_login() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        if crate::service::service_file().is_ok_and(|file| file.exists()) {
            return Some(
                "if the relay service stopped for lack of a credential, restart it: `wsmp service restart`"
                    .to_string(),
            );
        }
    }
    None
}

/// A line of install output: stdout, or stderr when the caller's stdout
/// carries JSON (`wsmp login --json`).
#[cfg_attr(
    not(any(target_os = "linux", target_os = "macos", windows)),
    allow(dead_code)
)]
fn say(to_stderr: bool, text: impl std::fmt::Display) -> Result<()> {
    if to_stderr {
        output::diagnostic(text)
    } else {
        output::line(text)
    }
}

/// Why `wsmp service install` refuses on Linux, decided before anything is
/// written; None to go ahead.
///
/// - As root: always. The service is a systemd user unit, and runtimes
///   (transient user units), the update dead-man (a user timer), the in-job
///   guard and every command, terminal and file tool the web app runs here
///   run as the account wsmp runs as. As root that would give the server
///   root on this machine, so wsmp asks for an ordinary account instead
///   ([`root_install_refusal`]). `reachable` is not asked.
/// - Otherwise when `systemctl --user` cannot reach the user manager
///   (`reachable`), which would fail only after the unit was written.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn linux_install_refusal(
    root: bool,
    reachable: impl FnOnce() -> std::result::Result<(), String>,
    account: &str,
    server: Option<&str>,
) -> Option<String> {
    if root {
        return Some(format!(
            "{}\n  to run the relay as root anyway, without a service (in a container, say): \
             `wsmp run` in the foreground",
            root_install_refusal(server)
        ));
    }
    let why = reachable().err()?;
    Some(format!(
        "`systemctl --user` cannot reach your systemd user manager, so the relay service \
         cannot be installed; nothing was written ({why})\n  \
         this happens when the manager is not running for `{account}` (no login session, and \
         lingering off), or without systemd (a container). If lingering is already on and the \
         manager is only slow to answer, run `wsmp service install` again\n  \
         fix it once (as an administrator): sudo loginctl enable-linger {account}\n  \
         then run `wsmp service install` again (lingering starts your user manager now and \
         at every boot); without systemd, run `wsmp run` in the foreground instead"
    ))
}

/// What wsmp says, as root, instead of installing its service (`wsmp service
/// install`, and `wsmp login` before it enrolls): why, and the commands that
/// set wsmp up under an ordinary account. `server` fills in the commands
/// when known.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn root_install_refusal(server: Option<&str>) -> String {
    let server = server.unwrap_or("<server>");
    format!(
        "wsmp does not install its relay service as root; nothing was written. the service is \
         a systemd user unit, and the runtimes, node commands, browser terminals and file tools \
         the web app runs on this node all run as the account wsmp runs as: as root, the server \
         would control this machine as root\n\
         run wsmp as an ordinary account instead (any unprivileged account; `wsmp` here); as \
         root, once:\n  \
         useradd --create-home --shell /bin/bash wsmp\n  \
         usermod -aG video,render wsmp    # GPU access for engines, where these groups exist\n  \
         loginctl enable-linger wsmp      # its service starts at boot, without a login\n  \
         su - wsmp\n\
         then, as `wsmp`:\n  \
         curl -fsSL {server}/install.sh | sh\n  \
         ~/.cargo/bin/wsmp login {server} --code <enrollment code>\n\
         if this machine is already enrolled as root, run `wsmp logout` as root and delete \
         that node in the web app"
    )
}

/// Whether `systemctl --user` reaches a user manager (with [`crate::service::user_bus_env`]):
/// why not, as one line (`systemctl`'s own error, a timeout, a missing
/// `systemctl`), when it does not. Bounded and quiet.
#[cfg(target_os = "linux")]
fn user_manager_reachable() -> std::result::Result<(), String> {
    crate::service::run_finite_within(
        "systemctl",
        &["--user", "show", "--property=Version"],
        std::time::Duration::from_secs(15),
    )
    .map_err(|error| {
        format!("{error:#}")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    })
}

#[cfg(target_os = "linux")]
pub fn install(to_stderr: bool) -> Result<()> {
    let server = crate::config::Config::load()
        .ok()
        .and_then(|config| config.server_url);
    if let Some(refusal) = linux_install_refusal(
        nix::unistd::Uid::effective().is_root(),
        user_manager_reachable,
        &login_account(),
        server.as_deref(),
    ) {
        anyhow::bail!(refusal);
    }
    let file = crate::service::service_file()?;
    let executable = executable()?;
    let pinned = crate::service::path_env::pinned_service_env()?;
    let unit = crate::service::text::render_systemd_user_unit(&executable, &pinned)?;
    crate::service::files::write_service_file(&file, &unit)?;
    crate::service::run_command("systemctl", &["--user", "daemon-reload"])?;
    // enable --now is idempotent enough for reinstall/upgrade: unit path is
    // rewritten above, then reloaded and (re)started.
    crate::service::run_command(
        "systemctl",
        &["--user", "enable", "--now", crate::service::LINUX_UNIT],
    )?;
    // Restart so an already-running unit picks up a replaced binary/unit.
    crate::service::run_finite(
        "systemctl",
        &["--user", "restart", crate::service::LINUX_UNIT],
    )?;
    print_install_notes(&pinned, to_stderr)?;
    say(
        to_stderr,
        format!("installed and started `{}`", file.display()),
    )
}

#[cfg(target_os = "macos")]
pub fn install(to_stderr: bool) -> Result<()> {
    use crate::service::MACOS_LABEL;
    let file = crate::service::service_file()?;
    // Checked before anything is written: `launchctl bootstrap` is given it.
    let file_text = crate::service::text::path_text("the relay service", &file)?;
    let executable = executable()?;

    let wrapper = crate::service::macos_wrapper_path()?;
    let pinned = crate::service::path_env::pinned_service_env()?;
    // Both rendered before anything is written: a value neither file can
    // hold is an error with the old files as they were.
    let wrapper_body = crate::service::text::render_macos_service_wrapper(&executable, &pinned)?;
    let plist = crate::service::text::macos_plist(&wrapper)?;
    if let Some(parent) = wrapper.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating `{}`", parent.display()))?;
        crate::service::files::set_private_dir(parent)?;
    }
    crate::service::files::write_private_script(&wrapper, wrapper_body.as_bytes())?;

    let log_dir = crate::service::macos_log_dir()?;
    fs::create_dir_all(&log_dir).with_context(|| format!("creating `{}`", log_dir.display()))?;
    crate::service::files::write_service_file(&file, &plist)?;

    let domain = crate::service::launchd::launchd_domain()?;
    // Reinstall: boot out the loaded agent, wait until launchd has unloaded
    // it, then bootstrap (tried again while it fails) and kickstart; a first
    // install only bootstraps and kickstarts. All bounded, in one deadline.
    crate::service::launchd::restart_launch_agent(
        &mut crate::service::launchd::SystemLaunchctl,
        crate::service::launchd::LaunchAgentCaller::Install,
        &domain,
        &format!("{domain}/{MACOS_LABEL}"),
        file_text,
        std::time::Instant::now() + crate::service::FINITE_COMMAND_TIMEOUT,
    )?;

    print_install_notes(&pinned, to_stderr)?;
    say(
        to_stderr,
        format!("installed and started `{}`", file.display()),
    )
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn install(_to_stderr: bool) -> Result<()> {
    let _ = crate::service::service_file()?;
    unreachable!()
}

#[cfg(target_os = "linux")]
fn uninstall() -> Result<()> {
    let file = crate::service::service_file()?;
    let _ = Command::new("systemctl")
        .args(["--user", "disable", "--now", crate::service::LINUX_UNIT])
        .envs(crate::service::user_bus_env())
        .status();
    if file.exists() {
        fs::remove_file(&file).with_context(|| format!("removing `{}`", file.display()))?;
    }
    let _ = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .envs(crate::service::user_bus_env())
        .status();
    output::line("uninstalled relay service")
}

#[cfg(target_os = "macos")]
fn uninstall() -> Result<()> {
    let file = crate::service::service_file()?;
    let domain = crate::service::launchd::launchd_domain()?;
    crate::service::launchd::bootout_if_loaded(&domain, &file);
    if file.exists() {
        fs::remove_file(&file).with_context(|| format!("removing `{}`", file.display()))?;
    }
    if let Ok(wrapper) = crate::service::macos_wrapper_path()
        && wrapper.exists()
    {
        let _ = fs::remove_file(&wrapper);
    }
    output::line("uninstalled relay service")
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn uninstall() -> Result<()> {
    let _ = crate::service::service_file()?;
    unreachable!()
}

#[cfg(target_os = "linux")]
fn status() -> Result<()> {
    // Checked first: `systemctl status` exits non-zero for a stopped unit,
    // which is exactly when this warning matters.
    if crate::service::installed()
        && let Some(warning) = linger_status_warning(linger_on(), &login_account())
    {
        output::diagnostic(format!("warning: {warning}"))?;
    }
    crate::service::run_command(
        "systemctl",
        &["--user", "status", crate::service::LINUX_UNIT],
    )
}

#[cfg(target_os = "macos")]
fn status() -> Result<()> {
    use crate::service::MACOS_LABEL;
    let domain = crate::service::launchd::launchd_domain()?;
    crate::service::run_command("launchctl", &["print", &format!("{domain}/{MACOS_LABEL}")])
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn status() -> Result<()> {
    let _ = crate::service::service_file()?;
    unreachable!()
}

#[cfg(target_os = "linux")]
fn restart() -> Result<()> {
    use crate::service::LINUX_UNIT;
    crate::service::require_installed()?;
    crate::service::run_command("systemctl", &["--user", "restart", LINUX_UNIT])?;
    output::line(format!("restarted `{LINUX_UNIT}`"))
}

#[cfg(target_os = "macos")]
fn restart() -> Result<()> {
    use crate::service::MACOS_LABEL;
    crate::service::restart_quietly(crate::service::Restart::Loaded)?;
    output::line(format!("restarted `{MACOS_LABEL}`"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn restart() -> Result<()> {
    let _ = crate::service::service_file()?;
    unreachable!()
}

/// `journalctl` arguments for the relay unit's logs.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn journalctl_args(args: &LogsArgs) -> Vec<String> {
    let mut out = vec![
        "--user".to_string(),
        "--unit".to_string(),
        "wsmp.service".to_string(),
        "--lines".to_string(),
        args.lines.to_string(),
        "--no-pager".to_string(),
    ];
    if args.follow {
        out.push("--follow".to_string());
    }
    out
}

#[cfg(target_os = "linux")]
fn logs(args: &LogsArgs) -> Result<()> {
    let argv = journalctl_args(args);
    let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
    crate::service::run_command("journalctl", &argv)
}

/// The launchd agent writes stdout and stderr to files; `tail` them.
#[cfg(target_os = "macos")]
fn logs(args: &LogsArgs) -> Result<()> {
    let dir = crate::service::macos_log_dir()?;
    // The paths go to `tail` as they are (never as text).
    let files: Vec<PathBuf> = ["relay.err.log", "relay.out.log"]
        .iter()
        .map(|name| dir.join(name))
        .filter(|path| path.exists())
        .collect();
    anyhow::ensure!(
        !files.is_empty(),
        "no relay service logs in `{}` yet",
        dir.display()
    );
    let lines = args.lines.to_string();
    let mut argv = vec![std::ffi::OsStr::new("-n"), lines.as_ref()];
    if args.follow {
        argv.push("-F".as_ref());
    }
    argv.extend(files.iter().map(|file| file.as_os_str()));
    crate::service::run_command("tail", &argv)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn logs(_args: &LogsArgs) -> Result<()> {
    let _ = crate::service::service_file()?;
    unreachable!()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn print_install_notes(pinned: &[(&str, String)], to_stderr: bool) -> Result<()> {
    for (name, value) in pinned {
        say(to_stderr, format!("service pins `{name}` to `{value}`"))?;
    }
    // The same review pinned_service_env made of this PATH, now reported.
    if let Ok(path) = std::env::var("PATH") {
        let review = crate::service::path_env::service_path(
            &path,
            crate::service::path_env::inspect_service_path_dir,
            &crate::service::path_env::SessionDirs::current(),
        );
        for line in crate::service::path_env::session_path_notes(&review.session)
            .into_iter()
            .chain(crate::service::path_env::service_path_warnings(
                &review.risky,
            ))
        {
            say(to_stderr, line)?;
        }
    }
    say(
        to_stderr,
        "node secrets are read from `secrets.env` (`wsmp secret`); the service needs no environment file",
    )?;
    #[cfg(target_os = "linux")]
    {
        let account = login_account();
        let outcome = ensure_linger(linger_on, || enable_linger(&account));
        for line in linger_install_lines(outcome, &account) {
            say(to_stderr, line)?;
        }
    }
    Ok(())
}

/// What `wsmp service install` found and did about systemd lingering.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LingerOutcome {
    /// Already on: nothing to do.
    AlreadyOn,
    /// Was off; `loginctl enable-linger` for this account turned it on.
    Enabled,
    /// Off, and enabling it as this account was refused (logind's polkit
    /// rule, or no logind answer): the person must run the command.
    Refused,
    /// `loginctl` could not say (no logind, a container), before and after
    /// trying to enable it.
    Unknown,
}

/// Turn lingering on for the installing account unless it is on. `query`
/// reads the state (`None`: unknown), `enable` tries
/// `loginctl enable-linger <account>` (never sudo, never a password
/// prompt); the state is read again after it, so only a confirmed `yes`
/// counts as enabled.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn ensure_linger(
    query: impl Fn() -> Option<bool>,
    enable: impl FnOnce(),
) -> LingerOutcome {
    let before = query();
    if before == Some(true) {
        return LingerOutcome::AlreadyOn;
    }
    // Unknown is tried too: `loginctl show-user` fails for an account with
    // no session and no lingering, which is lingering off. Without logind
    // the try fails at once.
    enable();
    match (before, query()) {
        (_, Some(true)) => LingerOutcome::Enabled,
        (None, _) => LingerOutcome::Unknown,
        (Some(_), _) => LingerOutcome::Refused,
    }
}

/// The install notes for a [`LingerOutcome`], naming `account` in the
/// exact command to run.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn linger_install_lines(outcome: LingerOutcome, account: &str) -> Vec<String> {
    match outcome {
        LingerOutcome::AlreadyOn => Vec::new(),
        LingerOutcome::Enabled => vec![format!(
            "enabled systemd lingering for `{account}` (`loginctl enable-linger {account}`): the \
             service now starts at boot and keeps running after you log out"
        )],
        LingerOutcome::Refused => vec![
            format!(
                "warning: systemd lingering is off for `{account}` and wsmp could not turn it on \
                 as you, so this service stops when you log out, does not start at boot, and the \
                 node cannot start runtimes"
            ),
            format!("  fix it once (as an administrator): sudo loginctl enable-linger {account}"),
        ],
        LingerOutcome::Unknown => vec![format!(
            "warning: could not read systemd lingering for `{account}` (`loginctl show-user`); \
             without it this service stops when you log out and does not start at boot. If \
             logind runs here, enable it once: loginctl enable-linger {account}"
        )],
    }
}

/// The `wsmp status` / `wsmp service status` warning for an installed user
/// service without lingering; None when lingering is on.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn linger_status_warning(linger: Option<bool>, account: &str) -> Option<String> {
    match linger {
        Some(true) => None,
        Some(false) => Some(format!(
            "systemd lingering is off for `{account}`: the relay service stops when you log out \
             and does not start at boot, and the node cannot start runtimes. Fix: \
             `loginctl enable-linger {account}` (or `wsmp service install`, which tries it)"
        )),
        None => Some(format!(
            "could not read systemd lingering for `{account}`: if the relay service stops at \
             logout, run `loginctl enable-linger {account}`"
        )),
    }
}

/// Bound on each `loginctl` call: logind answers at once or not at all.
#[cfg(target_os = "linux")]
const LOGINCTL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The installing account's login name (its uid when it has none).
#[cfg(target_os = "linux")]
pub(crate) fn login_account() -> String {
    let uid = nix::unistd::Uid::effective();
    nix::unistd::User::from_uid(uid)
        .ok()
        .flatten()
        .map_or_else(|| uid.as_raw().to_string(), |user| user.name)
}

/// Whether logind keeps this user's manager running without a session;
/// `None` when `loginctl` cannot say. Bounded.
#[cfg(target_os = "linux")]
pub(crate) fn linger_on() -> Option<bool> {
    let uid = nix::unistd::Uid::effective().as_raw().to_string();
    let args = ["show-user".to_string(), uid, "-p".into(), "Linger".into()];
    match crate::bounded_run::run_bounded("loginctl", &args, LOGINCTL_TIMEOUT, 4096) {
        crate::bounded_run::Bounded::Output(text) => {
            Some(crate::runtimes::executor::native::linger_enabled(&text))
        }
        _ => None,
    }
}

/// `loginctl --no-ask-password enable-linger <account>`: logind's polkit
/// rule usually lets an account set its own lingering. Bounded and quiet;
/// the caller reads the state again to see whether it worked.
#[cfg(target_os = "linux")]
fn enable_linger(account: &str) {
    let args = [
        "--no-ask-password".to_string(),
        "enable-linger".into(),
        account.to_string(),
    ];
    let _ = crate::bounded_run::run_bounded("loginctl", &args, LOGINCTL_TIMEOUT, 4096);
}

/// An update has not confirmed yet (its dead-man may still roll back). A
/// state that cannot be read counts as pending: moving the task during a
/// trial from 0.4.x would leave its rollback without a task to restart.
#[cfg(windows)]
fn update_trial_pending() -> bool {
    match crate::update::update_dir().and_then(|dir| crate::update::state::load(&dir)) {
        Ok(current) => current.is_some_and(|current| current.in_progress()),
        Err(error) => {
            tracing::warn!(
                error = %format!("{error:#}"),
                "the update state could not be read; treating an update as on trial"
            );
            true
        }
    }
}

#[cfg(windows)]
pub fn install(to_stderr: bool) -> Result<()> {
    let absolute = |path: PathBuf| -> Result<String> {
        std::path::absolute(&path)
            .with_context(|| format!("resolving `{}`", path.display()))?
            .into_os_string()
            .into_string()
            .map_err(|_| anyhow::anyhow!("`{}` is not valid UTF-8", path.display()))
    };
    let executable = executable()?;
    let config = absolute(crate::paths::config_file()?)?;
    let state_dir = absolute(crate::paths::state_dir()?)?;
    let log_file = absolute(crate::service::task_scheduler::windows_log_file()?)?;
    let home = dirs::home_dir().context("could not determine the user home directory")?;
    let sid = wsmp_windows::current_user_sid().context("reading this user's SID")?;
    let arguments =
        crate::service::windows_task::arguments(&executable, &config, &state_dir, &log_file);
    let xml = crate::service::windows_task::render_xml(
        &sid,
        &arguments,
        crate::service::text::path_text("the home directory", &home)?,
    );
    let file = crate::service::service_file()?;
    // Checked before the file is written: `schtasks` is given it.
    let file_arg = crate::service::text::path_text("the task definition", &file)?.to_string();
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating `{}`", parent.display()))?;
    }
    fs::write(&file, crate::service::windows_task::utf16_bytes(&xml))
        .with_context(|| format!("writing `{}`", file.display()))?;
    let (names, account) = crate::service::task_scheduler::relay_task_names()?;
    // Registered under the SID name; this account's 0.4.x task, if any, is
    // ended and deleted after it (task_names::register). While an update from
    // 0.4.x is on trial, the 0.4.x name stays (its rollback restarts it).
    let registered = crate::service::task_names::register(
        &crate::service::task_scheduler::SystemTasks,
        &names,
        &account,
        &file_arg,
        update_trial_pending(),
    )?;
    let name = registered.name.clone();
    // Reinstall or upgrade: a running relay is replaced by the new binary.
    crate::service::task_scheduler::end_windows_task(&name);
    crate::service::task_scheduler::schtasks(&["/Run", "/TN", &name])?;
    for note in registered.notes() {
        say(to_stderr, note)?;
    }
    for (option, value) in [
        ("--config", &config),
        ("--state-dir", &state_dir),
        ("--log-file", &log_file),
    ] {
        say(to_stderr, format!("service pins `{option}` to `{value}`"))?;
    }
    say(
        to_stderr,
        "node secrets are read from `secrets.env` (`wsmp secret`); the service needs no environment",
    )?;
    say(
        to_stderr,
        "the relay runs while you are logged on to Windows and stops when you log off",
    )?;
    say(
        to_stderr,
        format!("installed and started the scheduled task `{name}`"),
    )?;
    registered.into_result()
}

#[cfg(windows)]
fn uninstall() -> Result<()> {
    let (names, account) = crate::service::task_scheduler::relay_task_names()?;
    // The SID-named task and this account's 0.4.x one; already gone is fine.
    // A failed query or delete stops here, with the definition file kept.
    let done = crate::service::task_names::unregister(
        &crate::service::task_scheduler::SystemTasks,
        &names,
        &account,
    )?;
    for note in done.notes() {
        output::diagnostic(note)?;
    }
    let file = crate::service::service_file()?;
    if file.exists() {
        fs::remove_file(&file).with_context(|| format!("removing `{}`", file.display()))?;
    }
    output::line("uninstalled relay service")
}

#[cfg(windows)]
fn status() -> Result<()> {
    let name = crate::service::task_scheduler::windows_task_name()?;
    output::line(crate::service::task_scheduler::schtasks(&[
        "/Query", "/TN", &name, "/V", "/FO", "LIST",
    ])?)
}

#[cfg(windows)]
fn restart() -> Result<()> {
    let file = crate::service::service_file()?;
    anyhow::ensure!(
        file.exists(),
        "the relay service is not installed (`{}` is missing); run `wsmp service install`",
        file.display()
    );
    let name = crate::service::task_scheduler::windows_task_name()?;
    crate::service::task_scheduler::end_windows_task(&name);
    crate::service::task_scheduler::schtasks(&["/Run", "/TN", &name])?;
    output::line(format!("restarted the scheduled task `{name}`"))
}

/// The relay's own log file: the last lines, then (with `--follow`) new ones
/// as they come, across roll-overs.
#[cfg(windows)]
fn logs(args: &LogsArgs) -> Result<()> {
    use std::io::{Read, Seek, SeekFrom};

    let path = crate::service::task_scheduler::windows_log_file()?;
    let mut file = fs::File::open(&path)
        .with_context(|| format!("no relay service log at `{}` yet", path.display()))?;
    let identity = |file: &fs::File| -> Result<_> {
        let id = wsmp_windows::file_identity(file)?;
        Ok((id.volume, id.index))
    };
    let mut previous_identity = identity(&file)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    drop(file);
    let mut follow = LogFollow::new(&bytes);
    let shown = if args.follow {
        &bytes[..bytes.len() - follow.pending.len()]
    } else {
        &bytes
    };
    let text = String::from_utf8_lossy(shown);
    for line in crate::service::windows_task::last_lines(&text, args.lines as usize) {
        output::line(line)?;
    }
    if !args.follow {
        return Ok(());
    }
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let Ok(mut file) = fs::File::open(&path) else {
            continue;
        };
        let current_identity = identity(&file)?;
        let len = file.metadata()?.len();
        follow.observe_file(len, current_identity != previous_identity);
        previous_identity = current_identity;
        if len == follow.position {
            continue;
        }
        file.seek(SeekFrom::Start(follow.position))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        for line in follow.push(&bytes) {
            output::line(line)?;
        }
    }
}

/// Follow raw bytes: a UTF-8 code point may straddle any two reads. Decode only
/// completed lines, retaining their unfinished suffix across reads.
#[cfg(any(windows, test))]
struct LogFollow {
    position: u64,
    pending: Vec<u8>,
}

#[cfg(any(windows, test))]
impl LogFollow {
    fn new(initial: &[u8]) -> Self {
        let start = initial
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |end| end + 1);
        Self {
            position: initial.len() as u64,
            pending: initial[start..].to_vec(),
        }
    }

    fn observe_file(&mut self, len: u64, replaced: bool) {
        if replaced || len < self.position {
            self.position = 0;
            self.pending.clear();
        }
    }

    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.position += bytes.len() as u64;
        self.pending.extend_from_slice(bytes);
        let Some(end) = self.pending.iter().rposition(|byte| *byte == b'\n') else {
            return Vec::new();
        };
        let lines = self.pending[..=end]
            .split_inclusive(|byte| *byte == b'\n')
            .map(|line| {
                String::from_utf8_lossy(line)
                    .trim_end_matches(['\r', '\n'])
                    .to_string()
            })
            .collect();
        self.pending.drain(..=end);
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_follow_tracks_raw_offsets_and_preserves_split_utf8() {
        let initial = b"bad \xff\n\xe2";
        let mut log = LogFollow::new(initial);
        assert_eq!(log.position, initial.len() as u64);
        assert!(log.push(b"\x82").is_empty());
        assert_eq!(log.push(b"\xac\r\nnext \xff\n"), ["€", "next �"]);
        assert_eq!(
            log.position,
            (initial.len() + 1 + b"\xac\r\nnext \xff\n".len()) as u64
        );
        assert!(log.pending.is_empty());
    }

    #[test]
    fn log_follow_discards_partial_lines_on_truncation_and_replacement() {
        let mut log = LogFollow::new(b"old partial \xe2");
        log.observe_file(2, false);
        assert_eq!(log.position, 0);
        assert_eq!(log.push(b"new\n"), ["new"]);
        assert!(log.push(b"partial").is_empty());
        log.observe_file(100, true);
        assert_eq!(log.position, 0);
        assert_eq!(log.push(b"replacement\n"), ["replacement"]);
    }

    #[test]
    fn root_is_refused_before_anything_is_written_or_asked() {
        let asked = std::cell::Cell::new(false);
        let refusal = linux_install_refusal(
            true,
            || {
                asked.set(true);
                Ok(())
            },
            "root",
            Some("https://wsmp.example.com"),
        )
        .expect("root is refused");
        assert!(!asked.get(), "root never probes the user manager");
        assert!(
            refusal.starts_with(
                "wsmp does not install its relay service as root; nothing was written"
            )
        );
        // The exact commands, with the server filled in.
        for command in [
            "useradd --create-home --shell /bin/bash wsmp",
            "loginctl enable-linger wsmp",
            "su - wsmp",
            "curl -fsSL https://wsmp.example.com/install.sh | sh",
            "~/.cargo/bin/wsmp login https://wsmp.example.com --code <enrollment code>",
            "`wsmp logout`",
            "`wsmp run` in the foreground",
        ] {
            assert!(refusal.contains(command), "{command}: {refusal}");
        }
        // Root is told to run nothing with sudo: it needs none.
        assert!(!refusal.contains("sudo"), "{refusal}");
        // No server known: a placeholder.
        let unknown = root_install_refusal(None);
        assert!(
            unknown.contains("curl -fsSL <server>/install.sh | sh"),
            "{unknown}"
        );
    }

    #[test]
    fn an_unreachable_user_manager_is_refused_before_the_unit_is_written() {
        let refusal = linux_install_refusal(
            false,
            || Err("`systemctl` failed: Failed to connect to bus".to_string()),
            "ada",
            None,
        )
        .expect("no user manager is refused");
        assert!(refusal.contains("nothing was written"), "{refusal}");
        // systemctl's own reason is kept, so a timeout reads differently from no manager.
        assert!(refusal.contains("Failed to connect to bus"), "{refusal}");
        assert!(
            refusal.contains("sudo loginctl enable-linger ada"),
            "{refusal}"
        );
        assert!(
            refusal.contains("`wsmp run` in the foreground"),
            "{refusal}"
        );
        // A reachable manager: install goes ahead.
        assert_eq!(linux_install_refusal(false, || Ok(()), "ada", None), None);
    }

    #[test]
    fn linger_is_enabled_when_off_and_reread_before_claiming_it() {
        use std::cell::{Cell, RefCell};
        // Off, and enabling works.
        let state = Cell::new(Some(false));
        let tried = Cell::new(0);
        let outcome = ensure_linger(
            || state.get(),
            || {
                tried.set(tried.get() + 1);
                state.set(Some(true));
            },
        );
        assert_eq!((outcome, tried.get()), (LingerOutcome::Enabled, 1));
        // Off, and logind refuses: still off after the try.
        let tried = RefCell::new(0);
        assert_eq!(
            ensure_linger(|| Some(false), || *tried.borrow_mut() += 1),
            LingerOutcome::Refused
        );
        assert_eq!(*tried.borrow(), 1);
        // On: nothing is tried.
        let never = || panic!("must not try");
        assert_eq!(
            ensure_linger(|| Some(true), never),
            LingerOutcome::AlreadyOn
        );
        // Unknown (no session and no lingering makes `show-user` fail): tried,
        // and enabled once the state reads `yes`; still unknown otherwise.
        let state = Cell::new(None);
        assert_eq!(
            ensure_linger(|| state.get(), || state.set(Some(true))),
            LingerOutcome::Enabled
        );
        let tried = Cell::new(false);
        assert_eq!(
            ensure_linger(|| None, || tried.set(true)),
            LingerOutcome::Unknown
        );
        assert!(tried.get());
        // An enable that leaves the state unreadable is not claimed as done.
        let state = Cell::new(Some(false));
        assert_eq!(
            ensure_linger(|| state.get(), || state.set(None)),
            LingerOutcome::Refused
        );
    }

    #[test]
    fn linger_notes_name_the_exact_command() {
        assert!(linger_install_lines(LingerOutcome::AlreadyOn, "alice").is_empty());
        let enabled = linger_install_lines(LingerOutcome::Enabled, "alice");
        assert!(enabled[0].starts_with("enabled systemd lingering for `alice`"));
        let refused = linger_install_lines(LingerOutcome::Refused, "alice");
        assert!(refused[0].starts_with("warning: systemd lingering is off for `alice`"));
        assert_eq!(
            refused[1],
            "  fix it once (as an administrator): sudo loginctl enable-linger alice"
        );
        let unknown = linger_install_lines(LingerOutcome::Unknown, "alice");
        assert!(
            unknown[0].ends_with("loginctl enable-linger alice"),
            "{unknown:?}"
        );
        assert_eq!(linger_status_warning(Some(true), "alice"), None);
        assert!(
            linger_status_warning(Some(false), "alice")
                .is_some_and(|warning| warning.contains("`loginctl enable-linger alice`"))
        );
    }

    #[test]
    fn logs_ask_journald_for_the_relay_unit() {
        let args = LogsArgs {
            follow: true,
            lines: 50,
        };
        assert_eq!(
            journalctl_args(&args),
            [
                "--user",
                "--unit",
                "wsmp.service",
                "--lines",
                "50",
                "--no-pager",
                "--follow"
            ]
        );
    }
}
