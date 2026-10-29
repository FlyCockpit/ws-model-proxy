//! Per-user service for the relay daemon: a systemd user unit (Linux), a
//! launchd agent that runs a small 0700 wrapper (macOS), or a Task Scheduler
//! task that starts at logon (Windows, see `windows_task`).
//!
//! The service needs no environment of its own: the node credential is in
//! the state directory and node secrets are in `secrets.env`, both of which
//! the relay reads itself. The unit (or wrapper) pins only the config and
//! state paths and `PATH` of the installing shell, never a secret.

use std::fs;
#[cfg(target_os = "macos")]
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
use std::process::Command;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::process::Stdio;

use anyhow::{Context, Result};
use clap::Subcommand;

use crate::output;

#[cfg(target_os = "linux")]
const LINUX_UNIT: &str = "wsmp.service";
#[cfg(target_os = "macos")]
const MACOS_LABEL: &str = "com.flycockpit.wsmp";
#[cfg(target_os = "macos")]
const MACOS_WRAPPER_NAME: &str = "wsmp-service-run.sh";

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

#[cfg(target_os = "linux")]
pub(crate) fn service_file() -> Result<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".config")))
        .context("could not determine the user config directory")?;
    Ok(base.join("systemd/user").join(LINUX_UNIT))
}

#[cfg(target_os = "macos")]
pub(crate) fn service_file() -> Result<PathBuf> {
    let home = dirs::home_dir().context("could not determine the user home directory")?;
    Ok(home
        .join("Library/LaunchAgents")
        .join(format!("{MACOS_LABEL}.plist")))
}

#[cfg(target_os = "macos")]
fn macos_wrapper_path() -> Result<PathBuf> {
    Ok(crate::paths::state_dir()?.join(MACOS_WRAPPER_NAME))
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_log_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().context("could not determine the user home directory")?;
    Ok(home.join("Library/Logs/ws-model-proxy"))
}

/// The task definition `wsmp service install` registered, kept beside the
/// state it pins (the task itself lives in Task Scheduler).
#[cfg(windows)]
pub(crate) fn service_file() -> Result<PathBuf> {
    Ok(crate::paths::state_dir()?.join(windows_task::DEFINITION_FILE))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn service_file() -> Result<PathBuf> {
    anyhow::bail!("service installation is only supported on Linux, macOS and Windows")
}

/// The binary the service runs: this one, except that a Homebrew keg's
/// versioned `Cellar/wsmp/<version>/bin/wsmp` becomes the stable
/// `<prefix>/opt/wsmp/bin/wsmp` link (`brew upgrade` and `brew cleanup`
/// remove old kegs).
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

/// Before a Homebrew upgrade: a service written by an older wsmp that
/// records a versioned `Cellar` path is written again with the stable `opt`
/// path (same pinned environment), so the restart finds the new keg.
pub fn ensure_stable_executable() -> Result<()> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        #[cfg(target_os = "linux")]
        let file = service_file()?;
        #[cfg(target_os = "macos")]
        let file = macos_wrapper_path()?;
        let Ok(current) = fs::read_to_string(&file) else {
            return Ok(());
        };
        if !current.contains("/Cellar/wsmp/") {
            return Ok(());
        }
        let executable = executable()?;
        let pinned = pinned_service_env()?;
        #[cfg(target_os = "linux")]
        {
            write_service_file(&file, &render_systemd_user_unit(&executable, &pinned))?;
            run_command("systemctl", &["--user", "daemon-reload"])?;
        }
        #[cfg(target_os = "macos")]
        write_private_script(
            &file,
            render_macos_service_wrapper(&executable, &pinned).as_bytes(),
        )?;
    }
    Ok(())
}

/// Restart the relay service without printing (the update dead-man and
/// `wsmp update`). An error when it is not installed.
pub fn restart_quietly() -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        require_installed()?;
        run_command("systemctl", &["--user", "restart", LINUX_UNIT])
    }
    #[cfg(target_os = "macos")]
    {
        require_installed()?;
        let domain = launchd_domain()?;
        // An installed agent that is not loaded (booted out) is loaded first:
        // `kickstart` fails on it (exit 113), where systemd and Task Scheduler
        // start a stopped service.
        if !agent_loaded(&domain) {
            let file = service_file()?;
            run_command(
                "launchctl",
                &["bootstrap", &domain, &file.display().to_string()],
            )?;
        }
        run_command(
            "launchctl",
            &["kickstart", "-k", &format!("{domain}/{MACOS_LABEL}")],
        )
    }
    #[cfg(windows)]
    {
        let file = service_file()?;
        anyhow::ensure!(file.exists(), "the relay service is not installed");
        let name = windows_task_name()?;
        end_windows_task(&name);
        schtasks(&["/Run", "/TN", &name]).map(|_| ())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        anyhow::bail!("service installation is only supported on Linux, macOS and Windows")
    }
}

/// Whether `wsmp service install` installed the relay service here.
pub fn installed() -> bool {
    service_file().is_ok_and(|file| file.exists())
}

/// Windows: start the relay task (a no-op while it runs: `IgnoreNew`).
#[cfg(windows)]
pub fn kick_relay_task() -> Result<()> {
    schtasks(&["/Run", "/TN", &windows_task_name()?]).map(|_| ())
}

/// After `wsmp login`, a relay service that stopped on a rejected credential
/// (exit 4, which systemd does not restart) needs a manual restart.
pub fn restart_hint_after_login() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        if service_file().is_ok_and(|file| file.exists()) {
            return Some(
                "if the relay service stopped for lack of a credential, restart it: `wsmp service restart`"
                    .to_string(),
            );
        }
    }
    None
}

/// Quote a single ExecStart argument for a systemd unit.
pub fn systemd_quote_arg(value: &str) -> String {
    let safe = value.chars().all(|ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-' | ':' | '@' | '+' | '=')
    });
    if safe {
        return value.to_string();
    }
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            // systemd treats `%` as a specifier in unit files.
            '%' => out.push_str("%%"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// Variables `wsmp service install` pins into the service so it resolves the
/// same config file and state directory (and so the same device credential)
/// as the shell that installed it, whatever `XDG_*` the service manager sets,
/// and so commands it starts find the same programs (`PATH`). Paths only: no
/// secret ever goes into the unit or wrapper.
pub fn pinned_service_env() -> Result<Vec<(&'static str, String)>> {
    let pin = |name: &'static str, path: PathBuf| -> Result<(&'static str, String)> {
        let path = std::path::absolute(&path)
            .with_context(|| format!("resolving `{}`", path.display()))?;
        let value = path
            .into_os_string()
            .into_string()
            .map_err(|_| anyhow::anyhow!("`{name}` path is not valid UTF-8"))?;
        Ok((name, value))
    };
    let mut pinned = vec![
        pin("WSMP_CONFIG", crate::paths::config_file()?)?,
        pin("WSMP_STATE_DIR", crate::paths::state_dir()?)?,
    ];
    // The installing shell's PATH, frozen at install time; re-run install to
    // refresh it. Skipped when unset, not UTF-8, or nothing usable is left.
    if let Some(path) = std::env::var("PATH")
        .ok()
        .and_then(|path| service_path(&path, usable_service_path_dir))
    {
        pinned.push(("PATH", path));
    }
    Ok(pinned)
}

/// The installing shell's `PATH` reduced to what a service should search:
/// absolute directories `keep` accepts, each once, in order. Empty and
/// relative entries (which would resolve against the service's working
/// directory) are dropped. None when nothing is left.
pub fn service_path(path: &str, keep: impl Fn(&Path) -> bool) -> Option<String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in std::env::split_paths(path) {
        if dir.as_os_str().is_empty() || !dir.is_absolute() || dirs.contains(&dir) || !keep(&dir) {
            continue;
        }
        dirs.push(dir);
    }
    if dirs.is_empty() {
        return None;
    }
    std::env::join_paths(dirs).ok()?.into_string().ok()
}

/// An existing directory that other users cannot write to (a world-writable
/// directory on the service's PATH would let them plant programs it runs).
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
fn usable_service_path_dir(dir: &Path) -> bool {
    let Ok(metadata) = fs::metadata(dir) else {
        return false;
    };
    if !metadata.is_dir() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o002 == 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Render a systemd user unit for the relay. `pinned` holds non-secret
/// `Environment=` entries (see [`pinned_service_env`]).
pub fn render_systemd_user_unit(executable: &str, pinned: &[(&str, String)]) -> String {
    let exec = systemd_quote_arg(executable);
    let pinned: String = pinned
        .iter()
        .map(|(name, value)| {
            format!(
                "Environment={}\n",
                systemd_quote_arg(&format!("{name}={value}"))
            )
        })
        .collect();
    format!(
        "[Unit]\n\
         Description=WS Model Proxy relay\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={exec} run\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         # Exit 4: the credential is missing or was rejected (HTTP 401, including a\n\
         # temporary ban); restarting cannot fix it. Run `wsmp login`, then\n\
         # `wsmp service restart`.\n\
         # Exit 5: the server refused this wsmp's relay protocol. Re-run the\n\
         # server's install.sh (or upgrade the server), then `wsmp service restart`.\n\
         RestartPreventExitStatus=4 5\n\
         Environment=WSMP_STOP_ON_PROTOCOL_MISMATCH=1\n\
         # Tells the relay it may exit 4 here instead of retrying in-process.\n\
         Environment=WSMP_STOP_ON_REJECTED_CREDENTIAL=1\n\
         # The config and state paths `wsmp service install` resolved, so the service\n\
         # reads the same device credential as the installing shell.\n\
         {pinned}\
         WorkingDirectory=%h\n\
         StandardOutput=journal\n\
         StandardError=journal\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n"
    )
}

/// Render a macOS LaunchAgent plist. `program` is the wrapper script path so the
/// plist never embeds secret environment values.
pub fn render_launch_agent_plist(
    label: &str,
    program: &str,
    working_directory: &str,
    stdout_path: &str,
    stderr_path: &str,
) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \t<key>Label</key>\n\
         \t<string>{label}</string>\n\
         \t<key>ProgramArguments</key>\n\
         \t<array>\n\
         \t\t<string>{program}</string>\n\
         \t</array>\n\
         \t<key>RunAtLoad</key>\n\
         \t<true/>\n\
         \t<key>KeepAlive</key>\n\
         \t<true/>\n\
         \t<key>ThrottleInterval</key>\n\
         \t<integer>5</integer>\n\
         \t<key>ProcessType</key>\n\
         \t<string>Background</string>\n\
         \t<key>WorkingDirectory</key>\n\
         \t<string>{working_directory}</string>\n\
         \t<key>StandardOutPath</key>\n\
         \t<string>{stdout_path}</string>\n\
         \t<key>StandardErrorPath</key>\n\
         \t<string>{stderr_path}</string>\n\
         </dict>\n\
         </plist>\n",
        label = xml_escape(label),
        program = xml_escape(program),
        working_directory = xml_escape(working_directory),
        stdout_path = xml_escape(stdout_path),
        stderr_path = xml_escape(stderr_path),
    )
}

/// Render the 0700 wrapper that pins the service's paths then execs wsmp.
pub fn render_macos_service_wrapper(executable: &str, pinned: &[(&str, String)]) -> String {
    let pinned: String = pinned
        .iter()
        .map(|(name, value)| format!("export {name}='{}'\n", shell_single_quote(value)))
        .collect();
    // Single-quoted shell paths: reject embedded single quotes rather than
    // inventing complex escaping for a generated path we control.
    format!(
        "#!/bin/sh\n\
         # Generated by `wsmp service install`: the config and state paths and\n\
         # PATH of the installing shell (no secrets), then the relay.\n\
         set -eu\n\
         {pinned}\
         exec '{executable}' run\n",
        executable = shell_single_quote(executable),
    )
}

fn shell_single_quote(value: &str) -> String {
    // Paths from current_exe / config_dir should not contain `'`; defend anyway.
    value.replace('\'', "'\"'\"'")
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
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

#[cfg(target_os = "linux")]
pub fn install(to_stderr: bool) -> Result<()> {
    let file = service_file()?;
    let executable = executable()?;
    let pinned = pinned_service_env()?;
    let unit = render_systemd_user_unit(&executable, &pinned);
    write_service_file(&file, &unit)?;
    run_command("systemctl", &["--user", "daemon-reload"])?;
    // enable --now is idempotent enough for reinstall/upgrade: unit path is
    // rewritten above, then reloaded and (re)started.
    run_command("systemctl", &["--user", "enable", "--now", LINUX_UNIT])?;
    // Restart so an already-running unit picks up a replaced binary/unit.
    let _ = Command::new("systemctl")
        .args(["--user", "restart", LINUX_UNIT])
        .status();
    print_install_notes(&pinned, to_stderr)?;
    say(
        to_stderr,
        format!("installed and started `{}`", file.display()),
    )
}

#[cfg(target_os = "macos")]
pub fn install(to_stderr: bool) -> Result<()> {
    let file = service_file()?;
    let executable = executable()?;

    let wrapper = macos_wrapper_path()?;
    if let Some(parent) = wrapper.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating `{}`", parent.display()))?;
        set_private_dir(parent)?;
    }
    let pinned = pinned_service_env()?;
    let wrapper_body = render_macos_service_wrapper(&executable, &pinned);
    write_private_script(&wrapper, wrapper_body.as_bytes())?;

    let log_dir = macos_log_dir()?;
    fs::create_dir_all(&log_dir).with_context(|| format!("creating `{}`", log_dir.display()))?;
    let home = dirs::home_dir().context("could not determine the user home directory")?;
    let stdout_path = log_dir.join("relay.out.log");
    let stderr_path = log_dir.join("relay.err.log");
    let plist = render_launch_agent_plist(
        MACOS_LABEL,
        &wrapper.display().to_string(),
        &home.display().to_string(),
        &stdout_path.display().to_string(),
        &stderr_path.display().to_string(),
    );
    write_service_file(&file, &plist)?;

    let domain = launchd_domain()?;
    // Upgrade/reinstall: boot out any previous registration, then bootstrap.
    bootout_if_loaded(&domain, &file);
    run_command(
        "launchctl",
        &["bootstrap", &domain, &file.display().to_string()],
    )?;
    // kickstart forces a (re)start after bootstrap/reinstall.
    let _ = Command::new("launchctl")
        .args(["kickstart", "-k", &format!("{domain}/{MACOS_LABEL}")])
        .status();

    print_install_notes(&pinned, to_stderr)?;
    say(
        to_stderr,
        format!("installed and started `{}`", file.display()),
    )
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn install(_to_stderr: bool) -> Result<()> {
    let _ = service_file()?;
    unreachable!()
}

#[cfg(target_os = "linux")]
fn uninstall() -> Result<()> {
    let file = service_file()?;
    let _ = Command::new("systemctl")
        .args(["--user", "disable", "--now", LINUX_UNIT])
        .status();
    if file.exists() {
        fs::remove_file(&file).with_context(|| format!("removing `{}`", file.display()))?;
    }
    let _ = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status();
    output::line("uninstalled relay service")
}

#[cfg(target_os = "macos")]
fn uninstall() -> Result<()> {
    let file = service_file()?;
    let domain = launchd_domain()?;
    bootout_if_loaded(&domain, &file);
    if file.exists() {
        fs::remove_file(&file).with_context(|| format!("removing `{}`", file.display()))?;
    }
    if let Ok(wrapper) = macos_wrapper_path()
        && wrapper.exists()
    {
        let _ = fs::remove_file(&wrapper);
    }
    output::line("uninstalled relay service")
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn uninstall() -> Result<()> {
    let _ = service_file()?;
    unreachable!()
}

#[cfg(target_os = "linux")]
fn status() -> Result<()> {
    run_command("systemctl", &["--user", "status", LINUX_UNIT])
}

#[cfg(target_os = "macos")]
fn status() -> Result<()> {
    let domain = launchd_domain()?;
    run_command("launchctl", &["print", &format!("{domain}/{MACOS_LABEL}")])
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn status() -> Result<()> {
    let _ = service_file()?;
    unreachable!()
}

#[cfg(target_os = "linux")]
fn restart() -> Result<()> {
    require_installed()?;
    run_command("systemctl", &["--user", "restart", LINUX_UNIT])?;
    output::line(format!("restarted `{LINUX_UNIT}`"))
}

#[cfg(target_os = "macos")]
fn restart() -> Result<()> {
    require_installed()?;
    let domain = launchd_domain()?;
    run_command(
        "launchctl",
        &["kickstart", "-k", &format!("{domain}/{MACOS_LABEL}")],
    )?;
    output::line(format!("restarted `{MACOS_LABEL}`"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn restart() -> Result<()> {
    let _ = service_file()?;
    unreachable!()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn require_installed() -> Result<()> {
    let file = service_file()?;
    anyhow::ensure!(
        file.exists(),
        "the relay service is not installed (`{}` is missing); run `wsmp service install`",
        file.display()
    );
    Ok(())
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
    run_command("journalctl", &argv)
}

/// The launchd agent writes stdout and stderr to files; `tail` them.
#[cfg(target_os = "macos")]
fn logs(args: &LogsArgs) -> Result<()> {
    let dir = macos_log_dir()?;
    let files: Vec<String> = ["relay.err.log", "relay.out.log"]
        .iter()
        .map(|name| dir.join(name))
        .filter(|path| path.exists())
        .map(|path| path.display().to_string())
        .collect();
    anyhow::ensure!(
        !files.is_empty(),
        "no relay service logs in `{}` yet",
        dir.display()
    );
    let lines = args.lines.to_string();
    let mut argv = vec!["-n", lines.as_str()];
    if args.follow {
        argv.push("-F");
    }
    argv.extend(files.iter().map(String::as_str));
    run_command("tail", &argv)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn logs(_args: &LogsArgs) -> Result<()> {
    let _ = service_file()?;
    unreachable!()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn print_install_notes(pinned: &[(&str, String)], to_stderr: bool) -> Result<()> {
    for (name, value) in pinned {
        say(to_stderr, format!("service pins `{name}` to `{value}`"))?;
    }
    say(
        to_stderr,
        "node secrets are read from `secrets.env` (`wsmp secret`); the service needs no environment file",
    )?;
    #[cfg(target_os = "linux")]
    match linger_on() {
        Some(true) => {}
        Some(false) => say(
            to_stderr,
            "warning: lingering is off, so this node cannot start runtimes and the service \
             stops when you log out; enable it once with `loginctl enable-linger \"$USER\"`",
        )?,
        None => say(
            to_stderr,
            "tip: for a user service that survives logout and can start runtimes, run \
             `loginctl enable-linger \"$USER\"`",
        )?,
    }
    Ok(())
}

/// Whether logind keeps this user's manager running without a session;
/// `None` when `loginctl` cannot say.
#[cfg(target_os = "linux")]
fn linger_on() -> Option<bool> {
    let uid = nix::unistd::Uid::effective().as_raw().to_string();
    let output = Command::new("loginctl")
        .args(["show-user", &uid, "-p", "Linger"])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Some(crate::runtimes::executor::native::linger_enabled(&text))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn write_service_file(file: &Path, contents: &str) -> Result<()> {
    let parent = file
        .parent()
        .context("service file has no parent directory")?;
    fs::create_dir_all(parent).with_context(|| format!("creating `{}`", parent.display()))?;
    fs::write(file, contents).with_context(|| format!("writing `{}`", file.display()))
}

#[cfg(target_os = "macos")]
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::fs::PermissionsExt;

        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("opening `{}`", path.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("writing `{}`", path.display()))?;
        file.sync_all()
            .with_context(|| format!("syncing `{}`", path.display()))?;
        let mut permissions = file
            .metadata()
            .with_context(|| format!("reading metadata for `{}`", path.display()))?
            .permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(path, permissions)
            .with_context(|| format!("setting private permissions on `{}`", path.display()))
    }
    #[cfg(not(unix))]
    {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(path)
            .with_context(|| format!("opening `{}`", path.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("writing `{}`", path.display()))?;
        file.sync_all()
            .with_context(|| format!("syncing `{}`", path.display()))
    }
}

#[cfg(target_os = "macos")]
fn write_private_script(path: &Path, bytes: &[u8]) -> Result<()> {
    write_private_file(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)
            .with_context(|| format!("reading metadata for `{}`", path.display()))?
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions)
            .with_context(|| format!("setting executable permissions on `{}`", path.display()))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn set_private_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata =
        fs::metadata(path).with_context(|| format!("reading metadata for `{}`", path.display()))?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(path, permissions)
        .with_context(|| format!("setting private permissions on `{}`", path.display()))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn run_command(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .status()
        .with_context(|| format!("running `{program}`"))?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("`{program}` failed with {status}")
    }
}

/// Boot out the agent when launchd has it loaded. Best effort and quiet:
/// launchctl prints alarming errors (`Boot-out failed: 5`) for an agent
/// that is not loaded, which is every first install.
#[cfg(target_os = "macos")]
fn bootout_if_loaded(domain: &str, file: &Path) {
    if agent_loaded(domain) {
        let _ = Command::new("launchctl")
            .args(["bootout", domain, &file.display().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Whether launchd has the relay agent loaded in `domain`.
#[cfg(target_os = "macos")]
fn agent_loaded(domain: &str) -> bool {
    Command::new("launchctl")
        .args(["print", &format!("{domain}/{MACOS_LABEL}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(target_os = "macos")]
fn launchd_domain() -> Result<String> {
    let output = Command::new("id")
        .arg("-u")
        .output()
        .context("determining the current user ID")?;
    if !output.status.success() {
        anyhow::bail!("`id -u` failed with {}", output.status);
    }
    let uid = String::from_utf8(output.stdout).context("decoding the current user ID")?;
    // LaunchAgents for the logged-in GUI session use the `gui/<uid>` domain.
    Ok(format!("gui/{}", uid.trim()))
}

/// Windows: a Task Scheduler task of this user's, started at logon.
///
/// - It runs as the user, only while they are logged on (`InteractiveToken`,
///   least privilege), so it needs no password and stops at logoff, like a
///   Linux user service without linger. A Windows service would run in
///   session 0 or need the user's password, and could not host terminals in
///   the user's session.
/// - `conhost.exe --headless` starts the relay with no console window.
/// - A task cannot set environment variables, so the config and state paths
///   are pinned as hidden `wsmp run` options instead, with `--log-file`, since
///   Task Scheduler keeps no output.
/// - Restarts: the relay already retries in-process (no `WSMP_STOP_ON_*`
///   here). A relay that exits anyway is started again by a trigger that
///   fires every 5 minutes while the user is logged on; a running relay
///   makes it a no-op (`IgnoreNew`).
/// - `schtasks /End` kills the relay without its graceful shutdown; its
///   kill-on-close jobs still end every command and terminal it started.
///
/// Built everywhere so its rendering tests run on every CI platform.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) mod windows_task {
    /// Kept in the state dir; marks the service as installed.
    pub const DEFINITION_FILE: &str = "wsmp-relay-task.xml";
    pub const LOG_FILE: &str = "relay.log";

    /// One task per Windows user: Task Scheduler names are machine-wide.
    pub fn task_name(user: &str) -> String {
        let user: String = user
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                    ch
                } else {
                    '_'
                }
            })
            .collect();
        format!("wsmp-relay-{user}")
    }

    /// One argument for a Windows command line, as `CommandLineToArgvW` (and
    /// Rust's own argument parser) reads it back.
    pub fn quote_arg(value: &str) -> String {
        if !value.is_empty() && !value.contains([' ', '\t', '"']) {
            return value.to_string();
        }
        let mut out = String::from("\"");
        let mut backslashes = 0;
        for ch in value.chars() {
            match ch {
                '\\' => backslashes += 1,
                '"' => {
                    out.push_str(&"\\".repeat(backslashes * 2 + 1));
                    out.push('"');
                    backslashes = 0;
                }
                _ => {
                    out.push_str(&"\\".repeat(backslashes));
                    out.push(ch);
                    backslashes = 0;
                }
            }
        }
        // Backslashes before the closing quote are doubled, so `C:\dir\`
        // does not swallow it.
        out.push_str(&"\\".repeat(backslashes * 2));
        out.push('"');
        out
    }

    /// The `conhost.exe` arguments: headless, then `wsmp run` with the
    /// pinned paths.
    pub fn arguments(executable: &str, config: &str, state_dir: &str, log_file: &str) -> String {
        [
            "--headless",
            executable,
            "run",
            "--service",
            "--config",
            config,
            "--state-dir",
            state_dir,
            "--log-file",
            log_file,
        ]
        .iter()
        .map(|arg| quote_arg(arg))
        .collect::<Vec<_>>()
        .join(" ")
    }

    /// The task definition `schtasks /Create /XML` reads. `user_sid` names
    /// both the logon trigger and the principal.
    pub fn render_xml(user_sid: &str, arguments: &str, working_directory: &str) -> String {
        let sid = super::xml_escape(user_sid);
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
             <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n\
             \x20 <RegistrationInfo>\n\
             \x20   <Description>WS Model Proxy relay (`wsmp run`), installed by `wsmp service install`.</Description>\n\
             \x20 </RegistrationInfo>\n\
             \x20 <Triggers>\n\
             \x20   <LogonTrigger>\n\
             \x20     <Enabled>true</Enabled>\n\
             \x20     <UserId>{sid}</UserId>\n\
             \x20   </LogonTrigger>\n\
             \x20   <TimeTrigger>\n\
             \x20     <Repetition>\n\
             \x20       <Interval>PT5M</Interval>\n\
             \x20       <StopAtDurationEnd>false</StopAtDurationEnd>\n\
             \x20     </Repetition>\n\
             \x20     <StartBoundary>2026-01-01T00:00:00</StartBoundary>\n\
             \x20     <Enabled>true</Enabled>\n\
             \x20   </TimeTrigger>\n\
             \x20 </Triggers>\n\
             \x20 <Principals>\n\
             \x20   <Principal id=\"Author\">\n\
             \x20     <UserId>{sid}</UserId>\n\
             \x20     <LogonType>InteractiveToken</LogonType>\n\
             \x20     <RunLevel>LeastPrivilege</RunLevel>\n\
             \x20   </Principal>\n\
             \x20 </Principals>\n\
             \x20 <Settings>\n\
             \x20   <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n\
             \x20   <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n\
             \x20   <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n\
             \x20   <AllowHardTerminate>true</AllowHardTerminate>\n\
             \x20   <StartWhenAvailable>false</StartWhenAvailable>\n\
             \x20   <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n\
             \x20   <IdleSettings>\n\
             \x20     <StopOnIdleEnd>false</StopOnIdleEnd>\n\
             \x20     <RestartOnIdle>false</RestartOnIdle>\n\
             \x20   </IdleSettings>\n\
             \x20   <AllowStartOnDemand>true</AllowStartOnDemand>\n\
             \x20   <Enabled>true</Enabled>\n\
             \x20   <Hidden>false</Hidden>\n\
             \x20   <RunOnlyIfIdle>false</RunOnlyIfIdle>\n\
             \x20   <WakeToRun>false</WakeToRun>\n\
             \x20   <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n\
             \x20   <Priority>5</Priority>\n\
             \x20   <RestartOnFailure>\n\
             \x20     <Interval>PT1M</Interval>\n\
             \x20     <Count>999</Count>\n\
             \x20   </RestartOnFailure>\n\
             \x20 </Settings>\n\
             \x20 <Actions Context=\"Author\">\n\
             \x20   <Exec>\n\
             \x20     <Command>%SystemRoot%\\System32\\conhost.exe</Command>\n\
             \x20     <Arguments>{arguments}</Arguments>\n\
             \x20     <WorkingDirectory>{working_directory}</WorkingDirectory>\n\
             \x20   </Exec>\n\
             \x20 </Actions>\n\
             </Task>\n",
            arguments = super::xml_escape(arguments),
            working_directory = super::xml_escape(working_directory),
        )
    }

    /// UTF-16LE with a byte-order mark, as the declaration says.
    pub fn utf16_bytes(text: &str) -> Vec<u8> {
        std::iter::once(0xFEFF_u16)
            .chain(text.encode_utf16())
            .flat_map(u16::to_le_bytes)
            .collect()
    }

    /// The last `count` lines of `text`.
    pub fn last_lines(text: &str, count: usize) -> Vec<&str> {
        let lines: Vec<&str> = text.lines().collect();
        lines[lines.len().saturating_sub(count)..].to_vec()
    }
}

#[cfg(windows)]
fn windows_user() -> Result<String> {
    std::env::var("USERNAME").context("`USERNAME` is not set")
}

#[cfg(windows)]
fn windows_task_name() -> Result<String> {
    Ok(windows_task::task_name(&windows_user()?))
}

#[cfg(windows)]
fn windows_log_file() -> Result<PathBuf> {
    Ok(crate::paths::log_dir()?.join(windows_task::LOG_FILE))
}

/// Runs `schtasks`, capturing its output: what it prints goes to the
/// caller's stream only by choice (stdout may carry `--json`).
#[cfg(windows)]
fn schtasks(args: &[&str]) -> Result<String> {
    let output = Command::new("schtasks")
        .args(args)
        .output()
        .context("running `schtasks`")?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    anyhow::bail!(
        "`schtasks {}` failed with {}: {}",
        args.first().copied().unwrap_or_default(),
        output.status,
        if stderr.is_empty() { stdout } else { stderr }
    )
}

/// Whether Task Scheduler runs the task now. `Get-ScheduledTask` reports an
/// enum (`Running`, `Ready`, …) that reads the same in every Windows
/// language; `schtasks /Query` prints a localized status.
#[cfg(windows)]
fn windows_task_running(name: &str) -> bool {
    // `task_name` keeps names to `[A-Za-z0-9._-]`, so single quotes suffice.
    let script = format!("(Get-ScheduledTask -TaskName '{name}' -ErrorAction Stop).State");
    Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).trim() == "Running")
}

/// Stops the task's relay: gracefully through its control pipe (it ends its
/// commands and terminals and tells the server), then `schtasks /End` for the
/// console host, which `/End` kills without its child. Waits (bounded) until
/// Task Scheduler no longer counts the task as running and the pipe is gone;
/// otherwise a `/Run` right after is dropped (`IgnoreNew`), or the new relay
/// finds the pipe still taken.
#[cfg(windows)]
fn end_windows_task(name: &str) {
    use crate::control::{ControlCommand, request_if_running};
    if matches!(request_if_running(ControlCommand::Stop), Ok(Some(_))) {
        let deadline = std::time::Instant::now() + crate::shutdown::SHUTDOWN_DEADLINE * 2;
        while std::time::Instant::now() < deadline
            && !matches!(request_if_running(ControlCommand::Status), Ok(None))
        {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
    let _ = schtasks(&["/End", "/TN", name]);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        let pipe_gone = matches!(
            crate::control::request_if_running(crate::control::ControlCommand::Status),
            Ok(None)
        );
        if pipe_gone && !windows_task_running(name) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
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
    let log_file = absolute(windows_log_file()?)?;
    let home = dirs::home_dir().context("could not determine the user home directory")?;
    let sid = wsmp_windows::current_user_sid().context("reading this user's SID")?;
    let arguments = windows_task::arguments(&executable, &config, &state_dir, &log_file);
    let xml = windows_task::render_xml(&sid, &arguments, &home.display().to_string());
    let file = service_file()?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating `{}`", parent.display()))?;
    }
    fs::write(&file, windows_task::utf16_bytes(&xml))
        .with_context(|| format!("writing `{}`", file.display()))?;
    let name = windows_task_name()?;
    let file_arg = file.display().to_string();
    schtasks(&["/Create", "/TN", &name, "/XML", &file_arg, "/F"])?;
    // Reinstall or upgrade: a running relay is replaced by the new binary.
    end_windows_task(&name);
    schtasks(&["/Run", "/TN", &name])?;
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
    )
}

#[cfg(windows)]
fn uninstall() -> Result<()> {
    let name = windows_task_name()?;
    end_windows_task(&name);
    // Already gone is fine.
    let _ = schtasks(&["/Delete", "/TN", &name, "/F"]);
    let file = service_file()?;
    if file.exists() {
        fs::remove_file(&file).with_context(|| format!("removing `{}`", file.display()))?;
    }
    output::line("uninstalled relay service")
}

#[cfg(windows)]
fn status() -> Result<()> {
    let name = windows_task_name()?;
    output::line(schtasks(&["/Query", "/TN", &name, "/V", "/FO", "LIST"])?)
}

#[cfg(windows)]
fn restart() -> Result<()> {
    let file = service_file()?;
    anyhow::ensure!(
        file.exists(),
        "the relay service is not installed (`{}` is missing); run `wsmp service install`",
        file.display()
    );
    let name = windows_task_name()?;
    end_windows_task(&name);
    schtasks(&["/Run", "/TN", &name])?;
    output::line(format!("restarted the scheduled task `{name}`"))
}

/// The relay's own log file: the last lines, then (with `--follow`) new ones
/// as they come, across roll-overs.
#[cfg(windows)]
fn logs(args: &LogsArgs) -> Result<()> {
    use std::io::{Read, Seek, SeekFrom};

    let path = windows_log_file()?;
    let text = fs::read(&path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .with_context(|| format!("no relay service log at `{}` yet", path.display()))?;
    for line in windows_task::last_lines(&text, args.lines as usize) {
        output::line(line)?;
    }
    if !args.follow {
        return Ok(());
    }
    let mut position = text.len() as u64;
    let mut pending = String::new();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let Ok(mut file) = fs::File::open(&path) else {
            continue;
        };
        let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
        if len < position {
            // Rolled over: the new file starts from the top.
            position = 0;
            pending.clear();
        }
        if len == position {
            continue;
        }
        file.seek(SeekFrom::Start(position))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        position += bytes.len() as u64;
        pending.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(end) = pending.find('\n') {
            let line: String = pending.drain(..=end).collect();
            output::line(line.trim_end_matches(['\r', '\n']))?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_task_quotes_arguments_as_windows_reads_them() {
        use windows_task::quote_arg;
        assert_eq!(quote_arg(r"C:\Users\me\wsmp.exe"), r"C:\Users\me\wsmp.exe");
        assert_eq!(
            quote_arg(r"C:\Program Files\wsmp\wsmp.exe"),
            r#""C:\Program Files\wsmp\wsmp.exe""#
        );
        // A trailing backslash must not escape the closing quote.
        assert_eq!(quote_arg(r"C:\my state\"), r#""C:\my state\\""#);
        assert_eq!(quote_arg(r#"a\"b"#), r#""a\\\"b""#);
        assert_eq!(quote_arg(""), r#""""#);
    }

    #[test]
    fn windows_task_runs_the_relay_headless_with_pinned_paths() {
        let arguments = windows_task::arguments(
            r"C:\Users\Jo Doe\.cargo\bin\wsmp.exe",
            r"C:\Users\Jo Doe\.config\ws-model-proxy\config.json",
            r"C:\Users\Jo Doe\AppData\Local\ws-model-proxy",
            r"C:\Users\Jo Doe\AppData\Local\ws-model-proxy\logs\relay.log",
        );
        assert!(
            arguments
                .starts_with(r#"--headless "C:\Users\Jo Doe\.cargo\bin\wsmp.exe" run --service "#)
        );
        assert!(
            arguments.contains(r#"--state-dir "C:\Users\Jo Doe\AppData\Local\ws-model-proxy""#)
        );
        let xml = windows_task::render_xml("S-1-5-21-1-2-3-1001", &arguments, r"C:\Users\Jo & Doe");
        assert!(xml.contains("<UserId>S-1-5-21-1-2-3-1001</UserId>"));
        assert_eq!(xml.matches("<UserId>").count(), 2, "trigger and principal");
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(xml.contains(r"<Command>%SystemRoot%\System32\conhost.exe</Command>"));
        assert!(xml.contains("<Arguments>--headless &quot;C:\\Users\\Jo Doe"));
        assert!(xml.contains(r"<WorkingDirectory>C:\Users\Jo &amp; Doe</WorkingDirectory>"));
        // No secret or environment ever goes in.
        assert!(!xml.contains("WSMP_"));
        let bytes = windows_task::utf16_bytes("<a/>");
        assert_eq!(&bytes[..4], &[0xFF, 0xFE, b'<', 0]);
    }

    #[test]
    fn windows_task_names_are_per_user_and_safe() {
        assert_eq!(windows_task::task_name("jo"), "wsmp-relay-jo");
        assert_eq!(windows_task::task_name(r"Jo Doe\x"), "wsmp-relay-Jo_Doe_x");
        assert_eq!(windows_task::last_lines("a\nb\nc\n", 2), ["b", "c"]);
        assert_eq!(windows_task::last_lines("a\n", 5), ["a"]);
    }

    #[test]
    fn systemd_unit_quotes_special_paths_and_pins_no_secret() {
        let unit = render_systemd_user_unit(
            "/opt/ws model/wsmp",
            &[
                (
                    "WSMP_CONFIG",
                    "/home/user/.config/ws-model-proxy/config.json".to_string(),
                ),
                ("WSMP_STATE_DIR", "/srv/wsmp state/100%".to_string()),
                ("PATH", "/home/user/.local/bin:/usr/bin".to_string()),
            ],
        );
        assert!(unit.contains("ExecStart=\"/opt/ws model/wsmp\" run"));
        assert!(!unit.contains("EnvironmentFile"));
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains(&format!(
            "RestartPreventExitStatus={} {}\n",
            crate::exit::ExitCode::CredentialRejected as i32,
            crate::exit::ExitCode::RelayProtocolMismatch as i32
        )));
        assert!(unit.contains("WantedBy=default.target"));
        assert!(
            unit.contains(
                "Environment=WSMP_CONFIG=/home/user/.config/ws-model-proxy/config.json\n"
            )
        );
        assert!(unit.contains("Environment=\"WSMP_STATE_DIR=/srv/wsmp state/100%%\"\n"));
        assert!(unit.contains("Environment=PATH=/home/user/.local/bin:/usr/bin\n"));
        assert!(unit.contains(&format!(
            "Environment={}=1\n",
            crate::daemon::STOP_ON_REJECTED_CREDENTIAL_ENV
        )));
        assert!(unit.contains(&format!(
            "Environment={}=1\n",
            crate::daemon::STOP_ON_PROTOCOL_MISMATCH_ENV
        )));
        // Only the pinned paths and the stop markers: no token or header variables.
        assert_eq!(unit.matches("Environment=").count(), 5);
    }

    #[cfg(unix)]
    #[test]
    fn service_path_keeps_only_absolute_usable_directories_once() {
        let keep = |dir: &Path| dir != Path::new("/tmp/open");
        assert_eq!(
            service_path(
                "/usr/bin::relative/bin:./bin:/tmp/open:/usr/bin:/home/me/.local/bin:",
                keep
            )
            .as_deref(),
            Some("/usr/bin:/home/me/.local/bin")
        );
        assert_eq!(service_path("", keep), None);
        assert_eq!(service_path(":relative", keep), None);
    }

    #[cfg(unix)]
    #[test]
    fn service_path_directories_must_exist_and_not_be_world_writable() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().expect("tempdir");
        let private = root.path().join("private");
        let open = root.path().join("open");
        fs::create_dir(&private).expect("private");
        fs::create_dir(&open).expect("open");
        fs::set_permissions(&private, fs::Permissions::from_mode(0o755)).expect("chmod");
        fs::set_permissions(&open, fs::Permissions::from_mode(0o777)).expect("chmod");
        assert!(usable_service_path_dir(&private));
        assert!(!usable_service_path_dir(&open));
        assert!(!usable_service_path_dir(&root.path().join("missing")));
    }

    #[test]
    fn systemd_quote_arg_escapes_percent_and_quotes() {
        assert_eq!(systemd_quote_arg("/usr/bin/wsmp"), "/usr/bin/wsmp");
        assert_eq!(systemd_quote_arg("/tmp/a\"b%c"), "\"/tmp/a\\\"b%%c\"");
    }

    #[test]
    fn launch_agent_plist_uses_wrapper_and_escapes_xml() {
        let label = "com.flycockpit.wsmp";
        let plist = render_launch_agent_plist(
            label,
            "/tmp/wsmp-service-run.sh",
            "/Users/test",
            "/Users/test/Library/Logs/ws-model-proxy/relay.out.log",
            "/Users/test/Library/Logs/ws-model-proxy/relay.err.log",
        );
        assert!(plist.contains(&format!("<string>{label}</string>")));
        assert!(plist.contains("<string>/tmp/wsmp-service-run.sh</string>"));
        assert!(plist.contains("<key>KeepAlive</key>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<true/>"));
        assert!(!plist.contains("EnvironmentVariables"));
        let escaped = render_launch_agent_plist(
            "label",
            "/tmp/a&b<c>.sh",
            "/Users/test",
            "/tmp/out",
            "/tmp/err",
        );
        assert!(escaped.contains("/tmp/a&amp;b&lt;c&gt;.sh"));
    }

    #[test]
    fn macos_wrapper_pins_paths_and_execs_foreground_daemon() {
        let script = render_macos_service_wrapper(
            "/usr/local/bin/wsmp",
            &[
                ("WSMP_STATE_DIR", "/Users/x/it's state".to_string()),
                ("PATH", "/Users/x/.cargo/bin:/usr/bin".to_string()),
            ],
        );
        assert!(script.contains("export PATH='/Users/x/.cargo/bin:/usr/bin'\n"));
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains("export WSMP_STATE_DIR='/Users/x/it'\"'\"'s state'\n"));
        assert!(!script.contains("ENV_FILE"));
        assert!(script.contains("exec '/usr/local/bin/wsmp' run"));
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
