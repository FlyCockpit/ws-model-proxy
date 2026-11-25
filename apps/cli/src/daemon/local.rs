//! Local changes the relay follows, connected or not: control requests
//! from `wsmp` commands (status, reload, trust, stop) and hot reloads of
//! `config.json`.

use std::time::{Duration, Instant, SystemTime};

use anyhow::Result;

use crate::config::Config;
use crate::control::ControlServer;
use crate::control::{self, ControlCommand, ControlResponse};
use crate::protocol::frames::TrustValue;
use crate::startup::TerminalStartup;

/// What a control request or a hot reload changed, for the live session.
///
/// Trust itself is not carried here: the effects of a lowering follow the
/// daemon's [`crate::trust::TrustAuthority`] (its lowering count against
/// the one last applied, [`take_lowering`]), so changes that land in any
/// order in one loop turn end at whatever trust is now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NodeChange {
    /// Trust went down or up (persisted already): report `node.state`.
    Trust,
    /// Features changed (secrets, runtime hosts): report `node.state`.
    Features,
    /// `config.json` turned `allowHumanTerminal` off (latched already).
    HumanTerminalsDisabled,
}

/// Lower to Relay only: freeze (today's set when coming from Full),
/// persist, latch. Whether it changed. The latch holds even when writing
/// fails.
pub(super) fn apply_lower(startup: &TerminalStartup) -> Result<bool> {
    let persisted = if startup.full_control() {
        crate::trust::persist_lowering()
    } else {
        crate::trust::persist_relay()
    };
    let changed = startup.lower_trust();
    persisted.map(|()| changed)
}

/// Whether trust was lowered since the lowering count `applied` (and marks
/// it applied). Every lowering counts, even one raised again since: what was
/// started under the earlier grant still ends.
pub(super) fn take_lowering(applied: &mut u64, startup: &TerminalStartup) -> bool {
    let now = startup.trust_snapshot().lowerings;
    if now == *applied {
        return false;
    }
    *applied = now;
    true
}

/// Hot reload (every 2 s on a changed `config.json`, and on `Reload`):
/// runtime hosts follow the file; trust and the browser terminal switch only
/// ever go down. A file that says `full` while the node is Relay only is
/// written back to `relay`.
pub(super) fn reload_config(startup: &TerminalStartup) -> Result<Vec<NodeChange>> {
    let mut changes = vec![NodeChange::Features];
    // Trust first, from the raw file: a config that does not parse (a typo
    // anywhere) or lacks `trust: full` reads as Relay only.
    let file_trust = crate::trust::configured_on_disk();
    match Config::load_required() {
        Ok(config) => {
            startup.follow_runtime_hosts(&config);
            changes.extend(reload_human_terminal(startup, &config));
        }
        // A config that does not load reads as Relay only below, which ends
        // browser shells too.
        Err(error) => tracing::warn!(
            error = %format!("{error:#}"),
            "config.json does not load; keeping the runtime hosts"
        ),
    }
    match (startup.trust_value(), file_trust) {
        (TrustValue::Full, TrustValue::Relay) => {
            // The effects apply even when saving fails (the latch holds).
            if let Err(error) = apply_lower(startup) {
                tracing::error!(
                    error = %format!("{error:#}"),
                    "persisting the lowered trust failed"
                );
            }
            tracing::warn!("config.json lowered this node to Relay only");
            changes.push(NodeChange::Trust);
        }
        (TrustValue::Relay, TrustValue::Full) => {
            tracing::warn!(
                "config.json says `full`, but only `wsmp trust full` raises trust; keeping relay only"
            );
            crate::trust::persist_relay()?;
        }
        _ => {}
    }
    Ok(changes)
}

/// The browser terminal switch on hot reload: off latches now (and ends
/// browser shells); on takes a restart of the relay.
fn reload_human_terminal(startup: &TerminalStartup, config: &Config) -> Option<NodeChange> {
    if startup.follow_human_terminal_off(config) {
        tracing::warn!("config.json turned browser terminals off; ending browser shells");
        return Some(NodeChange::HumanTerminalsDisabled);
    }
    if config.allow_human_terminal && !startup.allow_human_terminal() {
        tracing::warn!("config.json turns browser terminals on; that takes a restart of the relay");
    }
    None
}

/// Polls `config.json` for edits (mtime, every 2 s).
pub(super) struct ConfigWatch {
    seen: Option<SystemTime>,
    next: Instant,
}

impl ConfigWatch {
    pub(super) fn new() -> Self {
        Self {
            seen: Self::mtime(),
            next: Instant::now() + CONFIG_POLL_INTERVAL,
        }
    }

    fn mtime() -> Option<SystemTime> {
        crate::paths::config_file()
            .ok()
            .and_then(|path| std::fs::metadata(path).ok())
            .and_then(|meta| meta.modified().ok())
    }

    /// Whether the file changed since the last look.
    fn changed(&mut self) -> bool {
        if Instant::now() < self.next {
            return false;
        }
        self.next = Instant::now() + CONFIG_POLL_INTERVAL;
        let now = Self::mtime();
        let changed = now != self.seen;
        self.seen = now;
        changed
    }
}

const CONFIG_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Everything local that changed since the last look, the same way online
/// and offline: control requests first, then a hot reload when `config.json`
/// changed. A failed reload is logged and changes nothing.
pub(super) fn local_changes(
    control: &mut ControlServer,
    startup: &TerminalStartup,
    node_slug: &str,
    connection: &str,
    watch: &mut ConfigWatch,
) -> Result<Vec<NodeChange>> {
    let mut changes = answer_control_requests(control, startup, node_slug, connection)?;
    if watch.changed() {
        match reload_config(startup) {
            Ok(found) => changes.extend(found),
            Err(error) => {
                tracing::warn!(error = %format!("{error:#}"), "reloading the config failed");
            }
        }
    }
    Ok(changes)
}

fn status_response<'a>(
    startup: &TerminalStartup,
    node_slug: &'a str,
    connection: &'a str,
) -> ControlResponse<'a> {
    ControlResponse {
        ok: true,
        state: "running",
        message: None,
        connection: Some(connection),
        node: Some(node_slug),
        trust: Some(crate::trust::word(startup.trust_value())),
    }
}

fn simple_response(ok: bool, state: &str, message: Option<&str>) -> ControlResponse<'static> {
    let state: &'static str = match state {
        "changed" => "changed",
        "unchanged" => "unchanged",
        _ => "refused",
    };
    ControlResponse {
        ok,
        state,
        message: message.map(|text| -> &'static str {
            match text {
                "raise" => "a process wsmp started cannot raise trust",
                "caller" => "the caller is a process wsmp started",
                _ => "the relay could not apply the change; see its log",
            }
        }),
        connection: None,
        node: None,
        trust: None,
    }
}

/// Answer local control requests; returns what changed for the session.
fn answer_control_requests(
    control: &mut ControlServer,
    startup: &TerminalStartup,
    node_slug: &str,
    connection: &str,
) -> Result<Vec<NodeChange>> {
    let mut changes = Vec::new();
    for pending in control.drain()? {
        match pending.request.command {
            ControlCommand::Status => {
                let _ = control::respond(pending, &status_response(startup, node_slug, connection));
            }
            ControlCommand::Reload => {
                let response = match reload_config(startup) {
                    Ok(found) => {
                        changes.extend(found);
                        simple_response(true, "changed", None)
                    }
                    Err(error) => {
                        tracing::warn!(error = %format!("{error:#}"), "reloading the config failed");
                        simple_response(false, "refused", Some("failed"))
                    }
                };
                let _ = control::respond(pending, &response);
            }
            ControlCommand::TrustRelay => {
                let was_full = startup.full_control();
                let lowered = apply_lower(startup);
                if was_full {
                    changes.push(NodeChange::Trust);
                }
                let response = match lowered {
                    Ok(true) => {
                        tracing::warn!("`wsmp trust relay` lowered this node to Relay only");
                        simple_response(true, "changed", None)
                    }
                    Ok(false) => simple_response(true, "unchanged", None),
                    Err(error) => {
                        tracing::warn!(error = %format!("{error:#}"), "lowering trust failed");
                        simple_response(false, "refused", Some("failed"))
                    }
                };
                let _ = control::respond(pending, &response);
            }
            ControlCommand::Stop => {
                // Answer first: the client waits for it, and the relay then
                // unwinds through its normal shutdown on the next turn.
                let _ = control::respond(pending, &simple_response(true, "changed", None));
                tracing::info!("stopping at the request of a local `wsmp` command");
                crate::shutdown::request_stop("wsmp service");
            }
            ControlCommand::CheckCaller => {
                // No peer pid: refused, as for a raise.
                let response = match pending
                    .peer_pid
                    .map(|pid| crate::trust::started_by_wsmp(pid, std::process::id()))
                {
                    Some(Ok(())) => simple_response(true, "unchanged", None),
                    _ => simple_response(false, "refused", Some("caller")),
                };
                let _ = control::respond(pending, &response);
            }
            ControlCommand::TrustFull => {
                // No peer pid, no raise.
                let allowed = pending.peer_pid.is_some_and(|pid| {
                    crate::trust::started_by_wsmp(pid, std::process::id()).is_ok()
                });
                let response = if !allowed {
                    tracing::warn!("refused a trust raise from a process wsmp started");
                    simple_response(false, "refused", Some("raise"))
                } else if startup.full_control() {
                    simple_response(true, "unchanged", None)
                } else {
                    match crate::trust::persist_full() {
                        Ok(()) => {
                            startup.raise_trust();
                            tracing::warn!("`wsmp trust full` raised this node to Full control");
                            changes.push(NodeChange::Trust);
                            simple_response(true, "changed", None)
                        }
                        Err(error) => {
                            tracing::warn!(error = %format!("{error:#}"), "raising trust failed");
                            simple_response(false, "refused", Some("failed"))
                        }
                    }
                };
                let _ = control::respond(pending, &response);
            }
        }
    }
    Ok(changes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn hot_reload_turns_browser_terminals_off_but_never_on() {
        let on = Config {
            allow_human_terminal: true,
            ..Config::default()
        };
        let off = Config::default();
        let startup = TerminalStartup::from_key(
            crate::terminal_crypto::CliTerminalKey::generate().expect("key"),
            &on,
        );
        assert!(reload_human_terminal(&startup, &on).is_none());
        assert!(startup.allow_human_terminal());
        assert_eq!(
            reload_human_terminal(&startup, &off),
            Some(NodeChange::HumanTerminalsDisabled)
        );
        assert!(!startup.allow_human_terminal());
        // Reported once; turning it back on in the file takes a restart.
        assert!(reload_human_terminal(&startup, &off).is_none());
        assert!(reload_human_terminal(&startup, &on).is_none());
        assert!(!startup.allow_human_terminal());
        assert!(!startup.features().terminals.supported);
    }

    /// F-trust: `wsmp trust full` then `wsmp trust relay` drained in one
    /// loop turn (or a raise and a hot-reload lowering) end at Relay only,
    /// and file ops are refused: the file relay reads the daemon's trust, so
    /// no change applied after the other can leave it at Full control.
    #[test]
    fn a_raise_then_a_lowering_in_one_turn_leaves_file_ops_refused() {
        let config = Config::default();
        let startup = TerminalStartup::from_key(
            crate::terminal_crypto::CliTerminalKey::generate().expect("key"),
            &config,
        );
        let mut applied = startup.trust_snapshot().lowerings;
        let policy = crate::file_ops::Policy::from_environment(vec![std::env::temp_dir()], false)
            .with_euid(1000);
        let runtime = Arc::new(crate::file_relay::FileRuntime::new(
            crate::file_ops::FileOps::new(policy, crate::file_ops::EtagKey::random()),
        ));
        let sink: crate::file_relay::FileSink = Arc::new(|_, _| {});
        let mut files = crate::file_relay::FileRelay::new(runtime, startup.trust_authority(), sink);
        let stat = |files: &mut crate::file_relay::FileRelay, n: u8| {
            use base64::Engine;
            let id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([n; 16]);
            let frames = files.handle_op(
                &id,
                "stat",
                serde_json::json!({ "path": std::env::temp_dir() }),
                None,
            );
            frames.iter().any(|frame| {
                matches!(
                    frame,
                    crate::file_relay::FileFrame::Control(message)
                        if serde_json::to_value(message).expect("json")["reason"] == "trust_relay"
                )
            })
        };
        assert!(stat(&mut files, 1), "Relay only at start");

        // Raised, then lowered, then the session applies the turn's changes.
        assert!(startup.raise_trust());
        assert!(startup.lower_trust());
        assert!(take_lowering(&mut applied, &startup));
        files.on_trust_changed();
        assert_eq!(startup.trust_value(), TrustValue::Relay);
        assert!(stat(&mut files, 2), "the lowering applied last wins");

        // Raised, lowered, then raised again: Full control, and the lowering still counts.
        assert!(startup.raise_trust());
        assert!(startup.lower_trust());
        assert!(startup.raise_trust());
        assert!(take_lowering(&mut applied, &startup));
        assert!(!take_lowering(&mut applied, &startup), "applied once");
        files.on_trust_changed();
        assert!(!stat(&mut files, 3), "raised last: admitted");
    }
}
