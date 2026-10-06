//! The node's trust: the one switch for what the server may do here.
//!
//! `config.json` `trust` is the authority (unset reads as Relay only). Rules
//! (spec §3.2, §5.6):
//! - lowering to Relay only is always allowed and sticks: `trust.lower` from
//!   the server, `wsmp trust relay`, or a hand edit the daemon picks up;
//! - raising to Full control happens only through `wsmp trust full` on a
//!   terminal, which the daemon's control socket refuses from any process of
//!   the wsmp job tree (`WSMP_JOB=1`, a `wsmp-*` unit's cgroup, or a
//!   descendant of the daemon). A hot reload never raises: the daemon writes
//!   `relay` back over a hand-edited `full`.
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
    crate::runtime_store::freeze().context("freezing the held definitions")?;
    Config::update(false, |config| {
        config.trust = Some(TrustValue::Relay);
        Ok(())
    })
    .context("persisting trust `relay` to the config")
}

/// A Full to Relay change: the frozen copy is today's held set, never an
/// older copy left behind.
pub fn persist_lowering() -> Result<()> {
    crate::runtime_store::freeze_now().context("freezing the held definitions")?;
    persist_relay()
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

/// Why a local process may not raise trust, if it may not.
pub fn caller_marker_refusal() -> Option<&'static str> {
    std::env::var_os(JOB_MARKER_ENV)
        .is_some()
        .then_some("`wsmp trust full` cannot run from a command, job or terminal wsmp started")
}

/// The check of a process asking to raise trust (the control socket's peer,
/// or `wsmp trust full` itself when no daemon runs): refused when it or any
/// ancestor carries `WSMP_JOB`, runs in a wsmp unit (`wsmp-*`, the relay's
/// own `wsmp.service`), a `systemd-run` transient unit (`run-*`), the
/// daemon's own cgroup, or descends from the daemon. This keeps commands,
/// jobs and terminals wsmp started from raising trust; code the user's own
/// account runs outside them can, as it can edit any of the user's files.
#[cfg(target_os = "linux")]
pub fn peer_may_raise(peer_pid: i32, daemon_pid: u32) -> Result<(), &'static str> {
    let proc_root = std::path::Path::new("/proc");
    peer_may_raise_in(proc_root, peer_pid, daemon_pid)
}

#[cfg(target_os = "linux")]
fn cgroup_refused(cgroup: &str, daemon_cgroup: Option<&str>) -> bool {
    cgroup.lines().any(|line| {
        let path = line.splitn(3, ':').nth(2).unwrap_or(line);
        path.split('/').any(|unit| {
            unit.starts_with("wsmp-")
                || unit == "wsmp.service"
                || (unit.starts_with("run-") && unit.ends_with(".service"))
                || (unit.starts_with("run-") && unit.ends_with(".scope"))
        }) || daemon_cgroup.is_some_and(|daemon| daemon == path && path != "/")
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn peer_may_raise_in(
    proc_root: &std::path::Path,
    peer_pid: i32,
    daemon_pid: u32,
) -> Result<(), &'static str> {
    const REFUSED: &str = "a process wsmp started cannot raise trust";
    let daemon_cgroup = (daemon_pid != 0)
        .then(|| {
            std::fs::read_to_string(proc_root.join(daemon_pid.to_string()).join("cgroup")).ok()
        })
        .flatten()
        .and_then(|text| {
            text.lines()
                .next()
                .map(|line| line.splitn(3, ':').nth(2).unwrap_or(line).to_string())
        })
        // Only a service unit is the daemon's own: a relay started by hand
        // shares the person's session scope with their other terminals.
        .filter(|path| path.ends_with(".service"));
    let mut pid = u32::try_from(peer_pid).map_err(|_| "unknown control peer")?;
    if pid == 0 {
        return Err("unknown control peer");
    }
    for _ in 0..256 {
        if pid == daemon_pid {
            return Err(REFUSED);
        }
        let dir = proc_root.join(pid.to_string());
        // An unreadable environment is refused: we cannot prove the marker absent.
        let environ = std::fs::read(dir.join("environ")).map_err(|_| REFUSED)?;
        if environ
            .split(|b| *b == 0)
            .any(|entry| entry.starts_with(format!("{JOB_MARKER_ENV}=").as_bytes()))
        {
            return Err(REFUSED);
        }
        if let Ok(cgroup) = std::fs::read_to_string(dir.join("cgroup"))
            && cgroup_refused(&cgroup, daemon_cgroup.as_deref())
        {
            return Err(REFUSED);
        }
        let Some(parent) = parent_pid(&dir) else {
            return Err(REFUSED);
        };
        if parent <= 1 {
            return Ok(());
        }
        pid = parent;
    }
    Err(REFUSED)
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
pub fn peer_may_raise(peer_pid: i32, daemon_pid: u32) -> Result<(), &'static str> {
    const REFUSED: &str = "a process wsmp started cannot raise trust";
    let mut pid = u32::try_from(peer_pid).map_err(|_| "unknown control peer")?;
    for _ in 0..256 {
        if pid == daemon_pid {
            return Err(REFUSED);
        }
        if pid <= 1 {
            return Ok(());
        }
        let output = std::process::Command::new("ps")
            .args(["-o", "ppid=", "-p", &pid.to_string()])
            .output()
            .map_err(|_| REFUSED)?;
        pid = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .map_err(|_| REFUSED)?;
    }
    Err(REFUSED)
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
        assert_eq!(peer_may_raise_in(root.path(), 50, 999), Ok(()));
    }

    #[test]
    fn job_tree_processes_may_not_raise() {
        let root = tempfile::tempdir().expect("proc");
        // A marked ancestor, even when the peer dropped the marker.
        process(root.path(), 50, 40, &["HOME=/h"], "0::/user.slice\n");
        process(root.path(), 40, 1, &["WSMP_JOB=1"], "0::/user.slice\n");
        assert!(peer_may_raise_in(root.path(), 50, 999).is_err());
        // A runtime unit's process.
        process(
            root.path(),
            60,
            1,
            &[],
            "0::/user.slice/user@1000.service/app.slice/wsmp-i-abc-r0.service\n",
        );
        assert!(peer_may_raise_in(root.path(), 60, 999).is_err());
        // The relay's own service (a `setsid` escapee from a command).
        process(
            root.path(),
            61,
            1,
            &[],
            "0::/user.slice/user@1000.service/app.slice/wsmp.service\n",
        );
        assert!(peer_may_raise_in(root.path(), 61, 999).is_err());
        // A `systemd-run --user --pty` transient unit.
        process(
            root.path(),
            62,
            1,
            &[],
            "0::/user.slice/user@1000.service/app.slice/run-u12.service\n",
        );
        assert!(peer_may_raise_in(root.path(), 62, 999).is_err());
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
        assert!(peer_may_raise_in(root.path(), 63, 999).is_err());
        // A descendant of the daemon.
        process(root.path(), 70, 999, &[], "0::/x\n");
        assert!(peer_may_raise_in(root.path(), 70, 999).is_err());
        // An unreadable process is refused.
        assert!(peer_may_raise_in(root.path(), 80, 999).is_err());
        assert!(peer_may_raise_in(root.path(), 0, 999).is_err());
    }
}
