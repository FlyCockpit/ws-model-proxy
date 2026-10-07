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
/// node on macOS only wraps services it can prove with `status`.
pub fn activation_supported(action: JobPhase, mechanism: &str) -> bool {
    !matches!(
        action,
        JobPhase::Prepare | JobPhase::Start | JobPhase::AfterJoin
    ) || matches!(mechanism, "systemd+linger" | "macos")
}

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
/// unit that is gone, or whose control group is empty, runs nothing. A unit whose task count
/// is not known counts as alive.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn unit_tasks_alive(output: &str) -> bool {
    let fields = output
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect::<std::collections::BTreeMap<_, _>>();
    if fields.get("LoadState") == Some(&"not-found") || fields.get("ControlGroup") == Some(&"") {
        return false;
    }
    // An unknown task count with a control group proves nothing: count it as alive.
    fields
        .get("TasksCurrent")
        .and_then(|value| value.parse::<u64>().ok())
        .is_none_or(|tasks| tasks > 0)
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
        let env = command_env(job)?;
        // Output goes nowhere: no backend output reaches a pipe or a log.
        crate::bounded_run::run_until_env(
            "/bin/sh",
            &["-c".into(), format!("exec >/dev/null 2>&1; {command}")],
            deadline.instant(),
            0,
            self.cancel_flag(),
            &env,
        )
        .map_err(|_| anyhow::anyhow!("the command did not succeed"))?;
        Ok(())
    }

    fn status_until(&self, job: &Job, command: &str, deadline: Deadline) -> Result<bool> {
        deadline.remaining()?;
        anyhow::ensure!(!self.cancelled(), "session disconnected");
        let env = command_env(job)?;
        let script = format!(
            "( {command}\n) >/dev/null 2>&1; rc=$?; if [ \"$rc\" -eq 0 ]; then printf alive; elif [ \"$rc\" -eq 3 ]; then printf stopped; else printf unknown; fi"
        );
        let output = crate::bounded_run::run_until_env(
            "/bin/sh",
            &["-c".into(), script],
            deadline.instant(),
            16,
            self.cancel_flag(),
            &env,
        )
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
            Ok(unit_tasks_alive(&output))
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
        assert!(activation_supported(JobPhase::Stop, "unsupported"));
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

    #[test]
    fn unit_descriptions_name_the_owner_and_the_rank_unit() {
        assert_eq!(
            description("o", "wsmp-i-abcdefabcdef-r0-prepare"),
            "wsmp-runtime:o:wsmp-i-abcdefabcdef-r0"
        );
    }
}
