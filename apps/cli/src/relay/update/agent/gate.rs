//! What this install can update itself with (the hello `features.selfUpdate`)
//! and the gates an `agent.update` must pass before a worker starts.

use crate::wire::protocol::frames::{InstallMethod, UpdateReason};
use crate::wire::protocol::runtime_spec::{RemoteUpdates, SelfUpdateFeatures, UpdateStrategy};

/// Runtime instances keep running when the relay restarts: Linux runs them in
/// systemd user units and Windows in detached runtime hosts, and the next
/// relay adopts them. macOS only wraps services whose start commands must
/// hand them to launchd themselves; that is not verified, so it reports false.
pub fn instances_survive() -> bool {
    cfg!(any(target_os = "linux", windows))
}

/// The strategies this install can update itself with.
pub fn strategies(
    method: InstallMethod,
    has_live: bool,
    under_service: bool,
) -> Vec<UpdateStrategy> {
    if !under_service || !has_live {
        return Vec::new();
    }
    match method {
        InstallMethod::Script | InstallMethod::ScriptPs1 => vec![UpdateStrategy::SelfReplace],
        InstallMethod::Homebrew => vec![UpdateStrategy::Homebrew],
        _ => Vec::new(),
    }
}

pub(super) fn remote_setting() -> RemoteUpdates {
    crate::node::config::Config::load_required()
        .map(|config| config.remote_updates)
        .unwrap_or_default()
}

/// The hello `features.selfUpdate`.
pub fn features() -> SelfUpdateFeatures {
    let identity = crate::relay::update::build::identity();
    SelfUpdateFeatures {
        strategies: strategies(
            identity.method,
            identity.live.is_some(),
            crate::host::service::under_service_manager(),
        ),
        instances_survive: instances_survive(),
        remote: remote_setting(),
    }
}

/// An `agent.update` as received.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateFrame {
    pub update_id: String,
    pub version: String,
    pub artifact_url: String,
    pub sha256: String,
    pub signature: Option<String>,
    pub force: bool,
    pub rollback_after_secs: u32,
}

/// What the relay knows when an update arrives.
#[derive(Debug, Clone, Copy)]
pub struct Gate {
    pub full_control: bool,
    pub remote: RemoteUpdates,
    pub method: InstallMethod,
    pub has_live: bool,
    pub under_service: bool,
}

/// The strategy for `frame`, or the refusal.
pub(super) fn check_gate(
    gate: &Gate,
    version: &str,
) -> Result<UpdateStrategy, (UpdateReason, String)> {
    if !gate.full_control {
        return Err((
            UpdateReason::NotOwnerTrust,
            "the node is not at Full control; run `wsmp trust full` on it to allow updates".into(),
        ));
    }
    if gate.remote == RemoteUpdates::Off {
        return Err((
            UpdateReason::OptedOut,
            "this machine's operator turned remote updates off (`wsmp config set-remote-updates allowed` turns them back on)".into(),
        ));
    }
    let strategy = match gate.method {
        InstallMethod::Script | InstallMethod::ScriptPs1 => UpdateStrategy::SelfReplace,
        InstallMethod::Homebrew => UpdateStrategy::Homebrew,
        InstallMethod::Source => {
            return Err((
                UpdateReason::SourceBuild,
                crate::relay::update::source_command(version),
            ));
        }
        InstallMethod::Unknown => {
            return Err((
                UpdateReason::UnsupportedMethod,
                crate::relay::update::UNKNOWN_METHOD.into(),
            ));
        }
        other => {
            return Err((
                UpdateReason::UnsupportedMethod,
                format!(
                    "this wsmp was installed with `{}`; update it the same way",
                    other.as_str()
                ),
            ));
        }
    };
    if !gate.has_live {
        return Err((
            UpdateReason::Internal,
            "the running wsmp binary cannot be found".into(),
        ));
    }
    if !gate.under_service {
        return Err((
            UpdateReason::UnsupportedMethod,
            "wsmp is not running as its installed service, so nothing would restart it; run `wsmp service install`, or `wsmp update` on the node".into(),
        ));
    }
    Ok(strategy)
}

/// The instance ranks that still run (anything not verified stopped).
pub fn running_instances() -> Vec<crate::services::runtimes::executor::Job> {
    let Ok(dir) = crate::services::runtimes::executor::instances_dir() else {
        return Vec::new();
    };
    let (executors, _) = crate::services::runtimes::executor::read_all(&dir);
    executors
        .iter()
        .flat_map(crate::services::runtimes::executor::Executor::ranks)
        .filter(|rank| rank.phase != crate::wire::protocol::frames::InstancePhase::Stopped)
        .map(|rank| rank.job)
        .collect()
}
