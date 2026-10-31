//! `wsmp update`: install the server's wsmp on this machine, with the same
//! verify, dead-man and rollback as an update from the browser. Also
//! `wsmp update status` and the dead-man's hidden `wsmp update rollback`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::output;
use crate::protocol::frames::{InstallMethod, UpdatePhase, UpdateReason};
use crate::update::flow::{self, Ended, Machine, Progress, Request, Rollback};
use crate::update::state::{self, Origin, Phase};

#[derive(Debug, clap::Args)]
#[command(args_conflicts_with_subcommands = true)]
pub struct Args {
    /// Emit JSON instead of human-readable text.
    #[arg(long, global = true)]
    json: bool,
    /// Update even when runtime instances run that stop with the relay on
    /// this platform, and reinstall when this version is already current.
    #[arg(long)]
    force: bool,
    #[command(subcommand)]
    command: Option<Sub>,
}

#[derive(Debug, clap::Subcommand)]
enum Sub {
    /// Show this build, how it was installed and the last update.
    Status,
    /// Internal: the update dead-man. Rolls `--if-unconfirmed` back when it is
    /// due and still unconfirmed.
    #[command(hide = true)]
    Rollback {
        #[arg(long, value_name = "UPDATE_ID")]
        if_unconfirmed: String,
        #[arg(long, value_name = "DIR")]
        state_dir: Option<PathBuf>,
    },
}

pub fn run(args: &Args) -> Result<()> {
    match &args.command {
        None => {
            crate::trust::refuse_in_job("wsmp update")?;
            update(args)
        }
        Some(Sub::Status) => status(args.json),
        Some(Sub::Rollback {
            if_unconfirmed,
            state_dir,
        }) => {
            if state_dir.is_some() {
                crate::paths::pin(None, state_dir.clone())?;
            }
            rollback(if_unconfirmed)
        }
    }
}

/// `GET <server>/cli/manifest.json`: what this server installs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub release_url: Option<String>,
    #[serde(default)]
    pub source_build: bool,
    #[serde(default)]
    pub artifacts: BTreeMap<String, Artifact>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Artifact {
    pub url: String,
    pub sha256: String,
}

pub const MANIFEST_PATH: &str = "cli/manifest.json";

fn fetch_manifest(server_url: &str) -> Result<Manifest> {
    let base = url::Url::parse(server_url)
        .with_context(|| format!("parsing server URL `{server_url}`"))?;
    let base = if base.path().ends_with('/') {
        base
    } else {
        url::Url::parse(&format!("{base}/")).context("building the manifest URL")?
    };
    let url = base
        .join(MANIFEST_PATH)
        .context("building the manifest URL")?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .max_redirects(0)
        .build()
        .into();
    let mut response = agent
        .get(url.as_str())
        .header("Accept", "application/json")
        .call()
        .with_context(|| format!("reaching `{url}`; does this server offer `wsmp update`?"))?;
    response
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_json()
        .with_context(|| format!("reading `{url}`"))
}

/// Progress on stderr (stdout carries the result).
/// Prints the update's steps to stderr. Why it stopped is kept for the
/// command's error instead, so it is said once.
#[derive(Default)]
struct Printer {
    stopped: Option<String>,
}

impl Printer {
    /// The command's error after [`Ended::Stopped`].
    fn stopped(self, fallback: String) -> anyhow::Error {
        anyhow::anyhow!(self.stopped.unwrap_or(fallback))
    }
}

impl Progress for Printer {
    fn report(&mut self, phase: UpdatePhase, reason: Option<UpdateReason>, detail: Option<String>) {
        if matches!(phase, UpdatePhase::Refused | UpdatePhase::Failed)
            && let Some(detail) = detail.as_deref().filter(|detail| !detail.is_empty())
        {
            self.stopped = Some(detail.to_string());
            return;
        }
        let text = match phase {
            UpdatePhase::Downloading => "downloading".to_string(),
            UpdatePhase::Verifying => "verifying the checksum and the new build".to_string(),
            UpdatePhase::Armed => "armed the automatic rollback".to_string(),
            UpdatePhase::Swapped => "installed the new build".to_string(),
            other => format!(
                "{other:?}{}{}",
                reason.map(|r| format!(" ({r:?})")).unwrap_or_default(),
                detail
                    .as_deref()
                    .map(|d| format!(": {d}"))
                    .unwrap_or_default()
            ),
        };
        let _ = output::diagnostic(format!("wsmp update: {text}"));
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateResult {
    from: String,
    to: String,
    /// `restarted` (the service confirms or rolls back), `installed`
    /// (restart wsmp yourself), `current` (nothing to do).
    outcome: &'static str,
    rollback_after_secs: Option<u32>,
}

fn emit(json: bool, result: &UpdateResult, text: String) -> Result<()> {
    if json {
        output::json(result)
    } else {
        output::line(text)
    }
}

const CLI_ROLLBACK_SECS: u32 = 180;

fn update(args: &Args) -> Result<()> {
    let config = crate::config::Config::load_required()?;
    let server_url = config
        .server_url
        .context("this node is not enrolled; run `wsmp login <url> --code <code>`")?;
    let manifest = fetch_manifest(&server_url)?;
    let identity = crate::update::build::identity();
    let current = crate::update::build::version().to_string();
    let same_build = manifest.version == current
        && match (&manifest.commit, &identity.commit) {
            (Some(theirs), Some(ours)) => theirs == ours,
            _ => true,
        };
    if same_build && !args.force {
        return emit(
            args.json,
            &UpdateResult {
                from: current.clone(),
                to: manifest.version.clone(),
                outcome: "current",
                rollback_after_secs: None,
            },
            format!("wsmp {current} is current (pass `--force` to reinstall it)"),
        );
    }
    if manifest.source_build {
        let rev = manifest.commit.as_deref().unwrap_or("<commit>");
        anyhow::bail!(
            "this server installs wsmp from source; run: cargo install --git https://github.com/FlyCockpit/ws-model-proxy --rev {rev} --locked --force wsmp"
        );
    }
    match identity.method {
        InstallMethod::Script | InstallMethod::ScriptPs1 | InstallMethod::Homebrew => {}
        InstallMethod::Source => anyhow::bail!(
            "this wsmp was built from source; run: {}",
            crate::update::source_command(&manifest.version)
        ),
        InstallMethod::Unknown => anyhow::bail!("{}", crate::update::UNKNOWN_METHOD),
        other => anyhow::bail!(
            "this wsmp was installed with `{}`; update it the same way",
            other.as_str()
        ),
    }
    let live = identity
        .live
        .clone()
        .context("the running wsmp binary cannot be found")?;
    if !crate::update::agent::instances_survive() && !args.force {
        let running = crate::update::agent::running_instances().len();
        anyhow::ensure!(
            running == 0,
            "{running} runtime instance(s) run here and stop when wsmp restarts on this platform; pass `--force` to update anyway"
        );
    }
    let state_dir = crate::paths::state_dir()?;
    let update_dir = state_dir.join("update");
    // Released before the restart: the new build takes it to confirm.
    let lock = state::UpdateLock::acquire(&update_dir)?
        .context("another update is in progress on this machine")?;
    // One abandoned before its swap, with no rollback job left to finish it, is settled now
    // (a registered job, or a swap that began, stays its owner's).
    if let Err(error) = flow::settle_abandoned(
        &update_dir,
        crate::update::deadman::platform().as_deref(),
        &lock,
    ) {
        tracing::warn!(error = %format!("{error:#}"), "looking at an earlier update failed");
    }
    if let Some(previous) = state::load(&update_dir)?
        && previous.phase.in_progress()
    {
        anyhow::bail!(
            "update `{}` to {} has not confirmed yet; wait for it (`wsmp update status`)",
            previous.update_id,
            previous.to_version
        );
    }
    let service = crate::commands::service::installed();
    let scheduler = if service {
        crate::update::deadman::platform()
    } else {
        None
    };
    let machine = Machine {
        state_dir,
        live,
        target: identity.target.clone(),
        scheduler: scheduler.as_deref(),
        tar: crate::update::install::system_tar(),
        current_version: current.clone(),
        before_swap: None,
        proceed: None,
        stable_service: crate::commands::service::ensure_stable_executable,
    };

    if identity.method == InstallMethod::Homebrew {
        let request = Request {
            update_id: crate::update::new_update_id(),
            version: manifest.version.clone(),
            artifact_url: String::new(),
            sha256: String::new(),
            signature: None,
            rollback_after_secs: CLI_ROLLBACK_SECS,
            origin: Origin::Cli,
        };
        let mut printer = Printer::default();
        let ended = crate::update::agent::homebrew(&machine, &request, &mut printer);
        if ended != Ended::Swapped {
            return Err(printer.stopped(format!(
                "the Homebrew upgrade did not install wsmp {}",
                manifest.version
            )));
        }
        if !service {
            settle_without_service(&update_dir)?;
        }
        drop(lock);
        return finish(
            args.json,
            service,
            &current,
            &manifest.version,
            None,
            crate::commands::service::Restart::Reloaded,
        );
    }

    let artifact = manifest.artifacts.get(&identity.target).with_context(|| {
        format!(
            "the server offers no wsmp {} build for `{}`",
            manifest.version, identity.target
        )
    })?;
    anyhow::ensure!(
        crate::protocol::frames::is_update_artifact_url(&artifact.url),
        "the server's artifact URL `{}` is not https",
        artifact.url
    );
    anyhow::ensure!(
        crate::protocol::frames::is_sha256_hex(&artifact.sha256),
        "the server's artifact checksum is not a SHA-256"
    );
    let request = Request {
        update_id: crate::update::new_update_id(),
        version: manifest.version.clone(),
        artifact_url: artifact.url.clone(),
        sha256: artifact.sha256.clone(),
        signature: None,
        rollback_after_secs: CLI_ROLLBACK_SECS,
        origin: Origin::Cli,
    };
    let mut printer = Printer::default();
    let ended = flow::self_replace(&machine, &request, &mut printer);
    if ended != Ended::Swapped {
        return Err(printer.stopped(format!(
            "wsmp {} was not installed; nothing was changed",
            manifest.version
        )));
    }
    if !service {
        settle_without_service(&update_dir)?;
        crate::update::receipt::write(
            &machine.state_dir,
            &crate::update::receipt::InstallReceipt {
                method: identity.method,
                version: manifest.version.clone(),
                commit: manifest.commit.clone(),
                target: Some(identity.target.clone()),
                binary: Some(machine.live.clone()),
                installed_at: Some(crate::file_ops::fmt::rfc3339_secs(crate::update::unix_now())),
            },
        )?;
    }
    drop(lock);
    finish(
        args.json,
        service,
        &current,
        &manifest.version,
        Some(CLI_ROLLBACK_SECS),
        crate::commands::service::Restart::Loaded,
    )
}

/// Without a service nothing restarts or rolls back: the new binary is
/// simply in place, and the update is done.
fn settle_without_service(update_dir: &std::path::Path) -> Result<()> {
    if let Some(mut done) = state::load(update_dir)?
        && done.phase == Phase::Swapped
    {
        done.advance(Phase::Confirmed)?;
        state::save(update_dir, &done)?;
    }
    Ok(())
}

fn finish(
    json: bool,
    service: bool,
    from: &str,
    to: &str,
    rollback: Option<u32>,
    restart: crate::commands::service::Restart,
) -> Result<()> {
    if service {
        crate::commands::service::restart_quietly(restart)
            .context("restarting the relay service")?;
        let text = match rollback {
            Some(secs) => format!(
                "updated wsmp {from} to {to} and restarted the service; it rolls back by itself unless the new build connects within {secs} s (`wsmp update status`)"
            ),
            None => format!("updated wsmp {from} to {to} and restarted the service"),
        };
        return emit(
            json,
            &UpdateResult {
                from: from.into(),
                to: to.into(),
                outcome: "restarted",
                rollback_after_secs: rollback,
            },
            text,
        );
    }
    emit(
        json,
        &UpdateResult {
            from: from.into(),
            to: to.into(),
            outcome: "installed",
            rollback_after_secs: None,
        },
        format!("updated wsmp {from} to {to}; restart a running `wsmp run` to use it"),
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    version: &'static str,
    commit: Option<String>,
    target: String,
    install_method: &'static str,
    binary: Option<String>,
    receipt: Option<crate::update::receipt::InstallReceipt>,
    remote_updates: &'static str,
    strategies: Vec<crate::protocol::runtime_spec::UpdateStrategy>,
    instances_survive: bool,
    last_update: Option<state::UpdateState>,
}

fn status(json: bool) -> Result<()> {
    let identity = crate::update::build::identity();
    let remote = crate::config::Config::load_required()
        .map(|config| config.remote_updates)
        .unwrap_or_default();
    let last_update = state::load(&crate::update::update_dir()?)?;
    let report = Status {
        version: crate::update::build::version(),
        commit: identity.commit.clone(),
        target: identity.target.clone(),
        install_method: identity.method.as_str(),
        binary: identity
            .live
            .as_ref()
            .map(|path| path.display().to_string()),
        receipt: identity.receipt.clone(),
        remote_updates: remote.as_str(),
        strategies: crate::update::agent::strategies(
            identity.method,
            identity.live.is_some(),
            crate::commands::service::installed(),
        ),
        instances_survive: crate::update::agent::instances_survive(),
        last_update,
    };
    if json {
        return output::json(&report);
    }
    output::line(format!(
        "wsmp {} ({}), {}",
        report.version,
        report.commit.as_deref().unwrap_or("commit unknown"),
        report.target
    ))?;
    output::line(format!(
        "installed with: {}{}",
        report.install_method,
        if report.receipt.is_some() {
            ""
        } else {
            " (no install receipt)"
        }
    ))?;
    if let Some(binary) = &report.binary {
        output::line(format!("binary: `{binary}`"))?;
    }
    output::line(format!("remote updates: {}", report.remote_updates))?;
    match &report.last_update {
        Some(last) => output::line(format!(
            "last update: {} to {} ({:?}{})",
            last.from_version,
            last.to_version,
            last.phase,
            last.detail
                .as_deref()
                .map(|detail| format!(": {}", crate::display_escape::escape_single_line(detail)))
                .unwrap_or_default()
        )),
        None => output::line("last update: none"),
    }
}

/// How often a waiting dead-man looks at the update again.
const DEADMAN_LOOK_EVERY: Duration = Duration::from_secs(5);

/// The dead-man: roll back when due and unconfirmed, then restart the
/// service and remove itself. It removes itself only once nothing is left
/// for it to do: a restart that failed after the rollback (retried here
/// first) keeps the job and exits nonzero, and the job's next run restarts
/// the relay ([`flow::restart_pending`]); so does an error before the
/// rollback was recorded (the replay finishes it). Every scheduler runs the
/// job again after a nonzero exit (see [`crate::update::deadman`]). The job
/// runs its recovery copy, which the rollback does not move, so that next
/// run has its program; the copy is removed once the job is
/// ([`flow::job_removed`]).
fn rollback(update_id: &str) -> Result<()> {
    let update_dir = crate::update::update_dir()?;
    let scheduler = crate::update::deadman::platform();
    rollback_with(
        &update_dir,
        update_id,
        scheduler.as_deref(),
        &|| crate::commands::service::restart_quietly(crate::commands::service::Restart::Loaded),
        &RESTART_RETRY_WAITS,
        log_tail,
    )
}

/// Before the second and third try of the relay's restart after a rollback
/// (each try is bounded by the service command's own limit). The job's next
/// run tries again after that.
const RESTART_RETRY_WAITS: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(3)];

fn rollback_with(
    update_dir: &std::path::Path,
    update_id: &str,
    scheduler: Option<&dyn crate::update::deadman::Scheduler>,
    restart: &dyn Fn() -> Result<()>,
    waits: &[Duration],
    log_tail: fn() -> Option<String>,
) -> Result<()> {
    loop {
        // Read without the lock (the file is replaced atomically): a dead-man
        // whose update confirmed or was replaced ends now, even while an
        // installer holds the lock to arm the next one.
        if let Some(gone) = flow::no_longer_due(update_dir, update_id) {
            tracing::info!(update_id, outcome = ?gone, "update dead-man");
            if gone == Rollback::NotOurs {
                return Ok(());
            }
            // Rolled back by an earlier run whose restart failed: this run's.
            if flow::restart_pending(update_dir, update_id) {
                restart_after_rollback(update_dir, update_id, restart, waits)?;
            }
            break;
        }
        let outcome = flow::rollback_if_unconfirmed(
            update_dir,
            update_id,
            crate::update::unix_now(),
            crate::update::deadman::booted_at(),
            log_tail,
        )?;
        tracing::info!(update_id, ?outcome, "update dead-man");
        match outcome {
            Rollback::NotDue(wait) => {
                if early_run_done(update_dir) {
                    return Ok(());
                }
                // In short steps, to see a confirmation soon.
                std::thread::sleep(wait.min(DEADMAN_LOOK_EVERY));
            }
            Rollback::RolledBack => {
                restart_after_rollback(update_dir, update_id, restart, waits)?;
                break;
            }
            // Another update owns the state (and the dead-man's name now).
            Rollback::NotOurs => return Ok(()),
            Rollback::Settled | Rollback::NeverSwapped | Rollback::NoCopy => break,
        }
    }
    // Last: on macOS removing the agent ends this process (its program then goes with a later
    // sweep). Once the job is gone, nothing runs its program (the recovery copy) any more.
    if let Some(scheduler) = scheduler
        && scheduler.remove().is_ok()
    {
        flow::job_removed(update_dir, update_id);
    }
    Ok(())
}

/// Restart the relay into the restored build, trying again after each of
/// `waits`. An error when it never worked: the caller then keeps the job
/// (and exits nonzero), so the job's next run tries again.
fn restart_after_rollback(
    update_dir: &std::path::Path,
    update_id: &str,
    restart: &dyn Fn() -> Result<()>,
    waits: &[Duration],
) -> Result<()> {
    let mut tries = std::iter::once(Duration::ZERO).chain(waits.iter().copied());
    let mut last = None;
    for wait in &mut tries {
        std::thread::sleep(wait);
        match restart() {
            Ok(()) => {
                if let Err(error) = flow::restart_done(update_dir, update_id) {
                    tracing::warn!(error = %format!("{error:#}"), "recording the relay's restart failed");
                }
                return Ok(());
            }
            Err(error) => {
                tracing::warn!(error = %format!("{error:#}"), "restarting the relay after the rollback failed");
                last = Some(error);
            }
        }
    }
    Err(last
        .unwrap_or_else(|| anyhow::anyhow!("no restart was tried"))
        .context(
            "the update was rolled back but the relay service did not restart; the rollback job stays and tries again",
        ))
}

/// Windows: the dead-man's early trigger, well before the deadline job
/// fires, only starts the relay task again after the exit 75 (Task
/// Scheduler's `RestartOnFailure` waits a minute); the deadline trigger comes
/// back for the check. A deadline run that finds the update not due (the new
/// build moved the deadline, or the machine rebooted) waits, as elsewhere.
fn early_run_done(update_dir: &std::path::Path) -> bool {
    #[cfg(windows)]
    {
        let early = state::load(update_dir)
            .ok()
            .flatten()
            .and_then(|current| current.deadman_at)
            .is_some_and(|fires_at| crate::update::unix_now() + 3 < fires_at);
        if early && let Err(error) = crate::commands::service::kick_relay_task() {
            tracing::warn!(error = %format!("{error:#}"), "starting the relay task failed");
        }
        early
    }
    #[cfg(not(windows))]
    {
        let _ = update_dir;
        false
    }
}

/// The failed build's last log lines, for the report.
fn log_tail() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let (_, text) = crate::update::deadman::run_bounded(
            "journalctl",
            &[
                "--user",
                "-u",
                "wsmp.service",
                "-n",
                "40",
                "--no-pager",
                "-o",
                "cat",
            ],
            &[],
            Duration::from_secs(15),
        )
        .ok()?;
        Some(text)
    }
    #[cfg(not(target_os = "linux"))]
    {
        #[cfg(target_os = "macos")]
        let file = dirs::home_dir()?.join("Library/Logs/ws-model-proxy/relay.err.log");
        #[cfg(not(target_os = "macos"))]
        let file = crate::paths::log_dir().ok()?.join("relay.log");
        let text = std::fs::read(file).ok()?;
        let text = String::from_utf8_lossy(&text);
        let lines: Vec<&str> = text.lines().collect();
        Some(lines[lines.len().saturating_sub(40)..].join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;
    use crate::update::deadman::Scheduler;
    use crate::update::deadman::fake::FakeScheduler;

    /// A self-replace update that swapped and never confirmed, past its deadline, with its
    /// rollback copy, and its dead-man registered.
    fn unconfirmed(root: &std::path::Path) -> (PathBuf, FakeScheduler, state::UpdateState) {
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).expect("bin");
        let mut current = state::sample(&bin, Phase::Swapped);
        std::fs::write(&current.live_path, "new wsmp 0.4.3\n").expect("live");
        std::fs::write(&current.prev_path, "old wsmp 0.4.2\n").expect("prev");
        current.to_sha256 =
            Some(crate::update::install::sha256_file(&current.live_path).expect("sha"));
        let recovery = bin.join(format!(".wsmp-recovery-{}", current.update_id));
        crate::update::install::prepare_recovery(&current.prev_path, &recovery).expect("recovery");
        current.recovery_path = Some(recovery);
        let update_dir = root.join("state/update");
        state::save(&update_dir, &current).expect("save");
        let scheduler = FakeScheduler::default();
        let spec = flow::deadman_spec(&current, &root.join("state"), Duration::from_secs(90))
            .expect("spec");
        scheduler.register(&spec).expect("register");
        (update_dir, scheduler, current)
    }

    fn no_log() -> Option<String> {
        None
    }

    /// Review P14 (F-FA-5), with the fixed expectations: the rollback restored the old build and
    /// the relay's restart then failed (every try). The dead-man must not report success and
    /// remove its job: it exits with an error and keeps the job, which owes the restart. Its next
    /// run (the scheduler runs it again after the failure) restarts the relay, then removes the
    /// job.
    #[test]
    fn a_failed_restart_after_a_rollback_keeps_the_dead_man() {
        let root = tempfile::tempdir().expect("root");
        let (update_dir, scheduler, current) = unconfirmed(root.path());
        let tries = Cell::new(0);
        let failing = || -> Result<()> {
            tries.set(tries.get() + 1);
            anyhow::bail!("temporary service-manager failure")
        };
        let waits = [Duration::from_millis(1), Duration::from_millis(1)];
        let error = rollback_with(
            &update_dir,
            &current.update_id,
            Some(&scheduler),
            &failing,
            &waits,
            no_log,
        )
        .expect_err("a failed restart is not success");
        assert!(
            format!("{error:#}").contains("did not restart"),
            "{error:#}"
        );
        assert_eq!(tries.get(), 3, "tried again within the run");
        assert!(scheduler.registered.borrow().is_some(), "the job stays");
        assert_eq!(*scheduler.removals.borrow(), 0);
        assert!(
            std::fs::read_to_string(&current.live_path)
                .expect("live")
                .starts_with("old")
        );
        assert!(flow::restart_pending(&update_dir, &current.update_id));
        // The job's program is still there for that next run (the restore consumed
        // `wsmp.prev`, never it).
        let program = scheduler
            .registered
            .borrow()
            .as_ref()
            .expect("job")
            .program()
            .to_path_buf();
        assert!(!current.prev_path.exists());
        assert_eq!(
            std::fs::read_to_string(&program).expect("program"),
            "old wsmp 0.4.2\n"
        );

        // The job's next run: the update is settled, but the restart is still owed.
        let restarted = Cell::new(0);
        let working = || -> Result<()> {
            restarted.set(restarted.get() + 1);
            Ok(())
        };
        rollback_with(
            &update_dir,
            &current.update_id,
            Some(&scheduler),
            &working,
            &waits,
            no_log,
        )
        .expect("restarted");
        assert_eq!(restarted.get(), 1);
        assert!(
            scheduler.registered.borrow().is_none(),
            "removed once nothing is owed"
        );
        assert!(!flow::restart_pending(&update_dir, &current.update_id));
        assert_eq!(
            state::load(&update_dir)
                .expect("load")
                .expect("state")
                .phase,
            Phase::RolledBack
        );
        // Restarted and its job removed: the program goes too.
        assert!(!program.exists());
    }

    /// The inverses: a restart that works at once (or on a later try) ends the job with
    /// success; a settled update that owes no restart is not restarted again.
    #[test]
    fn a_rollback_whose_restart_works_removes_the_dead_man() {
        let root = tempfile::tempdir().expect("root");
        let (update_dir, scheduler, current) = unconfirmed(root.path());
        let tries = Cell::new(0);
        let second_time = || -> Result<()> {
            tries.set(tries.get() + 1);
            if tries.get() < 2 {
                anyhow::bail!("not yet");
            }
            Ok(())
        };
        let waits = [Duration::from_millis(1), Duration::from_millis(1)];
        rollback_with(
            &update_dir,
            &current.update_id,
            Some(&scheduler),
            &second_time,
            &waits,
            no_log,
        )
        .expect("rolled back and restarted");
        assert_eq!(tries.get(), 2);
        assert!(scheduler.registered.borrow().is_none());
        assert!(!flow::restart_pending(&update_dir, &current.update_id));

        // Run again (the job could not be removed, say): nothing is owed, nothing restarts.
        let never = || -> Result<()> { panic!("no restart is owed") };
        rollback_with(
            &update_dir,
            &current.update_id,
            Some(&scheduler),
            &never,
            &waits,
            no_log,
        )
        .expect("settled");
    }
}
