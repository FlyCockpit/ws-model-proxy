//! launchd: the `launchctl` calls that load and restart the relay's
//! LaunchAgent, each one bounded, and the waits between them.

#[cfg(target_os = "macos")]
use std::path::Path;
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

use anyhow::{Context, Result};

#[cfg(target_os = "macos")]
use super::MACOS_LABEL;
use super::Restart;

/// The `launchctl` calls [`restart_launch_agent`] makes, and its clock:
/// [`SystemLaunchctl`] on macOS, a fake in tests.
#[cfg(any(target_os = "macos", test))]
pub(crate) trait Launchctl {
    /// `launchctl args`, stopped after `timeout`: how it ended (exit code and
    /// output) when it ran to its end, whatever its status. An error when it
    /// could not start, ran out of time or was stopped (too many commands,
    /// wsmp exiting): then nothing is known of what launchd would have said.
    fn run(
        &mut self,
        args: &[&str],
        timeout: std::time::Duration,
    ) -> Result<crate::process::bounded_run::management::Exited>;
    fn now(&self) -> std::time::Instant;
    fn sleep(&mut self, pause: std::time::Duration);
}

#[cfg(target_os = "macos")]
pub(crate) struct SystemLaunchctl;

#[cfg(target_os = "macos")]
impl Launchctl for SystemLaunchctl {
    fn run(
        &mut self,
        args: &[&str],
        timeout: std::time::Duration,
    ) -> Result<crate::process::bounded_run::management::Exited> {
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
        crate::process::bounded_run::management::run_bounded_status(
            "launchctl",
            &args,
            &[],
            timeout,
        )
    }
    fn now(&self) -> std::time::Instant {
        std::time::Instant::now()
    }
    fn sleep(&mut self, pause: std::time::Duration) {
        std::thread::sleep(pause);
    }
}

/// The first wait between two looks at launchd (an unload to finish, a
/// bootstrap to try again, a look that failed); each next one doubles, up to
/// [`LAUNCHD_POLL_MAX`].
#[cfg(any(target_os = "macos", test))]
const LAUNCHD_POLL_FIRST: std::time::Duration = std::time::Duration::from_millis(100);
#[cfg(any(target_os = "macos", test))]
const LAUNCHD_POLL_MAX: std::time::Duration = std::time::Duration::from_secs(1);

/// `launchctl print <domain>/<label>`'s exit status for a service launchd
/// does not have ("Bad request. Could not find service … in domain"), as
/// seen on a Mac. Every other failure of `print` says nothing about it.
#[cfg(any(target_os = "macos", test))]
const LAUNCHCTL_NOT_LOADED: i32 = 113;

/// What a person runs when the relay's LaunchAgent is left unloaded by a
/// restart.
#[cfg(any(target_os = "macos", test))]
const LAUNCHD_RECOVERY: &str = "run `wsmp service install` to load the relay service again (`wsmp update` does not reload it when wsmp is already current)";

/// Who asks [`restart_launch_agent`], which decides the way back an error
/// names and whether `kickstart` must succeed.
#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum LaunchAgentCaller {
    /// [`restart_quietly`](super::restart_quietly): its errors point at `wsmp service install`.
    Restart(Restart),
    /// `wsmp service install` itself: load the plist it just wrote (a
    /// reload: `bootout` first when loaded). Its errors cannot point at
    /// itself as something new to run, so they say to run it again or load
    /// the plist by hand; `kickstart` stays best effort, as before (the
    /// plist has `RunAtLoad`).
    Install,
}

/// What `launchctl print` showed of the agent.
#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Agent {
    /// Exit 0: launchd has it.
    Loaded,
    /// Exit [`LAUNCHCTL_NOT_LOADED`]: launchd does not have it.
    Absent,
}

/// Where a [`restart_launch_agent`] stands.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchdPhase {
    /// launchd has the agent and was not seen without it during this
    /// restart: it may run a definition older than the file.
    Loaded,
    /// launchd said it does not have the agent: whatever it has after this
    /// was loaded from the file as it is now. `bootstrap` runs only here.
    SeenAbsent,
}

/// One try of a polled `launchctl` step.
#[cfg(any(target_os = "macos", test))]
enum Polled<T> {
    Done(T),
    /// No answer yet, and why (the error if time runs out).
    Again(anyhow::Error),
}

/// Tries `attempt` until it is done, pausing [`LAUNCHD_POLL_FIRST`] between
/// tries and doubling that up to [`LAUNCHD_POLL_MAX`]. Once no more than the
/// next pause is left before `deadline`, `timed_out` turns the last try's
/// error into the answer. An `Err` from `attempt` ends the poll at once.
#[cfg(any(target_os = "macos", test))]
fn poll_launchd<T>(
    launchctl: &mut dyn Launchctl,
    deadline: std::time::Instant,
    mut attempt: impl FnMut(&mut dyn Launchctl) -> Result<Polled<T>>,
    timed_out: impl FnOnce(anyhow::Error) -> anyhow::Error,
) -> Result<T> {
    let mut pause = LAUNCHD_POLL_FIRST;
    loop {
        let error = match attempt(launchctl)? {
            Polled::Done(value) => return Ok(value),
            Polled::Again(error) => error,
        };
        if deadline.saturating_duration_since(launchctl.now()) <= pause {
            return Err(timed_out(error));
        }
        launchctl.sleep(pause);
        pause = (pause * 2).min(LAUNCHD_POLL_MAX);
    }
}

/// `Ok` for a `launchctl` call that exited 0; its output otherwise.
#[cfg(any(target_os = "macos", test))]
fn launchctl_ok(args: &[&str], ran: crate::process::bounded_run::management::Exited) -> Result<()> {
    if ran.code == Some(0) {
        return Ok(());
    }
    Err(launchctl_failed(args, &ran))
}

/// The error for a `launchctl` call that exited `ran.code`, with its output.
#[cfg(any(target_os = "macos", test))]
fn launchctl_failed(
    args: &[&str],
    ran: &crate::process::bounded_run::management::Exited,
) -> anyhow::Error {
    let status = ran
        .code
        .map_or_else(|| "a signal".to_string(), |code| format!("exit {code}"));
    anyhow::anyhow!(
        "`launchctl {}` failed ({status}): {}{}",
        args.join(" "),
        ran.stdout.trim(),
        ran.stderr.trim()
    )
}

/// macOS [`restart_quietly`](super::restart_quietly): restart the LaunchAgent `agent`
/// (`<domain>/<label>`, loaded from `file`), every `launchctl` call within
/// one `deadline`.
///
/// Each look at launchd (`print`) is loaded (exit 0), not loaded (exit
/// [`LAUNCHCTL_NOT_LOADED`]), or no answer (any other end: it could not run,
/// ran out of time, another status). No answer is never taken as not
/// loaded: it is asked again until the deadline, then an error.
///
/// - `Restart::Reloaded`: when loaded, `bootout`, then wait until launchd
///   says it no longer has it: `bootout` returns before launchd has finished
///   unloading, and a `bootstrap` meanwhile fails (commonly "Bootstrap
///   failed: 5: Input/output error"). A `bootout` that fails while the agent
///   is still loaded is an error (the relay keeps running what launchd
///   loaded).
/// - Then (always for `Reloaded`, and for `Loaded` when the agent is not
///   loaded: `kickstart` fails on that, exit 113) `bootstrap`, tried again
///   until the deadline while it fails and the agent is not loaded. A
///   `bootstrap` that fails while launchd says the agent is loaded is
///   taken as loaded only after launchd said it was not loaded (so what it
///   has was loaded since, from the file as it is now), which every path
///   here establishes before it runs `bootstrap`.
/// - Then `kickstart -k`.
///
/// Every error names the way back ([`LAUNCHD_RECOVERY`]; for `Install`: run
/// it again, or `launchctl bootstrap` by hand), so the relay is never left
/// unloaded in silence. `Install` is `Reloaded`: its first install (nothing
/// loaded) is `bootstrap`, then `kickstart`, as before.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn restart_launch_agent(
    launchctl: &mut dyn Launchctl,
    caller: LaunchAgentCaller,
    domain: &str,
    agent: &str,
    file: &str,
    deadline: std::time::Instant,
) -> Result<()> {
    let (how, recovery) = match caller {
        LaunchAgentCaller::Restart(how) => (how, LAUNCHD_RECOVERY.to_string()),
        LaunchAgentCaller::Install => (
            Restart::Reloaded,
            format!(
                "run `wsmp service install` again, or load it by hand: `launchctl bootstrap {domain} '{}'`",
                super::text::shell_single_quote(file)
            ),
        ),
    };
    let left = |launchctl: &dyn Launchctl| deadline.saturating_duration_since(launchctl.now());
    // Whether launchd has the agent, asked again (with the same backoff)
    // while `print` gives no answer; an error when none came by the deadline.
    let look = |launchctl: &mut dyn Launchctl| -> Result<Agent> {
        poll_launchd(
            launchctl,
            deadline,
            |launchctl| {
                let time = left(launchctl);
                if time.is_zero() {
                    return Ok(Polled::Again(anyhow::anyhow!(
                        "no time was left to run `launchctl print {agent}`"
                    )));
                }
                Ok(match launchctl.run(&["print", agent], time) {
                    Ok(ran) => match ran.code {
                        Some(0) => Polled::Done(Agent::Loaded),
                        Some(LAUNCHCTL_NOT_LOADED) => Polled::Done(Agent::Absent),
                        _ => Polled::Again(launchctl_failed(&["print", agent], &ran)),
                    },
                    Err(error) => Polled::Again(error),
                })
            },
            |error| {
                error.context(format!(
                    "launchd did not say whether it has the relay service `{agent}` loaded; {recovery}"
                ))
            },
        )
    };
    let mut phase = match look(launchctl)? {
        Agent::Loaded => LaunchdPhase::Loaded,
        Agent::Absent => LaunchdPhase::SeenAbsent,
    };
    if how == Restart::Reloaded && phase == LaunchdPhase::Loaded {
        // launchd runs the plist it loaded, never the file as it is now:
        // `bootout` and `bootstrap` make it read the file again.
        let bootout = launchctl
            .run(&["bootout", agent], left(launchctl))
            .and_then(|ran| launchctl_ok(&["bootout", agent], ran));
        if let Err(error) = bootout {
            // One that went away meanwhile is what was asked for.
            if look(launchctl)? == Agent::Loaded {
                return Err(error.context(format!(
                    "unloading the relay service `{agent}`: it still runs the definition launchd loaded; {recovery}"
                )));
            }
        } else {
            poll_launchd(
                launchctl,
                deadline,
                |launchctl| {
                    Ok(match look(launchctl)? {
                        Agent::Absent => Polled::Done(()),
                        Agent::Loaded => Polled::Again(anyhow::anyhow!("still loaded")),
                    })
                },
                |_| {
                    anyhow::anyhow!(
                        "launchd was still unloading the relay service `{agent}` when the restart ran out of time; {recovery}"
                    )
                },
            )?;
        }
        phase = LaunchdPhase::SeenAbsent;
    }
    // From here on a `Reloaded` restart is always `SeenAbsent`. An installed
    // agent that is not loaded (booted out) is loaded first: `kickstart`
    // fails on it (exit 113), where systemd and Task Scheduler start a
    // stopped service.
    if phase == LaunchdPhase::SeenAbsent {
        poll_launchd(
            launchctl,
            deadline,
            |launchctl| {
                let time = left(launchctl);
                let error = if time.is_zero() {
                    anyhow::anyhow!("no time was left to run `launchctl bootstrap`")
                } else {
                    let args = ["bootstrap", domain, file];
                    match launchctl
                        .run(&args, time)
                        .and_then(|ran| launchctl_ok(&args, ran))
                    {
                        Ok(()) => return Ok(Polled::Done(())),
                        Err(error) => error,
                    }
                };
                // Loaded after all (launchd can report an error for a load it
                // made, or another `bootstrap` won): since launchd said it did
                // not have the agent, this is the file as it is now. Restart it
                // below.
                if look(launchctl)? == Agent::Loaded {
                    return Ok(Polled::Done(()));
                }
                Ok(Polled::Again(error))
            },
            |error| {
                error.context(format!(
                    "launchd did not load the relay service `{file}`, so the relay is not running; {recovery}"
                ))
            },
        )?;
    }
    let time = left(launchctl);
    anyhow::ensure!(
        !time.is_zero(),
        "the relay service `{agent}` was loaded but no time was left to restart it; {recovery}"
    );
    let args = ["kickstart", "-k", agent];
    let kicked = launchctl
        .run(&args, time)
        .and_then(|ran| launchctl_ok(&args, ran))
        .with_context(|| format!("restarting the relay service `{agent}`; {recovery}"));
    if caller == LaunchAgentCaller::Install {
        // Loaded with `RunAtLoad`: it starts without the kick.
        return Ok(());
    }
    kicked
}

/// Boot out the agent when launchd has it loaded. Best effort and quiet:
/// launchctl prints alarming errors (`Boot-out failed: 5`) for an agent
/// that is not loaded, which is every first install.
#[cfg(target_os = "macos")]
pub(crate) fn bootout_if_loaded(domain: &str, file: &Path) {
    if agent_loaded(domain) {
        let _ = Command::new("launchctl")
            .args(["bootout", domain])
            .arg(file)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Whether launchd has the relay agent loaded in `domain`.
#[cfg(target_os = "macos")]
fn agent_loaded(domain: &str) -> bool {
    super::run_finite("launchctl", &["print", &format!("{domain}/{MACOS_LABEL}")]).is_ok()
}

#[cfg(target_os = "macos")]
pub(crate) fn launchd_domain() -> Result<String> {
    let (ok, uid, errors) = crate::process::bounded_run::management::run_bounded_split(
        "id",
        &["-u".to_string()],
        &[],
        super::FINITE_COMMAND_TIMEOUT,
    )
    .context("determining the current user ID")?;
    anyhow::ensure!(ok, "`id -u` failed: {}", errors.trim());
    // LaunchAgents for the logged-in GUI session use the `gui/<uid>` domain.
    Ok(format!("gui/{}", uid.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loaded_restart_bootstraps_an_unloaded_launch_agent() {
        let mut launchd = FakeLaunchd::new(false);
        launchd
            .restart(Restart::Loaded)
            .expect("restart unloaded agent");
        assert_eq!(
            launchd.calls(),
            ["print err", "bootstrap ok", "kickstart ok"]
        );
        let mut launchd = FakeLaunchd::new(false);
        launchd.bootstrap_failures = u32::MAX;
        assert!(launchd.restart(Restart::Loaded).is_err());
        assert!(!launchd.calls().contains(&"kickstart ok"));
    }

    /// A scripted launchd for [`restart_launch_agent`]: its own clock (each
    /// call takes 10 ms; `sleep` moves it), an agent that `bootout` unloads
    /// only after `unload_after` more looks (`print`), a `bootstrap` that
    /// fails while the agent is loaded (as launchd does, "5: Input/output
    /// error") and `bootstrap_failures` more times, and a log of every call:
    /// `ok` for exit 0, `err` for another exit (`print`: 113, not loaded),
    /// `fail` for a call that gave no answer (it could not run, or ran out of
    /// time). `print_fails` scripts that: the looks (counted from 1) that
    /// give no answer (every one with `print_fails_all`), an error or, with
    /// `print_exit`, another exit status.
    struct FakeLaunchd {
        start: std::time::Instant,
        at: std::time::Duration,
        loaded: bool,
        unloading: Option<u32>,
        unload_after: u32,
        bootout_fails: bool,
        bootstrap_failures: u32,
        kickstart_fails: bool,
        prints: u32,
        print_fails: Vec<u32>,
        print_fails_all: bool,
        print_exit: Option<i32>,
        log: Vec<String>,
    }

    impl FakeLaunchd {
        fn new(loaded: bool) -> Self {
            Self {
                start: std::time::Instant::now(),
                at: std::time::Duration::ZERO,
                loaded,
                unloading: None,
                unload_after: 0,
                bootout_fails: false,
                bootstrap_failures: 0,
                kickstart_fails: false,
                prints: 0,
                print_fails: Vec::new(),
                print_fails_all: false,
                print_exit: None,
                log: Vec::new(),
            }
        }

        fn deadline(&self) -> std::time::Instant {
            self.start + crate::host::service::FINITE_COMMAND_TIMEOUT
        }

        fn call(&mut self, caller: LaunchAgentCaller) -> Result<()> {
            let deadline = self.deadline();
            restart_launch_agent(self, caller, "gui/501", "gui/501/l", "/u/l.plist", deadline)
        }

        fn restart(&mut self, how: Restart) -> Result<()> {
            self.call(LaunchAgentCaller::Restart(how))
        }

        fn calls(&self) -> Vec<&str> {
            self.log.iter().map(String::as_str).collect()
        }
    }

    impl Launchctl for FakeLaunchd {
        fn run(
            &mut self,
            args: &[&str],
            timeout: std::time::Duration,
        ) -> Result<crate::process::bounded_run::management::Exited> {
            assert!(!timeout.is_zero(), "a call with no time left: {args:?}");
            assert!(
                self.now() + timeout <= self.deadline(),
                "past the deadline: {args:?}"
            );
            self.at += std::time::Duration::from_millis(10);
            let exit = |code: i32, text: &str| {
                Ok(crate::process::bounded_run::management::Exited {
                    code: Some(code),
                    stdout: String::new(),
                    stderr: text.to_string(),
                })
            };
            let result = match args[0] {
                "print" => {
                    if let Some(left) = self.unloading {
                        if left == 0 {
                            self.loaded = false;
                            self.unloading = None;
                        } else {
                            self.unloading = Some(left - 1);
                        }
                    }
                    self.prints += 1;
                    if self.print_fails_all || self.print_fails.contains(&self.prints) {
                        match self.print_exit {
                            Some(code) => exit(code, "Unexpected error"),
                            None => Err(anyhow::anyhow!(
                                "running `launchctl`: too many commands are running or stuck; try again later"
                            )),
                        }
                    } else if self.loaded {
                        exit(0, "")
                    } else {
                        exit(113, "Bad request.\nCould not find service")
                    }
                }
                "bootout" if self.bootout_fails => exit(1, "Boot-out failed: 1"),
                "bootout" => {
                    self.unloading = Some(self.unload_after);
                    exit(0, "")
                }
                "bootstrap" if self.loaded => exit(5, "Bootstrap failed: 5: Input/output error"),
                "bootstrap" if self.bootstrap_failures > 0 => {
                    self.bootstrap_failures -= 1;
                    exit(5, "Bootstrap failed: 5: Input/output error")
                }
                "bootstrap" => {
                    self.loaded = true;
                    exit(0, "")
                }
                "kickstart" if self.kickstart_fails => exit(1, "kickstart failed"),
                "kickstart" if self.loaded => exit(0, ""),
                "kickstart" => exit(113, "Could not find service"),
                other => panic!("unexpected launchctl {other}"),
            };
            self.log.push(format!(
                "{} {}",
                args[0],
                match &result {
                    Ok(ran) if ran.code == Some(0) => "ok",
                    Ok(_) => "err",
                    Err(_) => "fail",
                }
            ));
            result
        }
        fn now(&self) -> std::time::Instant {
            self.start + self.at
        }
        fn sleep(&mut self, pause: std::time::Duration) {
            self.log.push(format!("sleep {}", pause.as_millis()));
            self.at += pause;
        }
    }

    /// R5-B-2 hardening: `bootout` is asynchronous, so the reload waits until
    /// launchd no longer has the agent before `bootstrap`, which is never
    /// tried while it is loaded; a `bootstrap` that fails is tried again.
    #[test]
    fn a_reload_waits_for_the_unload_and_tries_bootstrap_again() {
        let mut launchd = FakeLaunchd::new(true);
        launchd.unload_after = 3;
        launchd.restart(Restart::Reloaded).expect("restart");
        assert_eq!(
            launchd.calls(),
            [
                "print ok",
                "bootout ok",
                "print ok",
                "sleep 100",
                "print ok",
                "sleep 200",
                "print ok",
                "sleep 400",
                "print err",
                "bootstrap ok",
                "kickstart ok"
            ]
        );

        let mut launchd = FakeLaunchd::new(true);
        launchd.bootstrap_failures = 2;
        launchd.restart(Restart::Reloaded).expect("restart");
        assert_eq!(
            launchd.calls(),
            [
                "print ok",
                "bootout ok",
                "print err",
                "bootstrap err",
                "print err",
                "sleep 100",
                "bootstrap err",
                "print err",
                "sleep 200",
                "bootstrap ok",
                "kickstart ok"
            ]
        );

        // `Loaded`: no reload when loaded; loaded first when not.
        let mut launchd = FakeLaunchd::new(true);
        launchd.restart(Restart::Loaded).expect("restart");
        assert_eq!(launchd.calls(), ["print ok", "kickstart ok"]);
        let mut launchd = FakeLaunchd::new(false);
        launchd.restart(Restart::Loaded).expect("restart");
        assert_eq!(
            launchd.calls(),
            ["print err", "bootstrap ok", "kickstart ok"]
        );
    }

    /// R5-B-2 hardening: when launchd will not load the agent again within
    /// the deadline, or never finishes unloading it, or `bootout` fails with
    /// it still loaded, the restart is an error that names
    /// `wsmp service install`, every call inside the one deadline.
    #[test]
    fn a_reload_that_cannot_finish_says_how_to_load_the_relay_again() {
        let mut launchd = FakeLaunchd::new(true);
        launchd.bootstrap_failures = u32::MAX;
        let error = launchd.restart(Restart::Reloaded).expect_err("never loads");
        let text = format!("{error:#}");
        assert!(
            text.contains("is not running") && text.contains("wsmp service install"),
            "{text}"
        );
        assert!(text.contains("Bootstrap failed: 5"), "{text}");
        assert!(launchd.now() <= launchd.deadline());
        assert!(!launchd.calls().contains(&"kickstart ok"));
        assert!(
            launchd
                .calls()
                .iter()
                .filter(|call| **call == "bootstrap err")
                .count()
                > 10
        );

        let mut launchd = FakeLaunchd::new(true);
        launchd.unload_after = u32::MAX;
        let error = launchd
            .restart(Restart::Reloaded)
            .expect_err("never unloads");
        assert!(
            format!("{error:#}").contains("wsmp service install"),
            "{error:#}"
        );
        assert!(launchd.now() <= launchd.deadline());
        assert!(!launchd.log.iter().any(|call| call.starts_with("bootstrap")));

        let mut launchd = FakeLaunchd::new(true);
        launchd.bootout_fails = true;
        let error = launchd
            .restart(Restart::Reloaded)
            .expect_err("bootout fails");
        assert!(
            format!("{error:#}").contains("wsmp service install"),
            "{error:#}"
        );
        assert_eq!(launchd.calls(), ["print ok", "bootout err", "print ok"]);
    }

    /// `wsmp service install` loads the plist through the same hardened
    /// sequence: a first install (nothing loaded) bootstraps and kickstarts as
    /// before; a reinstall over a loaded agent boots it out, waits until it is
    /// unloaded, then bootstraps (tried again) and kickstarts. Its errors say
    /// to run install again or bootstrap by hand, never to run install as if
    /// it were something else; a failed kickstart stays best effort.
    #[test]
    fn install_loads_the_agent_through_the_same_wait_and_retry() {
        let mut launchd = FakeLaunchd::new(false);
        launchd
            .call(LaunchAgentCaller::Install)
            .expect("first install");
        assert_eq!(
            launchd.calls(),
            ["print err", "bootstrap ok", "kickstart ok"]
        );

        let mut launchd = FakeLaunchd::new(true);
        launchd.unload_after = 1;
        launchd.bootstrap_failures = 1;
        launchd.call(LaunchAgentCaller::Install).expect("reinstall");
        assert_eq!(
            launchd.calls(),
            [
                "print ok",
                "bootout ok",
                "print ok",
                "sleep 100",
                "print err",
                "bootstrap err",
                "print err",
                "sleep 100",
                "bootstrap ok",
                "kickstart ok"
            ]
        );

        let mut launchd = FakeLaunchd::new(true);
        launchd.bootstrap_failures = u32::MAX;
        let error = launchd
            .call(LaunchAgentCaller::Install)
            .expect_err("never loads");
        let text = format!("{error:#}");
        assert!(
            text.contains("run `wsmp service install` again")
                && text.contains("load it by hand: `launchctl bootstrap gui/501 '/u/l.plist'`")
                && !text.contains("to load the relay service again"),
            "{text}"
        );
        assert!(launchd.now() <= launchd.deadline());

        let mut launchd = FakeLaunchd::new(false);
        launchd.kickstart_fails = true;
        launchd
            .call(LaunchAgentCaller::Install)
            .expect("kickstart is best effort");
        assert!(
            launchd.restart(Restart::Loaded).is_err(),
            "but not for a restart"
        );
    }

    /// Both callers that reload ([`restart_launch_agent`]).
    const RELOADERS: [LaunchAgentCaller; 2] = [
        LaunchAgentCaller::Restart(Restart::Reloaded),
        LaunchAgentCaller::Install,
    ];

    /// R6-B-1 / R6-A-3 (ported from `r6_b_query_failure_must_not_bypass_reload`
    /// and `r6a_initial_query_error_must_not_skip_reload`): the first look
    /// gives no answer while the old agent is loaded. That is not "not
    /// loaded": it is asked again, and the reload boots the old agent out,
    /// waits for launchd to say it is gone, and only then bootstraps. Both
    /// callers.
    #[test]
    fn a_first_look_without_an_answer_is_asked_again_never_taken_as_unloaded() {
        for caller in RELOADERS {
            for exit in [None, Some(5)] {
                let mut launchd = FakeLaunchd::new(true);
                launchd.print_fails = vec![1];
                launchd.print_exit = exit;
                launchd.call(caller).expect("reload");
                let first = if exit.is_some() {
                    "print err"
                } else {
                    "print fail"
                };
                assert_eq!(
                    launchd.calls(),
                    [
                        first,
                        "sleep 100",
                        "print ok",
                        "bootout ok",
                        "print err",
                        "bootstrap ok",
                        "kickstart ok"
                    ],
                    "{caller:?} {exit:?}"
                );
            }

            // No answer until the deadline: an error that names the way
            // back, and nothing was booted out or bootstrapped.
            let mut launchd = FakeLaunchd::new(true);
            launchd.print_fails_all = true;
            let error = launchd.call(caller).expect_err("no answer");
            let text = format!("{error:#}");
            assert!(
                text.contains("launchd did not say whether it has the relay service")
                    && text.contains("wsmp service install")
                    && text.contains("too many commands"),
                "{caller:?}: {text}"
            );
            assert!(launchd.now() <= launchd.deadline());
            assert!(
                launchd
                    .calls()
                    .iter()
                    .all(|call| call.starts_with("print") || call.starts_with("sleep")),
                "{caller:?}: {:?}",
                launchd.calls()
            );
            assert!(launchd.loaded, "the old agent stays loaded");
        }
    }

    /// R6-A-3 (ported from `r6a_bootout_query_error_must_not_report_success`):
    /// after `bootout`, a look that gives no answer while launchd is still
    /// unloading the old agent does not end the wait: a reload whose old
    /// agent never unloads is an error, not a success that kickstarts the
    /// old definition. When it does unload, `bootstrap` runs only after
    /// launchd said so. Both callers.
    #[test]
    fn a_look_without_an_answer_while_unloading_does_not_end_the_wait() {
        for caller in RELOADERS {
            let mut launchd = FakeLaunchd::new(true);
            launchd.unload_after = u32::MAX;
            launchd.print_fails = vec![2];
            let deadline = launchd.start + std::time::Duration::from_secs(2);
            let error = restart_launch_agent(
                &mut launchd,
                caller,
                "gui/501",
                "gui/501/l",
                "/u/l.plist",
                deadline,
            )
            .expect_err("never unloads");
            let text = format!("{error:#}");
            assert!(
                text.contains("still unloading") && text.contains("wsmp service install"),
                "{caller:?}: {text}"
            );
            assert!(
                !launchd
                    .log
                    .iter()
                    .any(|call| call.starts_with("bootstrap") || call.starts_with("kickstart")),
                "{caller:?}: {:?}",
                launchd.calls()
            );

            let mut launchd = FakeLaunchd::new(true);
            launchd.unload_after = 1;
            launchd.print_fails = vec![2];
            launchd.call(caller).expect("reload");
            assert_eq!(
                launchd.calls(),
                [
                    "print ok",
                    "bootout ok",
                    "print fail",
                    "sleep 100",
                    "print err",
                    "bootstrap ok",
                    "kickstart ok"
                ],
                "{caller:?}"
            );
            assert!(launchd.loaded);

            // A failed bootout followed by a look with no answer: asked
            // again; the old agent is still there, so it is an error.
            let mut launchd = FakeLaunchd::new(true);
            launchd.bootout_fails = true;
            launchd.print_fails = vec![2];
            let error = launchd.call(caller).expect_err("bootout failed");
            assert!(
                format!("{error:#}").contains("still runs the definition launchd loaded"),
                "{error:#}"
            );
            assert_eq!(
                launchd.calls(),
                [
                    "print ok",
                    "bootout err",
                    "print fail",
                    "sleep 100",
                    "print ok"
                ]
            );
        }
    }

    /// R6-B-3 / R6-A-4: the `launchctl bootstrap` install prints for loading
    /// the plist by hand gives the shell the plist's path as one argument,
    /// whatever a home directory may hold (a space, `'`, `$`, a backtick).
    #[cfg(unix)]
    #[test]
    fn the_bootstrap_by_hand_names_the_plist_as_one_argument() {
        for file in [
            "/Users/Jane Doe/Library/LaunchAgents/com.flycockpit.wsmp.plist",
            "/Users/o'neil/$HOME/`id`/a b'c$(x).plist",
            "/u/''/$$/\\/l.plist",
        ] {
            let mut launchd = FakeLaunchd::new(false);
            launchd.bootstrap_failures = u32::MAX;
            let deadline = launchd.deadline();
            let error = restart_launch_agent(
                &mut launchd,
                LaunchAgentCaller::Install,
                "gui/501",
                "gui/501/l",
                file,
                deadline,
            )
            .expect_err("never loads");
            // The outermost message, which ends with the hint.
            let text = format!("{error}");
            let start = text.find("load it by hand: `").expect("hint") + "load it by hand: `".len();
            let command = text[start..]
                .strip_suffix('`')
                .unwrap_or_else(|| panic!("the hint ends the message: {text}"));
            let out = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(format!(
                    "launchctl() {{ printf '%s\\0' \"$@\"; }}; {command}"
                ))
                .output()
                .expect("sh");
            assert!(out.status.success(), "{command}");
            assert_eq!(
                out.stdout,
                format!("bootstrap\0gui/501\0{file}\0").into_bytes(),
                "{command}"
            );
        }
    }
}
