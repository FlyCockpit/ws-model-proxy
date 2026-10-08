//! The machine side of the executor: systemd user units on Linux (the node
//! owns `wsmp-<handle>-r<rank>[-prepare|-after-join]`), shell commands with
//! the definition's node secrets, HTTP readiness on the instance port.
//!
//! Secrets reach a unit through `systemd-run --setenv=NAME` (value taken from
//! systemd-run's own environment), never on a command line.

#[cfg(target_os = "linux")]
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "linux")]
use std::time::Duration;

use anyhow::{Context, Result};

use super::{Deadline, Job, Runtime, command_env};
use crate::protocol::frames::JobPhase;
use crate::protocol::runtime_spec::Management;

pub struct NativeRuntime {
    pub cancel: Option<Arc<AtomicBool>>,
}

#[cfg(target_os = "linux")]
fn manager_until(
    program: &str,
    args: &[String],
    deadline: Deadline,
    cancel: Option<&AtomicBool>,
    env: &[(String, String)],
) -> Result<String> {
    manager_output_until(program, args, deadline, cancel, false, env)
}

/// A user-manager call with `XDG_RUNTIME_DIR` set. With `any_status`,
/// stdout is returned whatever the exit status.
#[cfg(target_os = "linux")]
fn manager_output_until(
    program: &str,
    args: &[String],
    deadline: Deadline,
    cancel: Option<&AtomicBool>,
    any_status: bool,
    env: &[(String, String)],
) -> Result<String> {
    deadline.remaining()?;
    let mut invocation = vec![
        format!(
            "XDG_RUNTIME_DIR=/run/user/{}",
            nix::unistd::Uid::effective().as_raw()
        ),
        program.to_owned(),
    ];
    invocation.extend_from_slice(args);
    let bytes = if any_status {
        crate::bounded_run::run_until_any_status(
            "env",
            &invocation,
            deadline.instant(),
            8192,
            cancel,
        )
    } else {
        crate::bounded_run::run_until_env("env", &invocation, deadline.instant(), 8192, cancel, env)
    }
    .map_err(|_| anyhow::anyhow!("the systemd user manager did not answer"))?;
    String::from_utf8(bytes).context("the systemd user manager answered invalid text")
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn user_manager_live(state: &str) -> bool {
    matches!(state.trim(), "running" | "degraded" | "starting")
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linger_enabled(output: &str) -> bool {
    output.lines().any(|line| {
        line.trim()
            .split_once('=')
            .is_some_and(|(key, value)| key.trim() == "Linger" && value.trim() == "yes")
    })
}

/// `systemd+linger`, `systemd-no-linger`, `macos` or `unsupported`.
pub fn mechanism_until(deadline: Deadline, cancel: Option<&AtomicBool>) -> &'static str {
    #[cfg(target_os = "linux")]
    {
        let uid = nix::unistd::Uid::effective().as_raw().to_string();
        let manager_running = manager_output_until(
            "systemctl",
            &["--user".into(), "is-system-running".into()],
            deadline,
            cancel,
            true,
            &[],
        )
        .is_ok_and(|state| user_manager_live(&state));
        if !manager_running {
            return "unsupported";
        }
        let linger = manager_until(
            "loginctl",
            &["show-user".into(), uid, "-p".into(), "Linger".into()],
            deadline,
            cancel,
            &[],
        )
        .is_ok_and(|text| linger_enabled(&text));
        if linger {
            "systemd+linger"
        } else {
            "systemd-no-linger"
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (deadline, cancel);
        "macos"
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (deadline, cancel);
        "unsupported"
    }
}

/// Launching steps need a user manager that outlives logins (linger); the
/// node on macOS only wraps services it can prove with `status`. On Linux every
/// other step runs its commands in the rank's slice, so it needs a user manager
/// that answers now.
pub fn activation_supported(action: JobPhase, mechanism: &str) -> bool {
    if matches!(
        action,
        JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin
    ) {
        return matches!(mechanism, "systemd+linger" | "macos");
    }
    !cfg!(target_os = "linux") || mechanism != "unsupported"
}

/// What a node without a reachable systemd user manager is told.
pub const USER_MANAGER_NEEDED: &str = "runtimes need the systemd user manager: enable lingering (`loginctl enable-linger`) or run wsmp as the installed wsmp.service";

/// How long a stop gives the rank's leftovers after SIGTERM before SIGKILL.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const SLICE_STOP_GRACE: Duration = Duration::from_secs(10);

/// `wsmp-runtime:<owner>:<unit without phase suffix>`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn description(owner: &str, unit: &str) -> String {
    let base = unit
        .strip_suffix("-prepare")
        .or_else(|| unit.strip_suffix("-after-join"))
        .unwrap_or(unit);
    format!("wsmp-runtime:{owner}:{base}")
}

/// From `systemctl show --property=LoadState,ActiveState,TasksCurrent,ControlGroup`: a
/// unit or slice that is gone, or whose control group is empty, runs nothing. `populated`
/// reads the control group's `cgroup.events` (cgroup v2): it counts every process of the
/// group and of every group below it (a slice's scopes and services). Without it, a unit whose
/// task count is not known counts as alive.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn unit_tasks_alive(output: &str, populated: impl FnOnce(&str) -> Option<bool>) -> bool {
    let fields = output
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect::<std::collections::BTreeMap<_, _>>();
    let group = fields.get("ControlGroup").copied().unwrap_or("");
    if fields.get("LoadState") == Some(&"not-found") || group.is_empty() {
        return false;
    }
    if let Some(populated) = populated(group) {
        return populated;
    }
    // An unknown task count with a control group proves nothing: count it as alive.
    fields
        .get("TasksCurrent")
        .and_then(|value| value.parse::<u64>().ok())
        .is_none_or(|tasks| tasks > 0)
}

/// Whether a control group (and every group below it) has a process, read from the cgroup
/// file system at `root` (`/sys/fs/cgroup`): cgroup v2 `cgroup.events` (`populated`), the
/// unified hierarchy of a hybrid host, else the v1 `systemd` hierarchy's `cgroup.procs`, walked.
/// `None` when it cannot be read (not a plain absolute path, the group not found there): the
/// caller then decides from systemd's own task count.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn cgroup_populated_at(root: &std::path::Path, group: &str) -> Option<bool> {
    let plain = group.starts_with('/')
        && group
            .split('/')
            .skip(1)
            .all(|part| !part.is_empty() && part != "." && part != "..");
    if !plain {
        return None;
    }
    let relative = &group[1..];
    for unified in [root.to_path_buf(), root.join("unified")] {
        if !unified.join("cgroup.controllers").exists() && !unified.join("cgroup.procs").exists() {
            continue;
        }
        if let Ok(events) = std::fs::read_to_string(unified.join(relative).join("cgroup.events")) {
            return events.lines().find_map(|line| match line.trim() {
                "populated 1" => Some(true),
                "populated 0" => Some(false),
                _ => None,
            });
        }
    }
    let legacy = root.join("systemd").join(relative);
    if legacy.is_dir() {
        return v1_has_process(&legacy, 0);
    }
    None
}

/// A v1 group or any group below it lists a process (`None`: unreadable or too deep).
fn v1_has_process(dir: &std::path::Path, depth: usize) -> Option<bool> {
    if depth > 32 {
        return None;
    }
    let procs = std::fs::read_to_string(dir.join("cgroup.procs")).ok()?;
    if procs.lines().any(|line| !line.trim().is_empty()) {
        return Some(true);
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        if entry.file_type().ok()?.is_dir() && v1_has_process(&entry.path(), depth + 1)? {
            return Some(true);
        }
    }
    Some(false)
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn cgroup_populated(group: &str) -> Option<bool> {
    cgroup_populated_at(std::path::Path::new("/sys/fs/cgroup"), group)
}

/// `/bin/sh -c script` with the rank's environment, inside a transient scope of the rank's
/// slice (Linux), so whatever it leaves behind (a fork, a `setsid` daemon) stays where the stop
/// proof looks. The exit status is the script's (`systemd-run --scope` runs it in place).
fn run_in_rank_slice(
    job: &Job,
    script: String,
    deadline: Deadline,
    limit: usize,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<u8>> {
    let env = command_env(job)?;
    #[cfg(target_os = "linux")]
    {
        let bus = format!("/run/user/{}/bus", nix::unistd::Uid::effective().as_raw());
        anyhow::ensure!(std::path::Path::new(&bus).exists(), USER_MANAGER_NEEDED);
        let args: Vec<String> = vec![
            format!(
                "XDG_RUNTIME_DIR=/run/user/{}",
                nix::unistd::Uid::effective().as_raw()
            ),
            "systemd-run".into(),
            "--user".into(),
            "--scope".into(),
            "--quiet".into(),
            "--collect".into(),
            format!("--slice={}", super::rank_slice(job)),
            "--".into(),
            "/bin/sh".into(),
            "-c".into(),
            script,
        ];
        crate::bounded_run::run_until_env("env", &args, deadline.instant(), limit, cancel, &env)
            .map_err(|_| anyhow::anyhow!("the command did not succeed"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        crate::bounded_run::run_until_env(
            "/bin/sh",
            &["-c".into(), script],
            deadline.instant(),
            limit,
            cancel,
            &env,
        )
        .map_err(|_| anyhow::anyhow!("the command did not succeed"))
    }
}

/// Nothing listens on `port`: binding it on every address (and on `host`) works. An address
/// this machine does not have (no IPv6, another node's fabric IP) says nothing about the
/// port; any other error (in use, out of descriptors, denied) is no proof that it is free.
pub fn port_free(host: &str, port: u16) -> bool {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener};
    let mut addresses = vec![
        IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        IpAddr::V6(Ipv6Addr::UNSPECIFIED),
    ];
    if let Ok(ip) = host.parse::<IpAddr>() {
        addresses.push(ip);
    }
    addresses
        .into_iter()
        .all(|ip| match TcpListener::bind(SocketAddr::new(ip, port)) {
            Ok(_) => true,
            Err(error) => address_missing(&error),
        })
}

fn address_missing(error: &std::io::Error) -> bool {
    if matches!(
        error.kind(),
        std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::Unsupported
    ) {
        return true;
    }
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(nix::libc::EAFNOSUPPORT)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

impl NativeRuntime {
    fn cancel_flag(&self) -> Option<&AtomicBool> {
        self.cancel.as_deref()
    }
}

impl Runtime for NativeRuntime {
    fn cancelled(&self) -> bool {
        self.cancel
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
            || crate::shutdown::requested().is_some()
    }

    fn launch(&self, job: &Job, owner: &str, unit: &str, deadline: Deadline) -> Result<String> {
        deadline.remaining()?;
        anyhow::ensure!(!self.cancelled(), "session disconnected");
        let env = command_env(job)?;
        #[cfg(target_os = "linux")]
        {
            let synchronous = matches!(job.action, JobPhase::Prepare | JobPhase::AfterJoin);
            let mut args: Vec<String> = vec![
                "--user".into(),
                "--quiet".into(),
                "--no-block".into(),
                format!("--unit={unit}"),
                "--collect".into(),
                "--property=RemainAfterExit=yes".into(),
                format!("--description={}", description(owner, unit)),
                "--property=StandardOutput=null".into(),
                "--property=StandardError=null".into(),
                "--property=KillMode=control-group".into(),
                "--property=Restart=no".into(),
                "--property=TasksAccounting=yes".into(),
                format!("--slice={}", super::rank_slice(job)),
                "--setenv=WSMP_JOB=1".into(),
            ];
            for (name, _) in &env {
                // The value comes from systemd-run's own environment.
                args.push(format!("--setenv={name}"));
            }
            if synchronous {
                args.push("--service-type=oneshot".into());
                args.push("--property=TimeoutStartFailureMode=kill".into());
                args.push(format!(
                    "--property=TimeoutStartSec={}ms",
                    deadline.remaining()?.as_millis().max(1)
                ));
            } else {
                args.push("--service-type=exec".into());
            }
            args.extend([
                "--".into(),
                "/bin/sh".into(),
                "-c".into(),
                job.command.clone(),
            ]);
            let outcome = (|| {
                manager_until("systemd-run", &args, deadline, self.cancel_flag(), &env)?;
                // A unit that is gone after it started failed (`--collect`
                // removes a failed one): fail now, not at the deadline.
                let mut gone_since: Option<std::time::Instant> = None;
                loop {
                    if let Some(identity) = self.launch_completed(job, owner, deadline)? {
                        return Ok(identity);
                    }
                    anyhow::ensure!(!self.cancelled(), "launch incomplete");
                    if self.identity(unit, owner, deadline)?.is_none() {
                        let since = *gone_since.get_or_insert_with(std::time::Instant::now);
                        if since.elapsed() >= Duration::from_secs(5) {
                            return Err(super::fail(
                                crate::protocol::frames::JobError::CommandFailed,
                            ))
                            .context("the command exited without success");
                        }
                    } else {
                        gone_since = None;
                    }
                    deadline.sleep(Duration::from_millis(200))?;
                }
            })();
            if outcome.is_err() && self.cancelled() && deadline.remaining().is_ok() {
                // Clean up within the original budget; a cancellation must not
                // suppress its own cleanup.
                let cleanup = NativeRuntime { cancel: None };
                if cleanup
                    .identity(unit, owner, deadline)
                    .is_ok_and(|seen| seen.is_some())
                {
                    let _ = manager_until(
                        "systemctl",
                        &[
                            "--user".into(),
                            "kill".into(),
                            "--kill-whom=all".into(),
                            "--signal=KILL".into(),
                            unit.into(),
                        ],
                        deadline,
                        None,
                        &[],
                    );
                }
            }
            outcome
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (owner, unit, env);
            anyhow::ensure!(
                job.status_command.is_some(),
                "this platform needs a status command"
            );
            anyhow::ensure!(
                job.management() == Management::Service,
                "this platform runs services only"
            );
            self.shell_until(job, &job.command, deadline)?;
            Ok("self-detached".into())
        }
    }

    fn identity(&self, unit: &str, owner: &str, deadline: Deadline) -> Result<Option<String>> {
        deadline.remaining()?;
        anyhow::ensure!(!self.cancelled(), "session disconnected");
        #[cfg(target_os = "linux")]
        {
            let output = manager_until(
                "systemctl",
                &[
                    "--user".into(),
                    "show".into(),
                    unit.into(),
                    "--property=LoadState,ActiveState,Description,InvocationID,TasksCurrent,ControlGroup".into(),
                ],
                deadline,
                self.cancel_flag(),
                &[],
            )?;
            let fields = output
                .lines()
                .filter_map(|line| line.split_once('='))
                .collect::<BTreeMap<_, _>>();
            if fields.get("LoadState") == Some(&"not-found")
                || (fields
                    .get("ActiveState")
                    .is_some_and(|s| matches!(*s, "inactive" | "failed"))
                    && (fields.get("TasksCurrent") == Some(&"0")
                        || fields.get("ControlGroup") == Some(&"")))
            {
                return Ok(None);
            }
            let expected = description(owner, unit);
            anyhow::ensure!(
                fields.get("Description") == Some(&expected.as_str()),
                "the unit belongs to someone else"
            );
            let invocation = fields
                .get("InvocationID")
                .filter(|v| v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit()))
                .context("the unit has no invocation id")?;
            Ok(Some((*invocation).to_string()))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (unit, owner);
            Ok(None)
        }
    }

    fn launch_completed(
        &self,
        job: &Job,
        owner: &str,
        deadline: Deadline,
    ) -> Result<Option<String>> {
        deadline.remaining()?;
        #[cfg(not(target_os = "linux"))]
        {
            let _ = owner;
            let status = job.status_command.as_deref().context("status required")?;
            Ok(self
                .status_until(job, status, deadline)?
                .then(|| "self-detached".into()))
        }
        #[cfg(target_os = "linux")]
        {
            let unit = super::phase_unit(job);
            let identity = self.identity(&unit, owner, deadline)?;
            if identity.is_none() {
                return Ok(None);
            }
            if matches!(job.action, JobPhase::Prepare | JobPhase::AfterJoin) {
                let output = manager_until(
                    "systemctl",
                    &[
                        "--user".into(),
                        "show".into(),
                        unit,
                        "--property=SubState,ExecMainStatus".into(),
                    ],
                    deadline,
                    self.cancel_flag(),
                    &[],
                )?;
                let fields = output
                    .lines()
                    .filter_map(|line| line.split_once('='))
                    .collect::<BTreeMap<_, _>>();
                if fields.get("SubState") != Some(&"exited")
                    || fields.get("ExecMainStatus") != Some(&"0")
                {
                    return Ok(None);
                }
            } else if job.management() == Management::Process {
                let output = manager_until(
                    "systemctl",
                    &[
                        "--user".into(),
                        "show".into(),
                        unit,
                        "--property=TasksCurrent".into(),
                    ],
                    deadline,
                    self.cancel_flag(),
                    &[],
                )?;
                if !output
                    .trim()
                    .strip_prefix("TasksCurrent=")
                    .and_then(|v| v.parse::<u64>().ok())
                    .is_some_and(|tasks| tasks > 0)
                {
                    return Ok(None);
                }
            } else {
                let status = job
                    .status_command
                    .as_deref()
                    .context("a service needs a status command")?;
                if !self.status_until(job, status, deadline)? {
                    return Ok(None);
                }
            }
            Ok(identity)
        }
    }

    fn shell_until(&self, job: &Job, command: &str, deadline: Deadline) -> Result<()> {
        deadline.remaining()?;
        anyhow::ensure!(!self.cancelled(), "session disconnected");
        // Output goes nowhere: no backend output reaches a pipe or a log.
        run_in_rank_slice(
            job,
            format!("exec >/dev/null 2>&1; {command}"),
            deadline,
            0,
            self.cancel_flag(),
        )?;
        Ok(())
    }

    fn status_until(&self, job: &Job, command: &str, deadline: Deadline) -> Result<bool> {
        deadline.remaining()?;
        anyhow::ensure!(!self.cancelled(), "session disconnected");
        let script = format!(
            "( {command}\n) >/dev/null 2>&1; rc=$?; if [ \"$rc\" -eq 0 ]; then printf alive; elif [ \"$rc\" -eq 3 ]; then printf stopped; else printf unknown; fi"
        );
        let output = run_in_rank_slice(job, script, deadline, 16, self.cancel_flag())
            .map_err(|_| anyhow::anyhow!("status unconfirmed"))?;
        match output.as_slice() {
            b"alive" => Ok(true),
            b"stopped" => Ok(false),
            _ => anyhow::bail!("status unconfirmed"),
        }
    }

    fn stop(&self, unit: &str, owner: &str, invocation: &str, deadline: Deadline) -> Result<()> {
        deadline.remaining()?;
        #[cfg(target_os = "linux")]
        {
            if let Some(current) = self.identity(unit, owner, deadline)? {
                anyhow::ensure!(current == invocation, "the unit was relaunched");
                manager_until(
                    "systemctl",
                    &["--user".into(), "stop".into(), unit.into()],
                    deadline,
                    self.cancel_flag(),
                    &[],
                )?;
            }
            anyhow::ensure!(
                self.identity(unit, owner, deadline)?.is_none(),
                "the unit is still alive"
            );
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (unit, owner, invocation);
        }
        Ok(())
    }

    fn tasks_alive(&self, unit: &str, deadline: Deadline) -> Result<bool> {
        deadline.remaining()?;
        anyhow::ensure!(!self.cancelled(), "session disconnected");
        #[cfg(target_os = "linux")]
        {
            let output = manager_until(
                "systemctl",
                &[
                    "--user".into(),
                    "show".into(),
                    unit.into(),
                    "--property=LoadState,ActiveState,TasksCurrent,ControlGroup".into(),
                ],
                deadline,
                self.cancel_flag(),
                &[],
            )?;
            Ok(unit_tasks_alive(&output, cgroup_populated))
        }
        #[cfg(not(target_os = "linux"))]
        {
            // No units here: a service is proven by its status command.
            let _ = unit;
            Ok(false)
        }
    }

    fn port_free(&self, host: &str, port: u16) -> bool {
        port_free(host, port)
    }

    fn stop_slice(&self, slice: &str, deadline: Deadline) -> Result<()> {
        #[cfg(target_os = "linux")]
        {
            let signal = |name: &str| {
                manager_until(
                    "systemctl",
                    &[
                        "--user".into(),
                        "kill".into(),
                        format!("--signal={name}"),
                        slice.into(),
                    ],
                    deadline,
                    None,
                    &[],
                )
                .map(|_| ())
            };
            // Wait until the slice is empty, at most `wait` (and within the step's deadline).
            let empty_within = |wait: Duration| -> Result<bool> {
                let until = std::time::Instant::now() + wait;
                loop {
                    if !self.tasks_alive(slice, deadline)? {
                        return Ok(true);
                    }
                    if std::time::Instant::now() >= until || deadline.remaining().is_err() {
                        return Ok(false);
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            };
            if !self.tasks_alive(slice, deadline)? {
                return Ok(());
            }
            signal("SIGTERM")?;
            let grace = SLICE_STOP_GRACE.min(deadline.remaining()? / 2);
            if empty_within(grace)? {
                return Ok(());
            }
            signal("SIGKILL")?;
            anyhow::ensure!(
                empty_within(Duration::from_secs(5))?,
                "a process of the rank's slice survived SIGKILL"
            );
            Ok(())
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (slice, deadline);
            Ok(())
        }
    }

    fn forget_slice(&self, slice: &str, deadline: Deadline) {
        // Proven empty just before: stopping it ends nothing, it only unloads the slice.
        #[cfg(target_os = "linux")]
        let _ = manager_until(
            "systemctl",
            &["--user".into(), "stop".into(), slice.into()],
            deadline.cap(Duration::from_secs(10)),
            None,
            &[],
        );
        #[cfg(not(target_os = "linux"))]
        let _ = (slice, deadline);
    }

    fn healthy_until(&self, job: &Job, deadline: Deadline) -> bool {
        if self.cancelled() {
            return false;
        }
        let Some(readiness) = job.readiness() else {
            return false;
        };
        let Ok(timeout) = deadline.remaining() else {
            return false;
        };
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            .max_redirects(0)
            .build()
            .new_agent();
        agent
            .get(format!("{}{}", job.base_url(), readiness.path))
            .call()
            .is_ok_and(|response| response.status().as_u16() == readiness.expected_status)
            && !self.cancelled()
            && deadline.remaining().is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_unit_with_no_task_runs_nothing() {
        let unit_tasks_alive = |output: &str| unit_tasks_alive(output, |_| None);
        assert!(!unit_tasks_alive(
            "LoadState=not-found\nActiveState=inactive\n"
        ));
        // RemainAfterExit: the unit stays active after its process exited.
        assert!(!unit_tasks_alive(
            "LoadState=loaded\nActiveState=active\nTasksCurrent=0\nControlGroup=/x\n"
        ));
        assert!(!unit_tasks_alive(
            "LoadState=loaded\nActiveState=active\nTasksCurrent=[not set]\nControlGroup=\n"
        ));
        assert!(unit_tasks_alive(
            "LoadState=loaded\nActiveState=active\nTasksCurrent=3\nControlGroup=/x\n"
        ));
        assert!(unit_tasks_alive(
            "LoadState=loaded\nActiveState=active\nTasksCurrent=[not set]\nControlGroup=/x\n"
        ));
        assert!(unit_tasks_alive(
            "LoadState=loaded\nActiveState=failed\nTasksCurrent=[not set]\nControlGroup=/x\n"
        ));
    }

    #[test]
    fn cgroup_populated_reads_v2_hybrid_and_v1_hierarchies() {
        let write = |path: std::path::PathBuf, text: &str| {
            std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
            std::fs::write(path, text).expect("write");
        };
        // cgroup v2.
        let v2 = tempfile::tempdir().expect("v2");
        write(v2.path().join("cgroup.controllers"), "pids");
        write(
            v2.path().join("a/s.slice/cgroup.events"),
            "populated 1\nfrozen 0\n",
        );
        write(
            v2.path().join("a/e.slice/cgroup.events"),
            "populated 0\nfrozen 0\n",
        );
        assert_eq!(cgroup_populated_at(v2.path(), "/a/s.slice"), Some(true));
        assert_eq!(cgroup_populated_at(v2.path(), "/a/e.slice"), Some(false));
        // A group systemd names but the file system does not have: not known.
        assert_eq!(cgroup_populated_at(v2.path(), "/a/gone.slice"), None);
        assert_eq!(cgroup_populated_at(v2.path(), "/a/../etc"), None);
        assert_eq!(cgroup_populated_at(v2.path(), "relative"), None);
        // Hybrid: the unified hierarchy under `unified/`.
        let hybrid = tempfile::tempdir().expect("hybrid");
        write(hybrid.path().join("unified/cgroup.procs"), "");
        write(
            hybrid.path().join("unified/a/s.slice/cgroup.events"),
            "populated 1\n",
        );
        assert_eq!(cgroup_populated_at(hybrid.path(), "/a/s.slice"), Some(true));
        // v1: the `systemd` hierarchy, walked below the group.
        let v1 = tempfile::tempdir().expect("v1");
        write(v1.path().join("systemd/a/s.slice/cgroup.procs"), "");
        write(
            v1.path().join("systemd/a/s.slice/run-1.scope/cgroup.procs"),
            "4242\n",
        );
        write(v1.path().join("systemd/a/e.slice/cgroup.procs"), "");
        write(
            v1.path().join("systemd/a/e.slice/run-2.scope/cgroup.procs"),
            "",
        );
        assert_eq!(cgroup_populated_at(v1.path(), "/a/s.slice"), Some(true));
        assert_eq!(cgroup_populated_at(v1.path(), "/a/e.slice"), Some(false));
        assert_eq!(cgroup_populated_at(v1.path(), "/a/gone.slice"), None);
    }

    #[test]
    fn a_listening_port_is_not_free() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        assert!(!port_free("127.0.0.1", port));
        drop(listener);
        assert!(port_free("127.0.0.1", port));
    }

    #[test]
    fn manager_states_and_linger_parse() {
        assert!(user_manager_live("degraded\n"));
        assert!(!user_manager_live("offline"));
        assert!(linger_enabled("Linger=yes\n"));
        assert!(!linger_enabled("Linger=no"));
        // Every step runs its commands in the rank's slice on Linux: a manager must answer.
        assert_eq!(
            activation_supported(JobPhase::Stop, "unsupported"),
            !cfg!(target_os = "linux")
        );
        assert!(activation_supported(JobPhase::Stop, "systemd-no-linger"));
        assert!(!activation_supported(JobPhase::Start, "systemd-no-linger"));
        assert!(activation_supported(JobPhase::Start, "systemd+linger"));
    }

    /// Real systemd user units: start a tiny HTTP server, wait for
    /// readiness, stop it. Needs a running user manager (`--ignored`).
    #[test]
    #[ignore = "needs a systemd user manager"]
    fn a_real_unit_starts_serves_and_stops() {
        use crate::protocol::frames::{InstancePhase, JobStatus};
        let root = tempfile::tempdir().expect("root");
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .expect("port")
            .port();
        let start = format!("exec python3 -m http.server {port} --bind 127.0.0.1");
        let job = |action: JobPhase, step: &str| super::super::Job {
            step_id: step.into(),
            instance_id: "itest".into(),
            runtime_id: "rt".into(),
            version_id: "vr".into(),
            launch_hash: "h".repeat(64),
            rank: 0,
            action,
            intent_hash: "a".repeat(64),
            owner_epoch: "e".into(),
            command: if action == JobPhase::Start {
                start.clone()
            } else {
                String::new()
            },
            stop_command: "true".into(),
            status_command: None,
            health_command: None,
            secrets: Vec::new(),
            timeout_ms: 20_000,
            unit_name: "wsmp-i-itestitestabc-r0".into(),
            handle: "i-itestitestabc".into(),
            port,
            gpu_ids: None,
            dist_port: None,
            host: "127.0.0.1".into(),
            spec: serde_json::json!({
                "api": "openai", "engine": "other", "modelType": "llm",
                "models": [{ "id": "m" }],
                "launch": {
                    "management": "process", "groupSize": 1,
                    "resources": [{ "kind": "none" }], "labels": [],
                    "commands": [{ "start": "x", "stop": "true" }],
                    "readiness": { "path": "/", "expectedStatus": 200, "timeoutMs": 20000 },
                    "health": { "intervalMs": 30000, "failureThreshold": 3, "successThreshold": 1 }
                }
            }),
        };
        let runtime = NativeRuntime { cancel: None };
        let mut executor = super::super::Executor::load(root.path().join("x.json")).expect("load");
        let deadline = || Deadline::new(std::time::Duration::from_secs(20));
        assert_eq!(
            executor
                .execute(job(JobPhase::Start, "s1"), &runtime, deadline())
                .status,
            JobStatus::Succeeded
        );
        assert_eq!(
            executor
                .execute(job(JobPhase::Readiness, "s2"), &runtime, deadline())
                .status,
            JobStatus::Succeeded
        );
        assert_eq!(
            executor.observations(&runtime, deadline())[0].1.phase,
            InstancePhase::Ready
        );
        let stopped = executor.execute(job(JobPhase::Stop, "s3"), &runtime, deadline());
        assert!(stopped.stopped, "{stopped:?}");
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
    }

    /// Real systemd user units (`--ignored`): a stop ends what its command left in the rank's
    /// slice (a `setsid` daemon ignoring SIGTERM: SIGKILL after the grace) and is then proven;
    /// a probe kills nothing; the dist port counts; a re-delivered stop and the inventory check
    /// the port again.
    #[test]
    #[ignore = "needs a systemd user manager"]
    fn a_real_stop_is_proven_only_with_an_empty_slice_and_free_ports() {
        use crate::protocol::frames::{InstancePhase, JobStatus};
        let free_port = || {
            std::net::TcpListener::bind("127.0.0.1:0")
                .and_then(|l| l.local_addr())
                .expect("port")
                .port()
        };
        let (port, dist) = (free_port(), free_port());
        let root = tempfile::tempdir().expect("root");
        let start = format!("exec python3 -m http.server {port} --bind 127.0.0.1");
        let unit = "wsmp-i-proofproofabc-r0";
        let job = |action: JobPhase, step: &str, stop: &str| super::super::Job {
            step_id: step.into(),
            instance_id: "proof".into(),
            runtime_id: "rt".into(),
            version_id: "vr".into(),
            launch_hash: "h".repeat(64),
            rank: 0,
            action,
            intent_hash: "a".repeat(64),
            owner_epoch: "e".into(),
            command: if action == JobPhase::Start {
                start.clone()
            } else {
                String::new()
            },
            stop_command: stop.into(),
            status_command: Some("true".into()),
            health_command: Some("true".into()),
            secrets: Vec::new(),
            timeout_ms: 20_000,
            unit_name: unit.into(),
            handle: "i-proofproofabc".into(),
            port,
            dist_port: Some(dist),
            gpu_ids: None,
            host: "127.0.0.1".into(),
            spec: serde_json::json!({
                "api": "openai", "engine": "other", "modelType": "llm",
                "models": [{ "id": "m" }],
                "launch": {
                    "management": "process", "groupSize": 1,
                    "resources": [{ "kind": "none" }], "labels": [],
                    "commands": [{ "start": "x", "stop": "true", "status": "true" }],
                    "health": { "intervalMs": 30000, "failureThreshold": 3, "successThreshold": 1 }
                }
            }),
        };
        let runtime = NativeRuntime { cancel: None };
        let mut executor = super::super::Executor::load(root.path().join("x.json")).expect("load");
        let deadline = |secs| Deadline::new(std::time::Duration::from_secs(secs));
        // A rank launched by an older CLI has no slice: an absent slice holds nothing.
        assert!(
            !runtime
                .tasks_alive("wsmp_i_neverneverab_r0.slice", deadline(10))
                .expect("manager")
        );
        // The stop command leaves a `setsid` daemon behind while the marker exists.
        // The stop command leaves a `setsid` daemon behind that ignores SIGTERM.
        // (`sleep 1`: the daemon has left the command's process group before the command ends.)
        let daemon =
            "setsid sh -c \"trap '' TERM; exec sleep 121\" </dev/null >/dev/null 2>&1 & sleep 1";
        let slice = format!("{}.slice", unit.replace('-', "_"));
        let slice_alive = || runtime.tasks_alive(&slice, deadline(10)).expect("manager");
        assert_eq!(
            executor
                .execute(job(JobPhase::Start, "s1", daemon), &runtime, deadline(20))
                .status,
            JobStatus::Succeeded
        );
        // The stop ends the slice (SIGTERM, then SIGKILL after the grace), then proves it.
        let started = std::time::Instant::now();
        let stop = executor.execute(job(JobPhase::Stop, "s2", daemon), &runtime, deadline(30));
        assert!(stop.stopped, "{stop:?}");
        assert!(!slice_alive());
        assert!(
            started.elapsed() >= SLICE_STOP_GRACE,
            "the daemon ignored SIGTERM: only SIGKILL after the grace ended it"
        );
        let left = std::process::Command::new("pgrep")
            .args(["-f", "^sleep 121$"])
            .status()
            .expect("pgrep");
        assert!(!left.success(), "the stop command's daemon is gone");
        assert_eq!(
            executor.observations(&runtime, deadline(10))[0].1.phase,
            InstancePhase::Stopped
        );
        // Something of the rank runs in its slice again: a status probe says so and kills nothing.
        let planted = std::process::Command::new("systemd-run")
            .args(["--user", "--scope", "--quiet", "--collect"])
            .arg(format!("--slice={slice}"))
            .args([
                "--",
                "/bin/sh",
                "-c",
                "setsid sleep 120 </dev/null >/dev/null 2>&1 &",
            ])
            .status()
            .expect("systemd-run");
        assert!(planted.success());
        let probe = executor.execute(job(JobPhase::Status, "s3", daemon), &runtime, deadline(10));
        assert_eq!(probe.detail.as_deref(), Some("process_alive"), "{probe:?}");
        assert!(slice_alive(), "a probe never kills anything");
        let _ = std::process::Command::new("systemctl")
            .args(["--user", "stop", &slice])
            .status();
        // The dist port is held: not proven.
        let held = std::net::TcpListener::bind(("127.0.0.1", dist)).expect("dist");
        let probe = executor.execute(job(JobPhase::Status, "s4", daemon), &runtime, deadline(10));
        assert_eq!(probe.detail.as_deref(), Some("port_in_use"), "{probe:?}");
        drop(held);
        // The port is taken again: neither the re-delivered stop nor the inventory says stopped.
        let taken = std::net::TcpListener::bind(("127.0.0.1", port)).expect("port");
        let again = executor.execute(job(JobPhase::Stop, "s2", daemon), &runtime, deadline(10));
        assert_eq!(
            (again.stopped, again.detail.as_deref()),
            (false, Some("port_in_use"))
        );
        assert_eq!(
            executor.observations(&runtime, deadline(10))[0].1.phase,
            InstancePhase::Unknown
        );
        drop(taken);
    }

    #[test]
    fn unit_descriptions_name_the_owner_and_the_rank_unit() {
        assert_eq!(
            description("o", "wsmp-i-abcdefabcdef-r0-prepare"),
            "wsmp-runtime:o:wsmp-i-abcdefabcdef-r0"
        );
    }
}
