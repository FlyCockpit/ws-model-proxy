//! The node's trust: the one switch for what the server may do here.
//!
//! `config.json` `trust` is the authority (unset reads as Relay only). Rules
//! (spec §3.2, §5.6):
//! - lowering to Relay only is always allowed and sticks: `trust.lower` from
//!   the server, `wsmp trust relay`, or a hand edit the daemon picks up;
//! - raising to Full control happens only through `wsmp trust full` on a
//!   terminal, which it and the daemon's control socket refuse from any
//!   process wsmp started (`started_by_wsmp`). A hot reload never raises:
//!   the daemon writes `relay` back over a hand-edited `full`.
//! - no frame raises trust.

use anyhow::{Context, Result};

use crate::config::Config;
use crate::protocol::frames::TrustValue;

/// The marker every child the node starts carries (jobs, commands, metric
/// commands, terminals). `wsmp trust full` refuses to run under it.
pub const JOB_MARKER_ENV: &str = "WSMP_JOB";

/// The trust a config grants: unset is Relay only (fail closed).
pub fn configured(config: &Config) -> TrustValue {
    config.trust.unwrap_or(TrustValue::Relay)
}

/// The trust the daemon starts with. A frozen copy on disk means the node
/// was lowered, and only `wsmp trust full` removes it (before it writes
/// `full`), so a hand-edited `full` next to a frozen copy stays Relay only
/// and is written back.
pub fn at_startup(config: &Config) -> TrustValue {
    let frozen = crate::runtime_store::frozen_path()
        .map(|path| path.exists())
        .unwrap_or(true);
    if frozen {
        if config.trust == Some(TrustValue::Full) {
            tracing::warn!(
                "config.json says `full` but this node was lowered; only `wsmp trust full` raises it"
            );
            let _ = persist_relay();
        }
        return TrustValue::Relay;
    }
    configured(config)
}

/// The trust a hot reload sees: an unreadable or unparsable config, or one
/// whose `trust` is not exactly `full`, is Relay only.
pub fn configured_on_disk() -> TrustValue {
    let raw = crate::paths::config_file()
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    match raw.as_ref().and_then(|value| value.get("trust")) {
        Some(value) if value == "full" => TrustValue::Full,
        _ => TrustValue::Relay,
    }
}

pub fn word(trust: TrustValue) -> &'static str {
    match trust {
        TrustValue::Full => "full",
        TrustValue::Relay => "relay",
    }
}

/// Persist `trust: relay` and freeze the held definitions. The frozen copy
/// is written first (it is the marker that keeps a node lowered), then the
/// config. Idempotent: an existing frozen copy is kept.
pub fn persist_relay() -> Result<()> {
    if let Err(error) = crate::runtime_store::freeze() {
        // Fail closed: an empty frozen copy still marks the node lowered.
        tracing::error!(error = %format!("{error:#}"), "freezing the held definitions failed; holding none");
        crate::runtime_store::freeze_empty().context("marking the node lowered")?;
    }
    Config::update(false, |config| {
        config.trust = Some(TrustValue::Relay);
        Ok(())
    })
    .context("persisting trust `relay` to the config")
}

/// A Full to Relay change: the frozen copy is today's held set, never an
/// older copy left behind.
pub fn persist_lowering() -> Result<()> {
    if let Err(error) = crate::runtime_store::freeze_now() {
        tracing::error!(error = %format!("{error:#}"), "freezing the held definitions failed; holding none");
        crate::runtime_store::freeze_empty().context("marking the node lowered")?;
    }
    persist_relay()
}

/// The trust a node is at, as `wsmp trust` reports it: Relay only whenever
/// a frozen copy exists or the config does not say `full`.
pub fn effective(config: &Config) -> TrustValue {
    let frozen = crate::runtime_store::frozen_path()
        .map(|path| path.exists())
        .unwrap_or(true);
    if frozen {
        TrustValue::Relay
    } else {
        configured(config)
    }
}

/// Unfreeze, then persist `trust: full`. Only `wsmp trust full` (directly
/// when no daemon runs, else through the daemon after its peer check) calls
/// this; a failure part way leaves the node Relay only.
pub fn persist_full() -> Result<()> {
    crate::runtime_store::unfreeze().context("unfreezing the held definitions")?;
    Config::update(true, |config| {
        config.trust = Some(TrustValue::Full);
        Ok(())
    })
    .context("persisting trust `full` to the config")
}

/// Refuse `command` when a process wsmp started runs it: the commands that
/// change wsmp's own settings, credential, service, file recovery or
/// terminal approvals. The check is `self_started_by_wsmp`: the marker,
/// wsmp's cgroups, a relay among the ancestors, or a user-manager service.
/// Lowering (`wsmp trust relay`, revoking an approval) stays allowed from
/// anywhere.
pub fn refuse_in_job(command: &str) -> Result<()> {
    if self_started_by_wsmp().is_some() {
        anyhow::bail!("`{command}` cannot run from a command, job or terminal wsmp started");
    }
    Ok(())
}

/// Refuse `command` when this process carries `WSMP_JOB`, and nothing more:
/// `wsmp run`, which the relay's own service unit starts.
pub fn refuse_marked(command: &str) -> Result<()> {
    if std::env::var_os(JOB_MARKER_ENV).is_some() {
        anyhow::bail!("`{command}` cannot run from a command, job or terminal wsmp started");
    }
    Ok(())
}

/// Why this process counts as started by wsmp, if it does: its own
/// `WSMP_JOB`, then `started_by_wsmp` on itself (no relay pid known).
pub fn self_started_by_wsmp() -> Option<&'static str> {
    if std::env::var_os(JOB_MARKER_ENV).is_some() {
        return Some(STARTED);
    }
    #[cfg(unix)]
    {
        started_by_wsmp(i32::try_from(std::process::id()).unwrap_or(0), 0).err()
    }
    #[cfg(not(unix))]
    {
        None
    }
}

const STARTED: &str = "a process wsmp started cannot do this";

/// Whether `pid` was started by wsmp (a command, job, runtime or terminal),
/// as far as this machine can tell: `Err` names why it counts as started.
///
/// On Linux it is refused when:
/// - (a) it or a readable ancestor carries `WSMP_JOB`;
/// - (b) it or an ancestor runs in a wsmp cgroup: `wsmp.service`, a `wsmp-*`
///   unit, a `wsmp_i_*` runtime slice, a `systemd-run` transient unit
///   (`run-*.service`, `run-*.scope`), or the relay's own service cgroup;
/// - (c) an ancestor is the relay (`daemon_pid`, or any `wsmp … run`);
/// - (d) it runs in a service of the user's systemd manager
///   (`user@UID.service/…/x.service`): a person's shell runs in a session
///   or app scope, while `systemd-run --user --unit=x` makes a service.
///
/// The walk goes up the parents to pid 1. An ancestor whose environment
/// cannot be read (non-dumpable, more capabilities, another uid) ends it
/// with a pass only when it is the user's systemd manager
/// (`user@UID.service/init.scope`) or outside that manager (sshd, login,
/// root's units, which a job cannot create); any other one is refused.
///
/// This stops agents and `env -u WSMP_JOB`; it is no boundary against code
/// running as the user, which can name a scope like a terminal's, or `ssh`
/// back in to this machine.
#[cfg(target_os = "linux")]
pub fn started_by_wsmp(pid: i32, daemon_pid: u32) -> Result<(), &'static str> {
    started_by_wsmp_in(std::path::Path::new("/proc"), pid, daemon_pid)
}

/// The systemd cgroup path of a `/proc/<pid>/cgroup` text: the unified
/// (`0::`) line, else the `name=systemd` line, else the first.
#[cfg(target_os = "linux")]
fn systemd_path(cgroup: &str) -> &str {
    let pick = cgroup
        .lines()
        .find(|line| line.starts_with("0::"))
        .or_else(|| cgroup.lines().find(|line| line.contains(":name=systemd:")))
        .or_else(|| cgroup.lines().next())
        .unwrap_or("");
    pick.splitn(3, ':').nth(2).unwrap_or(pick)
}

#[cfg(target_os = "linux")]
fn is_user_manager_unit(unit: &str) -> bool {
    unit.starts_with("user@") && unit.ends_with(".service")
}

/// (d): a service unit under the user's systemd manager.
#[cfg(target_os = "linux")]
fn in_user_service(cgroup: &str) -> bool {
    let units: Vec<&str> = systemd_path(cgroup)
        .split('/')
        .filter(|unit| !unit.is_empty())
        .collect();
    let Some(manager) = units.iter().position(|unit| is_user_manager_unit(unit)) else {
        return false;
    };
    units
        .last()
        .is_some_and(|leaf| units.len() > manager + 1 && leaf.ends_with(".service"))
}

/// Where a walk may end at an unreadable ancestor: the user's systemd
/// manager itself, or anything outside it.
#[cfg(target_os = "linux")]
fn unreadable_may_end_walk(cgroup: &str) -> bool {
    let units: Vec<&str> = systemd_path(cgroup)
        .split('/')
        .filter(|unit| !unit.is_empty())
        .collect();
    match units.iter().position(|unit| is_user_manager_unit(unit)) {
        None => true,
        Some(manager) => units.len() == manager + 2 && units[manager + 1] == "init.scope",
    }
}

#[cfg(target_os = "linux")]
fn cgroup_refused(cgroup: &str, daemon_cgroup: Option<&str>) -> bool {
    cgroup.lines().any(|line| {
        let path = line.splitn(3, ':').nth(2).unwrap_or(line);
        path.split('/').any(|unit| {
            unit.starts_with("wsmp-")
                || unit.starts_with("wsmp_i_")
                || unit == "wsmp.service"
                || (unit.starts_with("run-") && unit.ends_with(".service"))
                || (unit.starts_with("run-") && unit.ends_with(".scope"))
        }) || daemon_cgroup.is_some_and(|daemon| daemon == path && path != "/")
    })
}

/// (c): a relay process, `wsmp … run` (its command line is its own, not
/// the job's to forge).
#[cfg(target_os = "linux")]
fn is_relay(cmdline: &[u8]) -> bool {
    let mut args = cmdline.split(|b| *b == 0).filter(|arg| !arg.is_empty());
    let Some(program) = args.next() else {
        return false;
    };
    let name = program.rsplit(|b| *b == b'/').next().unwrap_or(program);
    name == b"wsmp" && args.any(|arg| arg == b"run")
}

#[cfg(target_os = "linux")]
pub(crate) fn started_by_wsmp_in(
    proc_root: &std::path::Path,
    pid: i32,
    daemon_pid: u32,
) -> Result<(), &'static str> {
    const UNKNOWN: &str = "unknown caller";
    let daemon_cgroup = (daemon_pid != 0)
        .then(|| {
            std::fs::read_to_string(proc_root.join(daemon_pid.to_string()).join("cgroup")).ok()
        })
        .flatten()
        .map(|text| systemd_path(&text).to_string())
        // Only a service unit is the daemon's own: a relay started by hand
        // shares the person's session scope with their other terminals.
        .filter(|path| path.ends_with(".service"));
    let mut pid = u32::try_from(pid).map_err(|_| UNKNOWN)?;
    if pid == 0 {
        return Err(UNKNOWN);
    }
    let caller_cgroup = std::fs::read_to_string(proc_root.join(pid.to_string()).join("cgroup"))
        .map_err(|_| UNKNOWN)?;
    if in_user_service(&caller_cgroup) {
        return Err(STARTED);
    }
    for depth in 0..256 {
        if pid == daemon_pid {
            return Err(STARTED);
        }
        let dir = proc_root.join(pid.to_string());
        // A process that is gone cannot be judged.
        let parent = parent_pid(&dir).ok_or(STARTED)?;
        let cgroup = std::fs::read_to_string(dir.join("cgroup")).unwrap_or_default();
        if cgroup_refused(&cgroup, daemon_cgroup.as_deref()) {
            return Err(STARTED);
        }
        if depth > 0 && std::fs::read(dir.join("cmdline")).is_ok_and(|line| is_relay(&line)) {
            return Err(STARTED);
        }
        match std::fs::read(dir.join("environ")) {
            Ok(environ) => {
                if environ
                    .split(|b| *b == 0)
                    .any(|entry| entry.starts_with(format!("{JOB_MARKER_ENV}=").as_bytes()))
                {
                    return Err(STARTED);
                }
            }
            // The caller itself must be readable; an ancestor ends the walk
            // only where a job cannot put one.
            Err(_) if depth > 0 && unreadable_may_end_walk(&cgroup) => return Ok(()),
            Err(_) => return Err(STARTED),
        }
        if parent <= 1 {
            return Ok(());
        }
        pid = parent;
    }
    Err(STARTED)
}

#[cfg(target_os = "linux")]
fn parent_pid(dir: &std::path::Path) -> Option<u32> {
    let stat = std::fs::read_to_string(dir.join("stat")).ok()?;
    // `pid (comm) state ppid ...`; comm may contain spaces or parentheses.
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// macOS: no `/proc`; refuse descendants of the daemon (`ps -o ppid=`).
/// The requesting process checked its own `WSMP_JOB` marker.
#[cfg(all(unix, not(target_os = "linux")))]
pub fn started_by_wsmp(pid: i32, daemon_pid: u32) -> Result<(), &'static str> {
    let mut pid = u32::try_from(pid).map_err(|_| "unknown caller")?;
    for _ in 0..256 {
        if pid == daemon_pid {
            return Err(STARTED);
        }
        if pid <= 1 {
            return Ok(());
        }
        let output = std::process::Command::new("ps")
            .args(["-o", "ppid=", "-p", &pid.to_string()])
            .output()
            .map_err(|_| STARTED)?;
        pid = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .map_err(|_| STARTED)?;
    }
    Err(STARTED)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::path::Path;

    fn process(root: &Path, pid: u32, ppid: u32, environ: &[&str], cgroup: &str) {
        let dir = root.join(pid.to_string());
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(
            dir.join("stat"),
            format!("{pid} (sh (x)) S {ppid} 1 1 0 -1"),
        )
        .expect("stat");
        let mut env = Vec::new();
        for entry in environ {
            env.extend_from_slice(entry.as_bytes());
            env.push(0);
        }
        std::fs::write(dir.join("environ"), env).expect("environ");
        std::fs::write(dir.join("cgroup"), cgroup).expect("cgroup");
        std::fs::write(dir.join("cmdline"), b"sh\0").expect("cmdline");
    }

    /// A process whose environment cannot be read (non-dumpable, more
    /// capabilities, or another uid).
    fn unreadable(root: &Path, pid: u32, ppid: u32, cgroup: &str) {
        process(root, pid, ppid, &[], cgroup);
        std::fs::remove_file(root.join(pid.to_string()).join("environ")).expect("environ");
    }

    const MANAGER: &str = "0::/user.slice/user-1000.slice/user@1000.service/init.scope\n";
    const APP: &str = "0::/user.slice/user-1000.slice/user@1000.service/app.slice";

    #[test]
    fn a_person_s_shell_passes_its_unreadable_session_ancestors() {
        let root = tempfile::tempdir().expect("proc");
        // Desktop: a tmux shell under the user's systemd manager.
        let tmux = format!("{APP}/app-org.gnome.Terminal.slice/tmux-spawn-1.scope\n");
        process(root.path(), 50, 40, &["HOME=/h"], &tmux);
        process(root.path(), 40, 30, &["HOME=/h"], &tmux);
        unreadable(root.path(), 30, 1, MANAGER);
        assert_eq!(started_by_wsmp_in(root.path(), 50, 0), Ok(()));
        // SSH: the post-auth sshd (non-dumpable) in a logind session.
        let session = "0::/user.slice/user-1000.slice/session-3.scope\n";
        process(root.path(), 60, 59, &["HOME=/h"], session);
        unreadable(root.path(), 59, 58, session);
        unreadable(root.path(), 58, 1, "0::/system.slice/ssh.service\n");
        assert_eq!(started_by_wsmp_in(root.path(), 60, 0), Ok(()));
        // A root-owned system service (provisioning) is not the user's.
        process(
            root.path(),
            70,
            1,
            &[],
            "0::/system.slice/cloud-final.service\n",
        );
        assert_eq!(started_by_wsmp_in(root.path(), 70, 0), Ok(()));
    }

    #[test]
    fn user_manager_services_and_runtime_slices_count_as_wsmp_s() {
        let root = tempfile::tempdir().expect("proc");
        // `systemd-run --user --unit=x env -u WSMP_JOB …`: parent is the
        // manager, but the caller runs in a user service.
        process(
            root.path(),
            50,
            30,
            &["HOME=/h"],
            &format!("{APP}/x.service\n"),
        );
        unreadable(root.path(), 30, 1, MANAGER);
        assert!(started_by_wsmp_in(root.path(), 50, 0).is_err());
        // A runtime rank's scope in its `wsmp_i_*` slice, whatever the scope's name.
        process(
            root.path(),
            60,
            30,
            &[],
            &format!("{APP}/wsmp_i_abcdefabcdef_r0.slice/app-x.scope\n"),
        );
        assert!(started_by_wsmp_in(root.path(), 60, 0).is_err());
        // An unreadable ancestor inside the manager that is not the manager.
        let scope = format!("{APP}/app-x.scope\n");
        process(root.path(), 70, 69, &[], &scope);
        unreadable(root.path(), 69, 30, &scope);
        assert!(started_by_wsmp_in(root.path(), 70, 0).is_err());
        // The caller itself unreadable.
        unreadable(root.path(), 80, 1, "0::/user.slice/session-1.scope\n");
        assert!(started_by_wsmp_in(root.path(), 80, 0).is_err());
    }

    #[test]
    fn a_relay_ancestor_counts_without_its_pid() {
        let root = tempfile::tempdir().expect("proc");
        let tmux = format!("{APP}/tmux-spawn-1.scope\n");
        // A command of a relay run by hand, after `env -u WSMP_JOB`.
        process(root.path(), 50, 40, &["HOME=/h"], &tmux);
        process(root.path(), 40, 30, &["HOME=/h"], &tmux);
        std::fs::write(
            root.path().join("40").join("cmdline"),
            b"/home/me/.local/bin/wsmp\0-v\0run\0",
        )
        .expect("cmdline");
        unreadable(root.path(), 30, 1, MANAGER);
        assert!(started_by_wsmp_in(root.path(), 50, 0).is_err());
        assert!(is_relay(b"wsmp\0run\0"));
        assert!(!is_relay(b"wsmp\0trust\0full\0"));
        assert!(!is_relay(b"/usr/bin/cargo\0run\0"));
    }

    #[test]
    fn cgroup_paths_read_from_unified_or_v1_files() {
        assert_eq!(
            systemd_path("12:cpu:/x\n1:name=systemd:/user.slice/a.scope\n"),
            "/user.slice/a.scope"
        );
        assert_eq!(systemd_path("0::/a/b.scope\n"), "/a/b.scope");
        assert!(in_user_service(&format!("{APP}/x.service")));
        assert!(!in_user_service(&format!("{APP}/x.scope")));
        assert!(!in_user_service("0::/system.slice/x.service"));
        assert!(unreadable_may_end_walk(MANAGER));
        assert!(unreadable_may_end_walk("0::/system.slice/ssh.service"));
        assert!(!unreadable_may_end_walk(&format!("{APP}/x.scope")));
    }

    #[test]
    fn a_terminal_outside_the_job_tree_may_raise() {
        let root = tempfile::tempdir().expect("proc");
        process(
            root.path(),
            50,
            40,
            &["HOME=/h"],
            "0::/user.slice/session-1.scope\n",
        );
        process(
            root.path(),
            40,
            1,
            &["HOME=/h"],
            "0::/user.slice/session-1.scope\n",
        );
        assert_eq!(started_by_wsmp_in(root.path(), 50, 999), Ok(()));
    }

    #[test]
    fn job_tree_processes_may_not_raise() {
        let root = tempfile::tempdir().expect("proc");
        // A marked ancestor, even when the peer dropped the marker.
        process(root.path(), 50, 40, &["HOME=/h"], "0::/user.slice\n");
        process(root.path(), 40, 1, &["WSMP_JOB=1"], "0::/user.slice\n");
        assert!(started_by_wsmp_in(root.path(), 50, 999).is_err());
        // A runtime unit's process.
        process(
            root.path(),
            60,
            1,
            &[],
            "0::/user.slice/user@1000.service/app.slice/wsmp-i-abc-r0.service\n",
        );
        assert!(started_by_wsmp_in(root.path(), 60, 999).is_err());
        // The relay's own service (a `setsid` escapee from a command).
        process(
            root.path(),
            61,
            1,
            &[],
            "0::/user.slice/user@1000.service/app.slice/wsmp.service\n",
        );
        assert!(started_by_wsmp_in(root.path(), 61, 999).is_err());
        // A `systemd-run --user --pty` transient unit.
        process(
            root.path(),
            62,
            1,
            &[],
            "0::/user.slice/user@1000.service/app.slice/run-u12.service\n",
        );
        assert!(started_by_wsmp_in(root.path(), 62, 999).is_err());
        // The daemon's own cgroup, whatever it is called.
        process(
            root.path(),
            999,
            1,
            &[],
            "0::/system.slice/custom-relay.service\n",
        );
        process(
            root.path(),
            63,
            1,
            &[],
            "0::/system.slice/custom-relay.service\n",
        );
        assert!(started_by_wsmp_in(root.path(), 63, 999).is_err());
        // A descendant of the daemon.
        process(root.path(), 70, 999, &[], "0::/x\n");
        assert!(started_by_wsmp_in(root.path(), 70, 999).is_err());
        // An unreadable process is refused.
        assert!(started_by_wsmp_in(root.path(), 80, 999).is_err());
        assert!(started_by_wsmp_in(root.path(), 0, 999).is_err());
    }
}
