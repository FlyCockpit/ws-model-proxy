//! The relay's per-user service, as the service managers know it: a systemd
//! user unit (Linux), a launchd agent that runs a small 0700 wrapper
//! (macOS), or a Task Scheduler task that starts at logon (Windows, see
//! `windows_task`). Where each file is, what it says, how a running relay
//! tells it runs under one, and the bounded service-manager calls that load,
//! restart and rewrite it. `wsmp service` (`crate::commands::service`) is
//! the command on top.
//!
//! The service needs no environment of its own: the node credential is in
//! the state directory and node secrets are in `secrets.env`, both of which
//! the relay reads itself. The unit (or wrapper) pins only the config and
//! state paths and `PATH` of the installing shell, never a secret.

#[cfg(any(target_os = "macos", all(test, unix)))]
use std::path::Path;
use std::path::PathBuf;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::process::Command;

#[cfg(any(target_os = "linux", target_os = "macos", all(test, unix)))]
use anyhow::Context;
use anyhow::Result;

pub mod files;
#[cfg(any(target_os = "macos", test))]
pub mod launchd;
pub mod path_env;
pub mod task_scheduler;
pub mod text;

#[cfg(target_os = "linux")]
pub(crate) const LINUX_UNIT: &str = "wsmp.service";
/// The relay LaunchAgent's label: a plist with it is wsmp's
/// (`files::ServiceKind::LaunchdPlist`).
#[cfg(unix)]
pub(crate) const MACOS_LABEL: &str = "com.flycockpit.wsmp";
#[cfg(target_os = "macos")]
const MACOS_WRAPPER_NAME: &str = "wsmp-service-run.sh";

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
pub(crate) fn macos_wrapper_path() -> Result<PathBuf> {
    absolute_in(&crate::paths::state_dir()?, MACOS_WRAPPER_NAME)
}

/// `name` in `dir`, made absolute against this process's working directory
/// (as [`pinned_service_env`](path_env::pinned_service_env) pins the state directory): the plist names the
/// wrapper, and launchd reads a relative path against its own working
/// directory, not that of the shell that ran `wsmp service install` or
/// `wsmp update` (a relative `WSMP_STATE_DIR`). No link is followed.
#[cfg(any(target_os = "macos", all(test, unix)))]
fn absolute_in(dir: &Path, name: &str) -> Result<PathBuf> {
    let path = dir.join(name);
    std::path::absolute(&path).with_context(|| format!("resolving `{}`", path.display()))
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

/// Whether `wsmp service install` installed the relay service here.
pub fn installed() -> bool {
    service_file().is_ok_and(|file| file.exists())
}

/// Set by the systemd unit `wsmp service install` writes, which also lists
/// exit 4 in `RestartPreventExitStatus=`: there, stopping on an unusable
/// credential cannot turn into a restart loop.
pub const STOP_ON_REJECTED_CREDENTIAL_ENV: &str = "WSMP_STOP_ON_REJECTED_CREDENTIAL";

/// Set by a systemd unit that also lists exit 5 in `RestartPreventExitStatus=`
/// so a protocol mismatch stops the service.
pub const STOP_ON_PROTOCOL_MISMATCH_ENV: &str = "WSMP_STOP_ON_PROTOCOL_MISMATCH";

/// Set by `wsmp run --service`: a service manager started this relay. The
/// Windows task runs it under `conhost --headless`, whose console stderr is
/// a terminal that nobody sees.
static AS_SERVICE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn run_as_service() {
    AS_SERVICE.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Whether `wsmp run --service` started this relay ([`run_as_service`]).
pub fn running_as_service() -> bool {
    AS_SERVICE.load(std::sync::atomic::Ordering::SeqCst)
}

/// Whether the installed relay service runs this relay, so an exit is
/// restarted: the systemd unit `wsmp service install` writes (it sets
/// [`STOP_ON_REJECTED_CREDENTIAL_ENV`]), its launchd agent (launchd names the
/// job in `XPC_SERVICE_NAME`), or the Windows task (`wsmp run --service`).
pub fn under_service_manager() -> bool {
    if cfg!(target_os = "macos") {
        return std::env::var("XPC_SERVICE_NAME").is_ok_and(|name| name == "com.flycockpit.wsmp");
    }
    if cfg!(windows) {
        return AS_SERVICE.load(std::sync::atomic::Ordering::SeqCst);
    }
    std::env::var_os(STOP_ON_REJECTED_CREDENTIAL_ENV).is_some_and(|value| value == "1")
}

/// How [`restart_quietly`] restarts the relay service.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Restart {
    /// What the service manager has loaded (the dead-man's rollback; a
    /// self-replace update).
    Loaded,
    /// After a Homebrew update: on macOS, launchd loads the LaunchAgent plist
    /// again first (`bootout`, `bootstrap`: [`launchd::restart_launch_agent`]), since
    /// it keeps the copy it loaded and [`ensure_stable_executable`](files::ensure_stable_executable) may have
    /// rewritten the file, in this update or an earlier try of it. Elsewhere
    /// the same as `Loaded` (systemd was reloaded before the upgrade).
    Reloaded,
}

/// Restart the relay service without printing (the update dead-man and
/// `wsmp update`), as `how` says. An error when it is not installed. Every
/// service-manager call is bounded ([`run_finite`]).
pub fn restart_quietly(how: Restart) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        let _ = how;
        require_installed()?;
        run_finite("systemctl", &["--user", "restart", LINUX_UNIT])
    }
    #[cfg(target_os = "macos")]
    {
        require_installed()?;
        let file = service_file()?;
        let file = text::path_text("the relay service", &file)?;
        let domain = launchd::launchd_domain()?;
        launchd::restart_launch_agent(
            &mut launchd::SystemLaunchctl,
            launchd::LaunchAgentCaller::Restart(how),
            &domain,
            &format!("{domain}/{MACOS_LABEL}"),
            file,
            std::time::Instant::now() + FINITE_COMMAND_TIMEOUT,
        )
    }
    #[cfg(windows)]
    {
        let _ = how;
        let file = service_file()?;
        anyhow::ensure!(file.exists(), "the relay service is not installed");
        let name = task_scheduler::windows_task_name()?;
        task_scheduler::end_windows_task(&name);
        task_scheduler::schtasks(&["/Run", "/TN", &name]).map(|_| ())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = how;
        anyhow::bail!("service installation is only supported on Linux, macOS and Windows")
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn require_installed() -> Result<()> {
    let file = service_file()?;
    anyhow::ensure!(
        file.exists(),
        "the relay service is not installed (`{}` is missing); run `wsmp service install`",
        file.display()
    );
    Ok(())
}

/// How long a finite service-manager command (`daemon-reload`, `restart`,
/// `bootstrap`, `kickstart`, `print`, `id -u`, `schtasks`) may take when an
/// update or the dead-man runs it.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub(crate) const FINITE_COMMAND_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(3 * 60);

/// A finite service-manager command run by an update (or by what it runs on):
/// supervised and bounded like every update-management command
/// ([`crate::bounded_run::management::run_bounded`]: its own process group, both pipes
/// drained, killed at the deadline and on shutdown). Its output on failure.
/// Commands a person watches (`status`, `logs --follow`) keep [`run_command`].
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn run_finite(program: &str, args: &[&str]) -> Result<()> {
    run_finite_within(program, args, FINITE_COMMAND_TIMEOUT)
}

/// [`run_finite`], stopped after `timeout`.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn run_finite_within(
    program: &str,
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<()> {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    let (ok, output) = crate::bounded_run::management::run_bounded(
        program,
        &args,
        &service_manager_env(),
        timeout,
    )?;
    anyhow::ensure!(ok, "`{program}` failed: {}", output.trim());
    Ok(())
}

/// Extra environment for a service-manager command: [`user_bus_env`] on
/// Linux, nothing on macOS.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn service_manager_env() -> Vec<(&'static str, String)> {
    #[cfg(target_os = "linux")]
    {
        user_bus_env()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Vec::new()
    }
}

/// `XDG_RUNTIME_DIR` for a `systemctl --user` or `journalctl --user` call.
/// A shell from `su - <user>` or `sudo -iu <user>` has none, so `systemctl`
/// cannot find the user manager's bus, although logind runs that manager
/// (with lingering on) at `/run/user/<uid>`. Nothing when it is set.
#[cfg(target_os = "linux")]
pub(crate) fn user_bus_env() -> Vec<(&'static str, String)> {
    user_bus_env_for(
        std::env::var_os("XDG_RUNTIME_DIR").is_some(),
        nix::unistd::Uid::effective().as_raw(),
    )
}

/// [`user_bus_env`] for a given state: `set` is whether `XDG_RUNTIME_DIR` is.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn user_bus_env_for(set: bool, uid: u32) -> Vec<(&'static str, String)> {
    if set {
        Vec::new()
    } else {
        vec![("XDG_RUNTIME_DIR", format!("/run/user/{uid}"))]
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn run_command(program: &str, args: &[impl AsRef<std::ffi::OsStr>]) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .envs(service_manager_env())
        .status()
        .with_context(|| format!("running `{program}`"))?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("`{program}` failed with {status}")
    }
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
pub(crate) mod task_names;

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) mod windows_task;

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn finite_service_commands_propagate_failure_before_success() {
        let error = run_finite("sh", &["-c", "echo restart-refused >&2; exit 1"])
            .expect_err("restart failed");
        assert!(format!("{error:#}").contains("restart-refused"));
        assert!(run_finite("wsmp-nonexistent-service-command", &[]).is_err());
    }

    #[test]
    fn a_shell_without_a_runtime_dir_still_reaches_the_user_bus() {
        // `su - ada` / `sudo -iu ada`: no XDG_RUNTIME_DIR, so name logind's.
        assert_eq!(
            user_bus_env_for(false, 1000),
            vec![("XDG_RUNTIME_DIR", "/run/user/1000".to_string())]
        );
        // A login session's own value is kept as it is.
        assert!(user_bus_env_for(true, 1000).is_empty());
    }
}
