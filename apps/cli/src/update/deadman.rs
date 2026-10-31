//! The dead-man (D1): a job, separate from the relay service, that runs the
//! *previous* binary at the deadline: `<recovery copy> update rollback
//! --if-unconfirmed <updateId>`. Its program is the recovery copy
//! (`.wsmp-recovery-<updateId>`, the previous binary's bytes;
//! [`super::install::prepare_recovery`]), never `wsmp.prev` itself: the
//! restore consumes `wsmp.prev`, and a job whose relay restart failed must
//! still be able to run again. It is armed before the swap, so a new build
//! that cannot even start cannot disarm it.
//!
//! - Linux and WSL: a systemd user timer and service written beside the relay's
//!   unit (`wsmp-update-deadman.{timer,service}`), enabled, with
//!   `Persistent=true`, so a reboot during the trial does not lose it.
//! - macOS: a one-shot LaunchAgent (`com.flycockpit.wsmp.update-deadman`,
//!   `RunAtLoad`); the rollback command itself sleeps until the deadline.
//! - Windows: a one-shot scheduled task with two triggers: +5 s (the rollback
//!   command only starts the relay task again: Task Scheduler's
//!   `RestartOnFailure` would wait a minute) and the deadline.
//!
//! Every job has a fixed name. Arming first waits for a dead-man that is
//! running now (a rollback) to finish, removes a pending one, and polls until
//! the name is free, so arming twice is safe. The rollback command removes
//! the job (Linux: the unit files too) after a run.
//!
//! The window counts from the new build's start: it moves the deadline to a
//! full window after each unconfirmed start (at most
//! [`super::agent::MAX_UNCONFIRMED_STARTS`]), and a job that fires before
//! that finds the update not due and waits. A reboot during the trial: every
//! job comes back (`Persistent=true`, `RunAtLoad`, `StartWhenAvailable`), and
//! the rollback check gives a build that started after the reboot a full
//! window first ([`booted_at`]). The new binary re-arms a dead-man that went
//! missing.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

pub const LINUX_UNIT: &str = "wsmp-update-deadman";
pub const MACOS_LABEL: &str = "com.flycockpit.wsmp.update-deadman";
/// Windows task names are machine-wide: one per user, like the relay task.
pub fn windows_task_name(user: &str) -> String {
    crate::commands::service::windows_task::task_name(user).replacen(
        "wsmp-relay-",
        "wsmp-update-deadman-",
        1,
    )
}
/// The Windows dead-man's early run: start the relay task again after the exit 75.
pub const WINDOWS_KICK_AFTER: Duration = Duration::from_secs(5);

/// What one dead-man runs, and when. Built only with [`DeadmanSpec::new`],
/// which makes every path that goes into the job absolute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeadmanSpec {
    update_id: String,
    /// The program the job runs: the recovery copy of the previous binary
    /// (never the rollback copy, which the restore consumes).
    program: PathBuf,
    /// Passed as `--state-dir`: the job's environment is not the service's.
    state_dir: PathBuf,
    fire_in: Duration,
}

/// `path` resolved against this process's working directory
/// ([`std::path::absolute`]: no symlink is followed and the bytes of the
/// path are kept). An empty path is refused.
fn job_path(what: &str, path: &Path) -> Result<PathBuf> {
    anyhow::ensure!(
        !path.as_os_str().is_empty(),
        "{what} is empty; nothing was written"
    );
    std::path::absolute(path).with_context(|| {
        format!(
            "{what} `{}` could not be made absolute; nothing was written",
            path.display()
        )
    })
}

impl DeadmanSpec {
    /// The one way to build a spec. The scheduler starts the job in a working
    /// directory of its own (systemd: the user's home; launchd: `/`; Task
    /// Scheduler: `System32`), so a relative state directory or previous
    /// program would name another place there: a rollback that finds no
    /// update, exits 0 and leaves the failed build live. Both are resolved
    /// here, in the updater's context, before anything is armed; the log and
    /// task-file paths derive from the state directory. An empty path is an
    /// error.
    pub fn new(
        update_id: String,
        program: &Path,
        state_dir: &Path,
        fire_in: Duration,
    ) -> Result<Self> {
        Ok(Self {
            update_id,
            program: job_path("the rollback job's wsmp", program)?,
            state_dir: job_path("the update state directory", state_dir)?,
            fire_in,
        })
    }

    pub fn update_id(&self) -> &str {
        &self.update_id
    }

    /// The program the job runs.
    pub fn program(&self) -> &Path {
        &self.program
    }

    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    pub fn fire_in(&self) -> Duration {
        self.fire_in
    }

    /// `update rollback --if-unconfirmed <id> --state-dir <dir>` (after the
    /// program). The state directory must be exact UTF-8 text
    /// ([`crate::commands::service::path_text`]): an error otherwise, before
    /// any job is written, rather than a job that looks in another
    /// directory, finds no update there and rolls nothing back.
    pub fn rollback_args(&self) -> Result<Vec<String>> {
        let state_dir =
            crate::commands::service::path_text("the update state directory", &self.state_dir)?;
        Ok(vec![
            "update".into(),
            "rollback".into(),
            "--if-unconfirmed".into(),
            self.update_id.clone(),
            "--state-dir".into(),
            state_dir.to_string(),
        ])
    }

    /// The program as exact text ([`Self::rollback_args`]).
    pub fn program_text(&self) -> Result<&str> {
        crate::commands::service::path_text("the rollback job's wsmp", &self.program)
    }
}

/// The platform's job scheduler, behind a seam so tests never touch the real
/// `systemd-run`, `launchctl` or `schtasks`.
pub trait Scheduler {
    /// A dead-man is registered under the fixed name (pending or running).
    fn present(&self) -> Result<bool>;
    /// The dead-man runs right now (a rollback in progress).
    fn running(&self) -> Result<bool>;
    fn register(&self, spec: &DeadmanSpec) -> Result<()>;
    /// Remove a pending registration (never kills a running rollback).
    fn remove(&self) -> Result<()>;
}

/// How long [`arm`] waits for a running rollback and for the name to be free.
pub const ARM_WAIT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(250);

/// Arm the dead-man: wait out a rollback that runs now, remove a pending
/// dead-man (an earlier arm), poll until the name is free, then register.
pub fn arm(scheduler: &dyn Scheduler, spec: &DeadmanSpec, wait: Duration) -> Result<()> {
    let until = Instant::now() + wait;
    while scheduler.running()? {
        anyhow::ensure!(
            Instant::now() < until,
            "an update rollback is still running; try again later"
        );
        std::thread::sleep(POLL);
    }
    if scheduler.present()? {
        scheduler.remove()?;
    }
    while scheduler.present()? {
        anyhow::ensure!(
            Instant::now() < until,
            "the update dead-man's name did not become free"
        );
        std::thread::sleep(POLL);
    }
    scheduler.register(spec)?;
    anyhow::ensure!(scheduler.present()?, "the update dead-man did not register");
    Ok(())
}

/// Remove a pending dead-man; nothing registered is fine.
pub fn disarm(scheduler: &dyn Scheduler) -> Result<()> {
    if scheduler.present()? && !scheduler.running()? {
        scheduler.remove()?;
    }
    Ok(())
}

/// What a management command may print and is kept, per stream.
const OUTPUT_LIMIT: usize = 1 << 20;

/// Run a short management command with a deadline; its status, stdout and
/// stderr. It goes through [`crate::bounded_run::run_managed`]: both pipes are
/// drained at once (a program that fills stderr never blocks), it is killed
/// at the deadline with its process group (Unix; a helper that detached into
/// a session of its own is not reached) or its job (Windows), and a helper
/// that holds a pipe after it exited cannot hold the call past it.
pub(crate) fn run_bounded_split(
    program: impl AsRef<std::ffi::OsStr>,
    args: &[impl AsRef<std::ffi::OsStr>],
    env: &[(&str, String)],
    timeout: Duration,
) -> Result<(bool, String, String)> {
    let ran = run_bounded_status(program, args, env, timeout)?;
    Ok((ran.code == Some(0), ran.stdout, ran.stderr))
}

/// How a [`run_bounded_status`] command ended: it ran to its end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Exited {
    /// Its exit code; `None` when a signal ended it.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// [`run_bounded_split`] with the exit code: `Ok` only for a command that
/// ran to its end (whatever its status); an error when it could not be
/// started, ran out of time, or was stopped, so nothing is known of what it
/// would have said.
pub(crate) fn run_bounded_status(
    program: impl AsRef<std::ffi::OsStr>,
    args: &[impl AsRef<std::ffi::OsStr>],
    env: &[(&str, String)],
    timeout: Duration,
) -> Result<Exited> {
    let ran = run_bounded_bytes(program, args, env, timeout)?;
    Ok(Exited {
        code: ran.code,
        stdout: String::from_utf8_lossy(&ran.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&ran.stderr).into_owned(),
    })
}

/// [`run_bounded_status`] with stdout and stderr exactly as the program
/// wrote them (for output that must be read byte for byte, like a path).
pub(crate) fn run_bounded_bytes(
    program: impl AsRef<std::ffi::OsStr>,
    args: &[impl AsRef<std::ffi::OsStr>],
    env: &[(&str, String)],
    timeout: Duration,
) -> Result<crate::bounded_run::Managed> {
    use crate::bounded_run::{RunError, run_managed};
    let program = program.as_ref();
    // The program runs exactly as named; only the messages show it as text.
    let shown = Path::new(program).display();
    match run_managed(program, args, env, timeout, OUTPUT_LIMIT) {
        Ok(ran) => Ok(ran),
        Err(RunError::Spawn) => Err(anyhow::anyhow!("running `{shown}`: it could not start")),
        Err(RunError::Timeout) => Err(anyhow::anyhow!(
            "`{shown}` did not finish within {} s",
            timeout.as_secs()
        )),
        Err(RunError::Cancelled) => Err(anyhow::anyhow!("`{shown}` was stopped: wsmp is exiting")),
        Err(RunError::Resources) => Err(anyhow::anyhow!(
            "running `{shown}`: too many commands are running or stuck; try again later"
        )),
        // A managed run returns every exit status and drops output past the limit.
        Err(RunError::ExitStatus(_) | RunError::OutputTooLarge) => {
            Err(anyhow::anyhow!("running `{shown}` failed unexpectedly"))
        }
    }
}

/// [`run_bounded_split`] with stdout and then stderr as one text.
pub(crate) fn run_bounded(
    program: impl AsRef<std::ffi::OsStr>,
    args: &[impl AsRef<std::ffi::OsStr>],
    env: &[(&str, String)],
    timeout: Duration,
) -> Result<(bool, String)> {
    let (ok, out, err) = run_bounded_split(program, args, env, timeout)?;
    Ok((ok, format!("{out}{err}")))
}

// ── Linux / WSL ──

/// `systemd-calendar` time of `unix_secs` in UTC (`2026-10-28 12:00:00 UTC`).
pub fn systemd_calendar_utc(unix_secs: u64) -> String {
    // `YYYY-MM-DDTHH:MM:SSZ` → `YYYY-MM-DD HH:MM:SS UTC`.
    let stamp = crate::file_ops::fmt::rfc3339_secs(unix_secs);
    format!("{} UTC", stamp.trim_end_matches('Z').replacen('T', " ", 1))
}

/// The Linux dead-man's units, written to the user's systemd directory (not a
/// transient `systemd-run` timer, which a reboot loses): a service that runs
/// the rollback check, and a timer for the deadline. `Persistent=true` fires a
/// deadline that passed while the machine was off at the next boot; the check
/// then gives a build that came up after the reboot a full window of its own
/// ([`super::flow::rollback_if_unconfirmed`]). The service runs again a
/// minute after a run that exits nonzero (`Restart=on-failure`): the run whose
/// relay restart failed after a rollback, or that could not record it, keeps
/// the job, and the next run finishes it. A run that exits 0, or the job's own
/// removal (the timer disabled, the files gone), is not repeated. An error, with nothing
/// rendered, for a program or argument systemd would read differently
/// ([`crate::commands::service::systemd_exec_path`],
/// [`crate::commands::service::systemd_exec_arg`]: a `$` in an argument is
/// written `$$`, so systemd passes it as it is) or a path that is not exact
/// text ([`DeadmanSpec::rollback_args`]).
pub fn systemd_units(spec: &DeadmanSpec, deadline_unix: u64) -> Result<(String, String)> {
    use crate::commands::service::{systemd_exec_arg, systemd_exec_path};
    let exec: Vec<String> = std::iter::once(systemd_exec_path(spec.program_text()?))
        .chain(
            spec.rollback_args()?
                .iter()
                .map(|arg| systemd_exec_arg(arg)),
        )
        .collect::<Result<_>>()?;
    let service = format!(
        "[Unit]\n\
         Description=wsmp update dead-man {id}\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={exec}\n\
         TimeoutStartSec=infinity\n\
         Restart=on-failure\n\
         RestartSec=60\n",
        id = spec.update_id,
        exec = exec.join(" "),
    );
    let timer = format!(
        "[Unit]\n\
         Description=wsmp update dead-man {id}\n\
         \n\
         [Timer]\n\
         OnCalendar={at}\n\
         Persistent=true\n\
         AccuracySec=1s\n\
         Unit={LINUX_UNIT}.service\n\
         \n\
         [Install]\n\
         WantedBy=timers.target\n",
        id = spec.update_id,
        at = systemd_calendar_utc(deadline_unix),
    );
    Ok((service, timer))
}

/// From `systemctl --user show <unit> -p LoadState,ActiveState`: loaded, and
/// whether it is active.
pub fn systemd_unit_state(output: &str) -> (bool, bool) {
    let field = |key: &str| {
        output
            .lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
            .map(str::trim)
            .unwrap_or_default()
    };
    let loaded = !matches!(field("LoadState"), "" | "not-found");
    let active = matches!(
        field("ActiveState"),
        "active" | "activating" | "deactivating" | "reloading"
    );
    (loaded, active)
}

#[cfg(target_os = "linux")]
pub struct SystemdTimer;

#[cfg(target_os = "linux")]
impl SystemdTimer {
    fn env() -> Vec<(&'static str, String)> {
        if std::env::var_os("XDG_RUNTIME_DIR").is_some() {
            Vec::new()
        } else {
            vec![(
                "XDG_RUNTIME_DIR",
                format!("/run/user/{}", nix::unistd::Uid::effective().as_raw()),
            )]
        }
    }

    fn systemctl(args: &[&str]) -> Result<(bool, String)> {
        let args: Vec<String> = std::iter::once("--user")
            .chain(args.iter().copied())
            .map(str::to_string)
            .collect();
        run_bounded("systemctl", &args, &Self::env(), Duration::from_secs(15))
    }

    fn unit(suffix: &str) -> Result<(bool, bool)> {
        let unit = format!("{LINUX_UNIT}.{suffix}");
        let (_, output) = Self::systemctl(&["show", &unit, "-p", "LoadState,ActiveState"])?;
        Ok(systemd_unit_state(&output))
    }

    /// The unit files, beside the relay's own unit.
    fn files() -> Result<(PathBuf, PathBuf)> {
        let relay = crate::commands::service::service_file()?;
        let dir = relay
            .parent()
            .context("the systemd user unit directory")?
            .to_path_buf();
        Ok((
            dir.join(format!("{LINUX_UNIT}.service")),
            dir.join(format!("{LINUX_UNIT}.timer")),
        ))
    }
}

#[cfg(target_os = "linux")]
impl Scheduler for SystemdTimer {
    fn present(&self) -> Result<bool> {
        let (_, timer_file) = Self::files()?;
        let (_, timer_active) = Self::unit("timer")?;
        let (service, active) = Self::unit("service")?;
        Ok(timer_file.exists() || timer_active || (service && active))
    }
    fn running(&self) -> Result<bool> {
        Ok(Self::unit("service")?.1)
    }
    fn register(&self, spec: &DeadmanSpec) -> Result<()> {
        let (service_file, timer_file) = Self::files()?;
        let deadline = super::unix_now() + spec.fire_in.as_secs().max(1);
        let (service, timer) = systemd_units(spec, deadline)?;
        if let Some(dir) = service_file.parent() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("creating `{}`", dir.display()))?;
        }
        std::fs::write(&service_file, service)
            .with_context(|| format!("writing `{}`", service_file.display()))?;
        std::fs::write(&timer_file, timer)
            .with_context(|| format!("writing `{}`", timer_file.display()))?;
        let (reloaded, output) = Self::systemctl(&["daemon-reload"])?;
        anyhow::ensure!(
            reloaded,
            "`systemctl --user daemon-reload` failed: {}",
            output.trim()
        );
        let timer = format!("{LINUX_UNIT}.timer");
        let (enabled, output) = Self::systemctl(&["enable", "--now", &timer])?;
        anyhow::ensure!(
            enabled,
            "`systemctl --user enable --now {timer}` failed: {}",
            output.trim()
        );
        Ok(())
    }
    fn remove(&self) -> Result<()> {
        let timer = format!("{LINUX_UNIT}.timer");
        let service = format!("{LINUX_UNIT}.service");
        // Never stops the service: a rollback that runs now finishes.
        let _ = Self::systemctl(&["disable", "--now", &timer]);
        let (service_file, timer_file) = Self::files()?;
        for file in [&timer_file, &service_file] {
            match std::fs::remove_file(file) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error).with_context(|| format!("removing `{}`", file.display()));
                }
            }
        }
        let _ = Self::systemctl(&["daemon-reload"]);
        let _ = Self::systemctl(&["reset-failed", &timer, &service]);
        Ok(())
    }
}

// ── macOS ──

/// The LaunchAgent that runs the rollback command (which sleeps until the
/// deadline itself), once, and again a minute after a run that exits nonzero
/// (`KeepAlive`/`SuccessfulExit` false, `ThrottleInterval`): a rollback whose
/// relay restart failed, or that could not be recorded, is finished by the
/// next run. Removing the agent (`bootout`) ends it. Each value is plist text
/// ([`crate::commands::service::plist_text`]), each path exact text
/// ([`crate::commands::service::path_text`]): an error, with nothing
/// rendered, for one XML cannot carry.
pub fn render_macos_plist(
    label: &str,
    program: &Path,
    args: &[String],
    log: &Path,
) -> Result<String> {
    use crate::commands::service::path_text;
    let escape = crate::commands::service::plist_text;
    let program = path_text("the rollback job's wsmp", program)?;
    let log = path_text("the dead-man log path", log)?;
    let arguments: String = std::iter::once(program.to_string())
        .chain(args.iter().cloned())
        .map(|arg| {
            Ok(format!(
                "\t\t<string>{}</string>\n",
                escape("the dead-man argument", &arg)?
            ))
        })
        .collect::<Result<_>>()?;
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \t<key>Label</key>\n\
         \t<string>{label}</string>\n\
         \t<key>ProgramArguments</key>\n\
         \t<array>\n\
         {arguments}\
         \t</array>\n\
         \t<key>RunAtLoad</key>\n\
         \t<true/>\n\
         \t<key>KeepAlive</key>\n\
         \t<dict>\n\
         \t\t<key>SuccessfulExit</key>\n\
         \t\t<false/>\n\
         \t</dict>\n\
         \t<key>ThrottleInterval</key>\n\
         \t<integer>60</integer>\n\
         \t<key>ProcessType</key>\n\
         \t<string>Background</string>\n\
         \t<key>StandardOutPath</key>\n\
         \t<string>{log}</string>\n\
         \t<key>StandardErrorPath</key>\n\
         \t<string>{log}</string>\n\
         </dict>\n\
         </plist>\n",
        label = escape("the LaunchAgent label", label)?,
        log = escape("the dead-man log path", log)?,
    ))
}

#[cfg(target_os = "macos")]
pub struct LaunchAgent;

#[cfg(target_os = "macos")]
impl LaunchAgent {
    fn domain() -> String {
        format!("gui/{}", nix::unistd::Uid::effective().as_raw())
    }
    pub fn plist_path() -> Result<PathBuf> {
        let home = dirs::home_dir().context("could not determine the user home directory")?;
        Ok(home
            .join("Library/LaunchAgents")
            .join(format!("{MACOS_LABEL}.plist")))
    }
    fn print() -> Result<Option<String>> {
        let target = format!("{}/{MACOS_LABEL}", Self::domain());
        let (ok, output) = run_bounded(
            "launchctl",
            &["print".into(), target],
            &[],
            Duration::from_secs(15),
        )?;
        Ok(ok.then_some(output))
    }
}

#[cfg(target_os = "macos")]
impl Scheduler for LaunchAgent {
    fn present(&self) -> Result<bool> {
        Ok(Self::print()?.is_some() || Self::plist_path()?.exists())
    }
    fn running(&self) -> Result<bool> {
        Ok(Self::print()?.is_some_and(|text| text.contains("state = running")))
    }
    fn register(&self, spec: &DeadmanSpec) -> Result<()> {
        let plist = Self::plist_path()?;
        // Everything rendered and checked before anything is written.
        let log = spec.state_dir.join("update").join("deadman.log");
        let body = render_macos_plist(MACOS_LABEL, &spec.program, &spec.rollback_args()?, &log)?;
        let plist_arg =
            crate::commands::service::path_text("the dead-man LaunchAgent", &plist)?.to_string();
        if let Some(parent) = plist.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating `{}`", parent.display()))?;
        }
        std::fs::write(&plist, body).with_context(|| format!("writing `{}`", plist.display()))?;
        let (ok, output) = run_bounded(
            "launchctl",
            &["bootstrap".into(), Self::domain(), plist_arg],
            &[],
            Duration::from_secs(15),
        )?;
        anyhow::ensure!(
            ok,
            "`launchctl bootstrap` refused the update dead-man: {}",
            output.trim()
        );
        Ok(())
    }
    fn remove(&self) -> Result<()> {
        // The plist first: when the dead-man removes itself, the bootout ends
        // its own process, and nothing after it runs. Bootout by label needs no
        // file.
        let plist = Self::plist_path()?;
        if plist.exists() {
            std::fs::remove_file(&plist)
                .with_context(|| format!("removing `{}`", plist.display()))?;
        }
        let _ = run_bounded(
            "launchctl",
            &[
                "bootout".into(),
                format!("{}/{MACOS_LABEL}", Self::domain()),
            ],
            &[],
            Duration::from_secs(15),
        );
        Ok(())
    }
}

// ── Windows ──

/// The task: a +5 s trigger (start the relay again) and the deadline
/// trigger, both running `conhost --headless <program> update rollback …`
/// (the recovery copy, [`DeadmanSpec::program`]). The
/// triggers never expire: a machine off for days still runs the deadline at
/// the next log on (`StartWhenAvailable`), and the rollback command removes
/// the task once the update is settled. The deadline trigger repeats every
/// 10 minutes until then (Task Scheduler's `RestartOnFailure` is for a task
/// that fails to start, not for a nonzero exit): a run whose relay restart
/// failed after a rollback, or that could not record it, keeps the task, and
/// a later run finishes it.
pub fn render_windows_task(
    user_sid: &str,
    arguments: &str,
    kick_at_unix: u64,
    deadline_unix: u64,
) -> String {
    let at = crate::file_ops::fmt::rfc3339_secs;
    let escape = |value: &str| {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
         <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n\
         \x20 <RegistrationInfo>\n\
         \x20   <Description>wsmp update dead-man: rolls back an update that did not confirm.</Description>\n\
         \x20 </RegistrationInfo>\n\
         \x20 <Triggers>\n\
         \x20   <TimeTrigger>\n\
         \x20     <StartBoundary>{kick}</StartBoundary>\n\
         \x20     <Enabled>true</Enabled>\n\
         \x20   </TimeTrigger>\n\
         \x20   <TimeTrigger>\n\
         \x20     <Repetition>\n\
         \x20       <Interval>PT10M</Interval>\n\
         \x20       <StopAtDurationEnd>false</StopAtDurationEnd>\n\
         \x20     </Repetition>\n\
         \x20     <StartBoundary>{deadline}</StartBoundary>\n\
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
         \x20   <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>\n\
         \x20   <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n\
         \x20   <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n\
         \x20   <StartWhenAvailable>true</StartWhenAvailable>\n\
         \x20   <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>\n\
         \x20   <Enabled>true</Enabled>\n\
         \x20 </Settings>\n\
         \x20 <Actions Context=\"Author\">\n\
         \x20   <Exec>\n\
         \x20     <Command>%SystemRoot%\\System32\\conhost.exe</Command>\n\
         \x20     <Arguments>{arguments}</Arguments>\n\
         \x20   </Exec>\n\
         \x20 </Actions>\n\
         </Task>\n",
        kick = at(kick_at_unix),
        deadline = at(deadline_unix),
        sid = escape(user_sid),
        arguments = escape(arguments),
    )
}

/// `--headless <program> update rollback …`, quoted for the task's command
/// line. An error for a path that is not exact text
/// ([`DeadmanSpec::rollback_args`]).
pub fn windows_task_arguments(spec: &DeadmanSpec) -> Result<String> {
    use crate::commands::service::windows_task::quote_arg;
    Ok(std::iter::once("--headless".to_string())
        .chain(std::iter::once(spec.program_text()?.to_string()))
        .chain(spec.rollback_args()?)
        .map(|arg| quote_arg(&arg))
        .collect::<Vec<_>>()
        .join(" "))
}

#[cfg(windows)]
pub struct ScheduledTask;

#[cfg(windows)]
impl ScheduledTask {
    fn name() -> Result<String> {
        Ok(windows_task_name(
            &std::env::var("USERNAME").context("`USERNAME` is not set")?,
        ))
    }
    fn schtasks(args: &[&str]) -> Result<(bool, String)> {
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
        run_bounded("schtasks", &args, &[], Duration::from_secs(30))
    }
}

#[cfg(windows)]
impl Scheduler for ScheduledTask {
    fn present(&self) -> Result<bool> {
        Ok(Self::schtasks(&["/Query", "/TN", &Self::name()?])?.0)
    }
    fn running(&self) -> Result<bool> {
        let script = format!(
            "(Get-ScheduledTask -TaskName {} -ErrorAction Stop).State",
            powershell_quote(&Self::name()?)
        );
        let (_, output) = run_bounded(
            "powershell",
            &[
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                script,
            ],
            &[],
            Duration::from_secs(30),
        )?;
        Ok(output.trim() == "Running")
    }
    fn register(&self, spec: &DeadmanSpec) -> Result<()> {
        let now = super::unix_now();
        let sid = wsmp_windows::current_user_sid().context("reading this user's SID")?;
        let xml = render_windows_task(
            &sid,
            &windows_task_arguments(spec)?,
            now + WINDOWS_KICK_AFTER.as_secs(),
            now + spec.fire_in.as_secs(),
        );
        let file = spec.state_dir.join("update").join("deadman-task.xml");
        // Checked before the file is written: `schtasks` is given it.
        let file_arg =
            crate::commands::service::path_text("the dead-man task definition", &file)?.to_string();
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating `{}`", parent.display()))?;
        }
        std::fs::write(
            &file,
            crate::commands::service::windows_task::utf16_bytes(&xml),
        )
        .with_context(|| format!("writing `{}`", file.display()))?;
        let name = Self::name()?;
        let (ok, output) = Self::schtasks(&["/Create", "/TN", &name, "/XML", &file_arg, "/F"])?;
        anyhow::ensure!(
            ok,
            "`schtasks /Create` refused the update dead-man: {}",
            output.trim()
        );
        Ok(())
    }
    fn remove(&self) -> Result<()> {
        let _ = Self::schtasks(&["/Delete", "/TN", &Self::name()?, "/F"]);
        Ok(())
    }
}

/// `value` as a PowerShell single-quoted string (a `'` in it is doubled, as
/// in a user name such as `O'Brien`).
#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// When this machine last started (Unix seconds): Linux (`btime` in
/// `/proc/stat`), macOS (`kern.boottime`) and Windows (now less the uptime).
/// Each dead-man comes back after a reboot (`Persistent=true`, `RunAtLoad`,
/// `StartWhenAvailable`), and the rollback check uses this to give a build
/// that started after the reboot a full window of its own.
pub fn booted_at() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string("/proc/stat").ok()?;
        parse_proc_stat_btime(&text)
    }
    #[cfg(target_os = "macos")]
    {
        let (ok, text) = run_bounded(
            "sysctl",
            &["-n".to_string(), "kern.boottime".to_string()],
            &[],
            Duration::from_secs(5),
        )
        .ok()?;
        if !ok {
            return None;
        }
        parse_kern_boottime(&text)
    }
    #[cfg(windows)]
    {
        Some(super::unix_now().saturating_sub(wsmp_windows::uptime_ms() / 1000))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        None
    }
}

/// `btime <secs>` in `/proc/stat`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_proc_stat_btime(text: &str) -> Option<u64> {
    text.lines()
        .find_map(|line| line.strip_prefix("btime "))
        .and_then(|secs| secs.trim().parse().ok())
}

/// `{ sec = 1793102490, usec = 123 } Tue Oct 27 ...` from `sysctl -n kern.boottime`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_kern_boottime(text: &str) -> Option<u64> {
    let rest = text.split("sec = ").nth(1)?;
    rest.split(|ch: char| !ch.is_ascii_digit())
        .next()
        .and_then(|secs| secs.parse().ok())
}

/// This platform's dead-man scheduler; `None` where there is none.
pub fn platform() -> Option<Box<dyn Scheduler>> {
    #[cfg(target_os = "linux")]
    return Some(Box::new(SystemdTimer));
    #[cfg(target_os = "macos")]
    return Some(Box::new(LaunchAgent));
    #[cfg(windows)]
    return Some(Box::new(ScheduledTask));
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    None
}

#[cfg(test)]
pub(crate) mod fake {
    use std::cell::RefCell;

    use super::*;

    /// A scheduler in memory: what was registered, and how often.
    #[derive(Default)]
    pub struct FakeScheduler {
        pub registered: RefCell<Option<DeadmanSpec>>,
        pub registrations: RefCell<u32>,
        pub removals: RefCell<u32>,
        /// `running()` answers true this many more times.
        pub running_for: RefCell<u32>,
        pub refuse: RefCell<bool>,
        /// Called inside `register`, after the job is registered: what
        /// happens elsewhere while the service manager registers it.
        #[allow(clippy::type_complexity)]
        pub during_register: RefCell<Option<Box<dyn Fn()>>>,
    }

    impl Scheduler for FakeScheduler {
        fn present(&self) -> Result<bool> {
            Ok(self.registered.borrow().is_some())
        }
        fn running(&self) -> Result<bool> {
            let mut left = self.running_for.borrow_mut();
            if *left > 0 {
                *left -= 1;
                return Ok(true);
            }
            Ok(false)
        }
        fn register(&self, spec: &DeadmanSpec) -> Result<()> {
            anyhow::ensure!(!*self.refuse.borrow(), "refused");
            anyhow::ensure!(self.registered.borrow().is_none(), "name taken");
            *self.registered.borrow_mut() = Some(spec.clone());
            *self.registrations.borrow_mut() += 1;
            if let Some(during) = self.during_register.borrow().as_ref() {
                during();
            }
            Ok(())
        }
        fn remove(&self) -> Result<()> {
            *self.registered.borrow_mut() = None;
            *self.removals.borrow_mut() += 1;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeScheduler;
    use super::*;

    #[cfg(unix)]
    fn sh(script: &str) -> Vec<String> {
        vec!["-c".into(), script.into()]
    }

    #[cfg(unix)]
    #[test]
    fn a_program_that_fills_stderr_before_closing_stdout_is_not_blocked() {
        // 256 KiB on stderr while stdout is still open, then a line on stdout:
        // reading stdout to its end first would block the program on the full
        // stderr pipe until the deadline.
        let started = Instant::now();
        let (ok, out, err) = run_bounded_split(
            "sh",
            &sh("head -c 262144 /dev/zero | tr '\\0' e >&2; echo done"),
            &[],
            Duration::from_secs(20),
        )
        .expect("finishes");
        assert!(ok);
        assert_eq!(out, "done\n");
        assert_eq!(err.len(), 262_144);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn output_past_the_limit_is_drained_and_dropped_not_fatal() {
        let (ok, out, err) = run_bounded_split(
            "sh",
            &sh("head -c 3145728 /dev/zero; echo end >&2; exit 3"),
            &[],
            Duration::from_secs(20),
        )
        .expect("finishes");
        assert!(!ok, "the exit status is the program's");
        assert_eq!(out.len(), OUTPUT_LIMIT);
        assert_eq!(err, "end\n");
        // stdout first, then stderr, as one text.
        let (_, text) = run_bounded(
            "sh",
            &sh("echo err >&2; echo out"),
            &[("WSMP_TEST_EXTRA", "x".into())],
            Duration::from_secs(20),
        )
        .expect("finishes");
        assert_eq!(text, "out\nerr\n");
    }

    #[cfg(unix)]
    #[test]
    fn management_commands_inherit_the_environment_and_take_extra_values() {
        let (ok, out, _) = run_bounded_split(
            "sh",
            &sh("printf '%s %s' \"$WSMP_TEST_EXTRA\" \"${HOME:+home}\""),
            &[("WSMP_TEST_EXTRA", "extra".into())],
            Duration::from_secs(20),
        )
        .expect("finishes");
        assert!(ok);
        assert_eq!(out, "extra home");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_helper_holding_the_pipes_cannot_hold_the_call_past_its_deadline() {
        let dir = tempfile::tempdir().expect("dir");
        let pid_file = dir.path().join("helper.pid");
        // The program exits at once; the helper it started keeps stdout and
        // stderr open for 60 s.
        let script = format!(
            "sleep 60 & echo $! > '{}'; echo started",
            pid_file.display()
        );
        let started = Instant::now();
        let result = run_bounded_split("sh", &sh(&script), &[], Duration::from_secs(2));
        let elapsed = started.elapsed();
        let error = result.expect_err("the helper holds the pipes past the deadline");
        assert!(
            format!("{error:#}").contains("did not finish within 2 s"),
            "{error:#}"
        );
        assert!(elapsed < Duration::from_secs(6), "{elapsed:?}");
        // The helper was in the program's group and was killed with it.
        let pid: i32 = std::fs::read_to_string(&pid_file)
            .expect("pid")
            .trim()
            .parse()
            .expect("pid number");
        let gone = (0..200).any(|_| {
            let dead = std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .map(|stat| stat.contains(") Z "))
                .unwrap_or(true);
            if !dead {
                std::thread::sleep(Duration::from_millis(25));
            }
            dead
        });
        assert!(gone, "the helper {pid} still runs");
    }

    #[test]
    fn a_program_that_cannot_start_is_an_error() {
        let error = run_bounded(
            "wsmp-no-such-program",
            &[] as &[&str],
            &[],
            Duration::from_secs(5),
        )
        .expect_err("missing");
        assert!(
            format!("{error:#}").contains("could not start"),
            "{error:#}"
        );
    }

    #[test]
    fn task_names_are_quoted_for_powershell() {
        assert_eq!(
            powershell_quote("wsmp-update-deadman-O'Brien"),
            "'wsmp-update-deadman-O''Brien'"
        );
    }

    fn spec(id: &str) -> DeadmanSpec {
        DeadmanSpec {
            update_id: id.into(),
            program: PathBuf::from("/home/u/.cargo/bin/.wsmp-recovery-abc"),
            state_dir: PathBuf::from("/home/u/.local/state/ws-model-proxy"),
            fire_in: Duration::from_secs(90),
        }
    }

    /// R7-B-1: a relative previous binary or state directory is resolved
    /// against this process's working directory when the spec is built (the
    /// scheduler starts the job elsewhere); an absolute one keeps its bytes
    /// (`$`, spaces, not UTF-8); an empty one is refused.
    #[test]
    fn a_spec_makes_its_paths_absolute_and_refuses_an_empty_one() {
        let cwd = std::env::current_dir().expect("cwd");
        let relative = DeadmanSpec::new(
            "abc".into(),
            Path::new("bin/wsmp.prev"),
            Path::new("relative-state"),
            Duration::from_secs(90),
        )
        .expect("relative");
        assert_eq!(relative.program(), cwd.join("bin/wsmp.prev"));
        assert_eq!(relative.state_dir(), cwd.join("relative-state"));
        assert!(relative.state_dir().is_absolute() && relative.program().is_absolute());
        let args = relative.rollback_args().expect("args");
        assert_eq!(
            args.last().map(String::as_str),
            cwd.join("relative-state").to_str()
        );

        let absolute = spec("abc");
        let kept = DeadmanSpec::new(
            "abc".into(),
            absolute.program(),
            absolute.state_dir(),
            absolute.fire_in(),
        )
        .expect("absolute");
        assert_eq!(kept, absolute);
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            let raw = std::ffi::OsStr::from_bytes(b"/tmp/${HOME}/$$/a b%/state-\xff");
            let kept = DeadmanSpec::new(
                "abc".into(),
                Path::new("/tmp/wsmp.prev"),
                Path::new(raw),
                Duration::from_secs(1),
            )
            .expect("raw");
            assert_eq!(kept.state_dir().as_os_str(), raw);
        }

        for (prev, state) in [("", "/tmp/state"), ("/tmp/wsmp.prev", "")] {
            let error = DeadmanSpec::new(
                "abc".into(),
                Path::new(prev),
                Path::new(state),
                Duration::from_secs(1),
            )
            .expect_err("empty");
            assert!(format!("{error:#}").contains("is empty"), "{error:#}");
        }
    }

    #[test]
    fn arming_twice_leaves_one_dead_man() {
        let scheduler = FakeScheduler::default();
        arm(&scheduler, &spec("first"), ARM_WAIT).expect("arm");
        arm(&scheduler, &spec("second"), ARM_WAIT).expect("arm again");
        assert_eq!(*scheduler.registrations.borrow(), 2);
        assert_eq!(*scheduler.removals.borrow(), 1);
        assert_eq!(
            scheduler
                .registered
                .borrow()
                .as_ref()
                .map(|s| s.update_id.as_str()),
            Some("second")
        );
        disarm(&scheduler).expect("disarm");
        assert!(scheduler.registered.borrow().is_none());
        disarm(&scheduler).expect("disarm twice");
    }

    #[test]
    fn arming_waits_for_a_running_rollback() {
        let scheduler = FakeScheduler::default();
        *scheduler.running_for.borrow_mut() = 2;
        arm(&scheduler, &spec("id"), ARM_WAIT).expect("arm");
        assert!(scheduler.registered.borrow().is_some());
        let busy = FakeScheduler::default();
        *busy.running_for.borrow_mut() = u32::MAX;
        assert!(arm(&busy, &spec("id"), Duration::from_millis(300)).is_err());
        assert!(busy.registered.borrow().is_none());
    }

    #[test]
    fn boot_times_parse() {
        assert_eq!(
            parse_proc_stat_btime("cpu  1 2 3\nbtime 1793102490\nprocesses 9\n"),
            Some(1_793_102_490)
        );
        assert_eq!(parse_proc_stat_btime("cpu 1\n"), None);
        assert_eq!(
            parse_kern_boottime("{ sec = 1793102490, usec = 81234 } Tue Oct 27 12:01:30 2026\n"),
            Some(1_793_102_490)
        );
        assert_eq!(parse_kern_boottime("garbage"), None);
    }

    #[test]
    fn the_linux_dead_man_is_a_persistent_timer_that_runs_the_previous_binary() {
        // 2026-10-28 12:01:30 UTC.
        let (service, timer) = systemd_units(&spec("abc"), 1_793_188_890).expect("units");
        assert!(
            service.contains(
                "ExecStart=/home/u/.cargo/bin/.wsmp-recovery-abc update rollback --if-unconfirmed abc \
                 --state-dir /home/u/.local/state/ws-model-proxy\n"
            ),
            "{service}"
        );
        assert!(service.contains("TimeoutStartSec=infinity\n"), "{service}");
        // F-FA-5: a run that exits nonzero (its relay restart failed after a rollback) runs
        // again, so the job is not a one-shot recovery that a failure ends.
        assert!(
            service.contains("Restart=on-failure\nRestartSec=60\n"),
            "{service}"
        );
        assert!(
            timer.contains("OnCalendar=2026-10-28 12:01:30 UTC\n"),
            "{timer}"
        );
        // Survives a reboot: a deadline missed while the machine was off fires at boot.
        assert!(timer.contains("Persistent=true\n"), "{timer}");
        assert!(timer.contains("WantedBy=timers.target\n"), "{timer}");
        assert!(
            timer.contains("Unit=wsmp-update-deadman.service\n"),
            "{timer}"
        );
    }

    #[test]
    fn the_macos_dead_man_runs_once_and_again_after_a_failed_run() {
        let plist = render_macos_plist(
            MACOS_LABEL,
            Path::new("/Users/u/.cargo/bin/.wsmp-recovery-abc"),
            &spec("abc").rollback_args().expect("args"),
            Path::new("/tmp/log & more"),
        )
        .expect("plist");
        assert!(plist.contains("<string>com.flycockpit.wsmp.update-deadman</string>"));
        assert!(plist.contains("<string>/Users/u/.cargo/bin/.wsmp-recovery-abc</string>"));
        assert!(plist.contains("<string>--if-unconfirmed</string>\n\t\t<string>abc</string>"));
        // F-FA-5: relaunched only after a nonzero exit, at most once a minute.
        assert!(plist.contains(
            "<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>"
        ));
        assert!(plist.contains("<key>ThrottleInterval</key>\n\t<integer>60</integer>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n\t<true/>"));
        assert!(plist.contains("/tmp/log &amp; more"));
    }

    /// R5-A-1: a dead-man job is never written with a value its manager
    /// would read differently: a control character in the state directory
    /// or the previous binary, or a program systemd refuses (a quote).
    #[test]
    fn a_dead_man_job_refuses_a_value_its_manager_cannot_read() {
        let mut bad = spec("abc");
        bad.state_dir = PathBuf::from("/home/u/state\nExecStart=/bin/false");
        let error = systemd_units(&bad, 1_793_188_890).expect_err("newline");
        assert!(format!("{error:#}").contains("U+000A"), "{error:#}");
        let error = render_macos_plist(
            MACOS_LABEL,
            &bad.program,
            &bad.rollback_args().expect("args"),
            Path::new("/tmp/log"),
        )
        .expect_err("newline");
        assert!(format!("{error:#}").contains("U+000A"), "{error:#}");
        let mut quoted = spec("abc");
        quoted.program = PathBuf::from("/home/u/a\"b/wsmp.prev");
        assert!(systemd_units(&quoted, 1_793_188_890).is_err());
        let mut nul = spec("abc");
        nul.program = PathBuf::from("/home/u/wsmp\0.prev");
        assert!(systemd_units(&nul, 1_793_188_890).is_err());
    }

    /// R6-B-2 / R6-A-1: a `$` in a dead-man argument is written `$$`, so
    /// systemd (which expands `${NAME}` and `$NAME` in `ExecStart=`
    /// arguments, inside quotes too) passes the state directory as it is. The
    /// program path keeps its `$` (systemd runs it as written), and `%`,
    /// spaces and quotes are written as before.
    #[test]
    fn a_dollar_in_a_dead_man_argument_reaches_the_rollback_as_it_is() {
        let mut odd = spec("abc");
        odd.program = PathBuf::from("/home/u/$HOME/wsmp.prev");
        odd.state_dir = PathBuf::from("/tmp/${HOME}/$$/a b%/\"q\"");
        let (service, _) = systemd_units(&odd, 1_793_188_890).expect("units");
        assert!(
            service.contains(
                "ExecStart=\"/home/u/$HOME/wsmp.prev\" update rollback --if-unconfirmed abc \
                 --state-dir \"/tmp/$${HOME}/$$$$/a b%%/\\\"q\\\"\"\n"
            ),
            "{service}"
        );
    }

    /// R5-A-1 sibling / R6-A-2: a path that is not UTF-8 (the state
    /// directory, the previous binary, the macOS log) is refused before
    /// anything is rendered: `display()` would have written U+FFFD and so
    /// armed a job that looks in another directory, finds no update and rolls
    /// nothing back.
    #[cfg(unix)]
    #[test]
    fn a_path_that_is_not_text_is_refused_before_any_job_is_rendered() {
        use std::os::unix::ffi::OsStringExt;
        let raw = |bytes: &[u8]| PathBuf::from(std::ffi::OsString::from_vec(bytes.to_vec()));
        let mut state = spec("abc");
        state.state_dir = raw(b"/tmp/state-\xff");
        let mut prev = spec("abc");
        prev.program = raw(b"/tmp/wsmp\xfe.prev");
        for bad in [&state, &prev] {
            assert!(systemd_units(bad, 1_793_188_890).is_err(), "{bad:?}");
            assert!(windows_task_arguments(bad).is_err(), "{bad:?}");
        }
        let error = state.rollback_args().expect_err("state");
        assert!(
            format!("{error:#}").contains("not valid UTF-8"),
            "{error:#}"
        );
        let args = spec("abc").rollback_args().expect("args");
        assert!(
            render_macos_plist(MACOS_LABEL, &prev.program, &args, Path::new("/tmp/l")).is_err()
        );
        assert!(
            render_macos_plist(
                MACOS_LABEL,
                Path::new("/tmp/wsmp.prev"),
                &args,
                &raw(b"/tmp/log-\x80")
            )
            .is_err()
        );
    }

    /// R5-A-1 sibling / R6-B-2, through the real Linux registration (in a
    /// child, with `XDG_CONFIG_HOME` in a temp dir and a fake `systemctl`
    /// that logs its calls): a state directory that is not UTF-8 is refused
    /// with no unit written and no `systemctl` run; one with `${HOME}`,
    /// `$$`, `%` and a space is registered with `$` written `$$`.
    #[cfg(target_os = "linux")]
    #[test]
    fn registration_refuses_a_path_that_is_not_text_and_keeps_dollars() {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};
        if let Some(out) = std::env::var_os("WSMP_TEST_DEADMAN_RESULT") {
            // The update id too, for a probe outside the tests (an empty one).
            let mut bad =
                spec(&std::env::var("WSMP_TEST_DEADMAN_ID").unwrap_or_else(|_| "abc".into()));
            bad.state_dir = PathBuf::from(std::ffi::OsString::from_vec(
                std::env::var_os("WSMP_TEST_DEADMAN_STATE")
                    .expect("state")
                    .as_bytes()
                    .to_vec(),
            ));
            let result = SystemdTimer.register(&bad);
            std::fs::write(out, format!("{result:?}")).expect("result");
            return;
        }
        let root = tempfile::tempdir().expect("root");
        let bin = root.path().join("bin");
        std::fs::create_dir(&bin).expect("bin");
        let systemctl = bin.join("systemctl");
        std::fs::write(
            &systemctl,
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$WSMP_TEST_CALLS\"\nexit 0\n",
        )
        .expect("systemctl");
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&systemctl, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
        }
        let register = |case: &str, state: &[u8]| {
            let dir = root.path().join(case);
            let result = dir.join("result");
            let calls = dir.join("calls");
            std::fs::create_dir(&dir).expect("dir");
            let child = std::process::Command::new(std::env::current_exe().expect("exe"))
                .args([
                    "--exact",
                    "update::deadman::tests::registration_refuses_a_path_that_is_not_text_and_keeps_dollars",
                    "--nocapture",
                ])
                .env("WSMP_TEST_DEADMAN_RESULT", &result)
                .env(
                    "WSMP_TEST_DEADMAN_STATE",
                    std::ffi::OsStr::from_bytes(state),
                )
                .env("WSMP_TEST_CALLS", &calls)
                .env("XDG_CONFIG_HOME", dir.join("config"))
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .output()
                .expect("child");
            assert!(
                child.status.success(),
                "{}",
                String::from_utf8_lossy(&child.stderr)
            );
            let units = dir.join("config/systemd/user");
            (
                std::fs::read_to_string(result).expect("result"),
                std::fs::read_to_string(units.join(format!("{LINUX_UNIT}.service"))).ok(),
                std::fs::read_to_string(calls).unwrap_or_default(),
            )
        };

        let (result, unit, calls) = register("nonutf8", b"/tmp/state-\xff");
        assert!(
            result.contains("not valid UTF-8") && result.contains("nothing was written"),
            "{result}"
        );
        assert_eq!(unit, None);
        assert_eq!(calls, "");

        let (result, unit, calls) = register("dollar", b"/tmp/${HOME}/$$/a b%");
        assert_eq!(result, "Ok(())");
        let unit = unit.expect("unit");
        assert!(
            unit.contains("--state-dir \"/tmp/$${HOME}/$$$$/a b%%\"\n"),
            "{unit}"
        );
        assert!(
            calls.contains("enable --now wsmp-update-deadman.timer"),
            "{calls}"
        );
    }

    #[test]
    fn the_windows_dead_man_kicks_then_rolls_back() {
        let mut windows = spec("abc");
        windows.program = PathBuf::from(r"C:\Users\A B\.cargo\bin\.wsmp-recovery-abc.exe");
        windows.state_dir = PathBuf::from(r"C:\Users\A B\AppData\Local\ws-model-proxy");
        let arguments = windows_task_arguments(&windows).expect("arguments");
        assert_eq!(
            arguments,
            r#"--headless "C:\Users\A B\.cargo\bin\.wsmp-recovery-abc.exe" update rollback --if-unconfirmed abc --state-dir "C:\Users\A B\AppData\Local\ws-model-proxy""#
        );
        let xml = render_windows_task("S-1-5-21-1", &arguments, 1_700_000_005, 1_700_000_090);
        assert!(xml.contains("<StartBoundary>2023-11-14T22:13:25Z</StartBoundary>"));
        assert!(xml.contains("<StartBoundary>2023-11-14T22:14:50Z</StartBoundary>"));
        // Never expires: a machine off for days still runs the deadline at log on.
        assert!(!xml.contains("EndBoundary"));
        assert!(!xml.contains("DeleteExpiredTaskAfter"));
        assert!(xml.contains("<StartWhenAvailable>true</StartWhenAvailable>"));
        // F-FA-5: the deadline trigger repeats until the task is removed (a failed run, its
        // relay restart after a rollback, is tried again); the early +5 s trigger does not.
        let deadline = xml
            .split("<TimeTrigger>")
            .find(|trigger| trigger.contains("2023-11-14T22:14:50Z"))
            .expect("deadline trigger");
        assert!(deadline.contains(
            "<Repetition>\n        <Interval>PT10M</Interval>\n        <StopAtDurationEnd>false</StopAtDurationEnd>\n      </Repetition>"
        ), "{deadline}");
        assert!(!deadline.contains("<Duration>"));
        assert_eq!(xml.matches("<Repetition>").count(), 1);
        assert!(xml.contains("&quot;C:\\Users\\A B"));
        assert_eq!(windows_task_name("me"), "wsmp-update-deadman-me");
    }
}
