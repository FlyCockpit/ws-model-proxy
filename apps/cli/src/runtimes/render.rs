//! `runtime.job` admission: the node renders every command itself (§4.4,
//! §4.6), from the held (Full) or frozen (Relay only) definition whose
//! `versionId` AND `launchHash` the job names, after typing every value the
//! server sent. No text from the job reaches a shell except these typed
//! values; a failed check refuses before admission (`bad_job` with the field
//! path, `definition_missing` / `definition_frozen`, `interactive_unsupported`).

use std::collections::BTreeMap;

use crate::protocol::frames::{
    JobError, JobPhase, RuntimeJob, TrustValue, is_fabric_device_name, is_fabric_ip,
    runtime_unit_name,
};
use crate::protocol::runtime_spec::{Commands, Launch, RUNTIME_COMMAND_MAX_BYTES, RuntimeSpec};
use crate::runtime_store::Store;
use crate::runtime_store::validate::{is_instance_handle, placeholders};

use super::executor::Job;

/// Why a job was refused before admission: the code and the field path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub error: JobError,
    pub detail: Option<String>,
}

fn refuse(error: JobError, detail: impl Into<String>) -> Refusal {
    Refusal {
        error,
        detail: Some(detail.into()),
    }
}

/// What the node knows about itself for rendering.
pub struct NodeFacts {
    /// Interface name → addresses (`getifaddrs`).
    pub addresses: BTreeMap<String, Vec<String>>,
    /// Usually `/sys`.
    pub sys: std::path::PathBuf,
}

impl NodeFacts {
    pub fn current() -> Self {
        Self {
            addresses: crate::telemetry::interface_addresses(),
            sys: std::path::PathBuf::from("/sys"),
        }
    }
}

/// `^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$`
pub fn canonical_decimal(value: &str) -> bool {
    let (int, frac) = match value.split_once('.') {
        Some((int, frac)) => (int, Some(frac)),
        None => (value, None),
    };
    let int_ok = int == "0"
        || (!int.is_empty() && !int.starts_with('0') && int.bytes().all(|b| b.is_ascii_digit()));
    let frac_ok = frac.is_none_or(|frac| {
        (1..=6).contains(&frac.len()) && frac.bytes().all(|b| b.is_ascii_digit())
    });
    int_ok && frac_ok && value.len() <= 24
}

fn positive_decimal(value: &str) -> bool {
    canonical_decimal(value) && value.bytes().any(|b| (b'1'..=b'9').contains(&b))
}

/// `(0, 1]` as a canonical decimal.
fn fraction(value: &str) -> bool {
    positive_decimal(value)
        && (value.starts_with("0.")
            || value == "1"
            || value
                .strip_prefix("1.")
                .is_some_and(|f| f.bytes().all(|b| b == b'0')))
}

/// A comma list of GPU indices (0–255), unique, at most 64.
fn gpu_ids(value: &str) -> bool {
    let parts: Vec<&str> = value.split(',').collect();
    let mut seen = std::collections::BTreeSet::new();
    !value.is_empty()
        && parts.len() <= 64
        && parts.iter().all(|part| {
            (part == &"0" || (!part.starts_with('0') && !part.is_empty()))
                && part.len() <= 3
                && part.bytes().all(|b| b.is_ascii_digit())
                && part.parse::<u16>().is_ok_and(|n| n <= 255)
                && seen.insert(*part)
        })
}

fn phase_command(commands: &Commands, phase: JobPhase) -> Option<&str> {
    match phase {
        JobPhase::Prepare => commands.prepare.as_deref(),
        JobPhase::Start => Some(&commands.start),
        JobPhase::AfterJoin => commands.after_join.as_deref(),
        JobPhase::Stop => Some(&commands.stop),
        JobPhase::Status => commands.status.as_deref(),
        JobPhase::Health => commands.health.as_deref(),
        JobPhase::Readiness => None,
    }
}

/// Whether `phase` of `rank` is an interactive step in `spec`.
pub fn interactive_phase(spec: &RuntimeSpec, rank: u8, phase: JobPhase) -> bool {
    spec.launch.as_ref().is_some_and(|launch| {
        launch
            .commands
            .get(usize::from(rank))
            .or_else(|| (launch.commands.len() == 1).then(|| &launch.commands[0]))
            .is_some_and(|commands| phase_interactive(commands, phase))
    })
}

fn phase_interactive(commands: &Commands, phase: JobPhase) -> bool {
    let Some(flags) = commands.interactive else {
        return false;
    };
    match phase {
        JobPhase::Prepare => flags.prepare == Some(true),
        JobPhase::Start => flags.start == Some(true),
        JobPhase::AfterJoin => flags.after_join == Some(true),
        JobPhase::Stop => flags.stop == Some(true),
        _ => false,
    }
}

/// The step's lifetime: the server's `timeoutMs`, capped by the phase's
/// maximum (prepare 24 h, the rest 1 h).
fn capped_timeout(phase: JobPhase, timeout_ms: u64) -> u64 {
    let max = match phase {
        JobPhase::Prepare => 86_400_000,
        _ => 3_600_000,
    };
    timeout_ms.clamp(1, max)
}

/// Admit and render one job. `store` is the set for the node's trust (the
/// frozen copy at Relay only).
pub fn render(
    job: &RuntimeJob,
    trust: TrustValue,
    store: &Store,
    facts: &NodeFacts,
) -> Result<Job, Refusal> {
    let missing = if trust == TrustValue::Full {
        JobError::DefinitionMissing
    } else {
        JobError::DefinitionFrozen
    };
    let Some(held) = store.find(&job.launch_version_id, &job.launch_hash) else {
        return Err(refuse(missing, "launchVersionId"));
    };
    if held.runtime_id != job.runtime_id {
        return Err(refuse(missing, "runtimeId"));
    }
    let spec: RuntimeSpec = held
        .parsed()
        .map_err(|_| refuse(JobError::LocalConfigUnavailable, "spec"))?;
    let Some(launch) = spec.launch.as_ref() else {
        return Err(refuse(JobError::BadJob, "runtimeId"));
    };
    check_identity(job, launch)?;
    let commands = launch
        .commands
        .get(usize::from(job.rank))
        .or_else(|| (launch.commands.len() == 1).then(|| &launch.commands[0]))
        .ok_or_else(|| refuse(JobError::BadJob, "rank"))?;
    // An interactive phase runs only in the operator terminal the server
    // minted for it, and only an interactive phase gets one.
    if phase_interactive(commands, job.phase) != job.operator.is_some() {
        return Err(refuse(JobError::BadJob, "operator"));
    }
    let values = typed_values(job, launch, store, facts)?;
    let render_one = |text: &str, field: &str| -> Result<String, Refusal> {
        let rendered = substitute(text, &values)
            .map_err(|name| refuse(JobError::BadJob, format!("placeholders.{name}")))?;
        if rendered.len() > RUNTIME_COMMAND_MAX_BYTES {
            return Err(refuse(JobError::BadJob, field.to_string()));
        }
        Ok(rendered)
    };
    let command = match phase_command(commands, job.phase) {
        Some(text) => render_one(text, "command")?,
        None => String::new(),
    };
    let stop_command = render_one(&commands.stop, "stop")?;
    let status_command = commands
        .status
        .as_deref()
        .map(|text| render_one(text, "status"))
        .transpose()?;
    let health_command = commands
        .health
        .as_deref()
        .map(|text| render_one(text, "health"))
        .transpose()?;
    // Where the engine listens: its fabric address when the start command
    // binds `{{fabric_ip}}`, else loopback.
    let host = if placeholders(&commands.start).any(|name| name == "fabric_ip") {
        values
            .get("fabric_ip")
            .cloned()
            .unwrap_or_else(|| "127.0.0.1".to_string())
    } else {
        "127.0.0.1".to_string()
    };
    Ok(Job {
        step_id: job.step_id.clone(),
        instance_id: job.instance_id.clone(),
        runtime_id: job.runtime_id.clone(),
        version_id: job.launch_version_id.clone(),
        launch_hash: job.launch_hash.clone(),
        rank: job.rank,
        action: job.phase,
        intent_hash: job.intent_hash.clone(),
        owner_epoch: job.owner_epoch.clone(),
        command,
        stop_command,
        status_command,
        health_command,
        secrets: launch.secrets.clone().unwrap_or_default(),
        timeout_ms: capped_timeout(job.phase, job.timeout_ms),
        unit_name: job.unit_name.clone(),
        handle: job.handle.clone(),
        port: job.placeholders.port,
        gpu_ids: job.placeholders.gpu_ids.clone(),
        host,
        spec: held.spec.clone(),
    })
}

/// Step id, instance id, epoch and intent hash are plain.
pub fn check_ids(job: &RuntimeJob) -> Result<(), Refusal> {
    let id_ok = |value: &str, colon: bool| {
        !value.is_empty()
            && value.len() <= 128
            && value.bytes().all(|b| {
                b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || (colon && b == b':')
            })
    };
    for (field, value, colon) in [
        ("stepId", job.step_id.as_str(), false),
        ("instanceId", job.instance_id.as_str(), false),
        ("ownerEpoch", job.owner_epoch.as_str(), true),
    ] {
        if !id_ok(value, colon) {
            return Err(refuse(JobError::BadJob, field));
        }
    }
    if job.intent_hash.len() != 64 || !job.intent_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(refuse(JobError::BadJob, "intentHash"));
    }
    if !is_instance_handle(&job.handle) {
        return Err(refuse(JobError::BadJob, "handle"));
    }
    if job.unit_name != runtime_unit_name(&job.handle, job.rank) {
        return Err(refuse(JobError::BadJob, "unitName"));
    }
    Ok(())
}

fn check_identity(job: &RuntimeJob, launch: &Launch) -> Result<(), Refusal> {
    if job.nnodes != launch.group_size {
        return Err(refuse(JobError::BadJob, "nnodes"));
    }
    if job.rank >= job.nnodes {
        return Err(refuse(JobError::BadJob, "rank"));
    }
    check_ids(job)?;
    Ok(())
}

/// Every placeholder value, typed (§4.6). Values the job does not send stay
/// absent: a command that uses one is refused when it is rendered.
fn typed_values(
    job: &RuntimeJob,
    launch: &Launch,
    store: &Store,
    facts: &NodeFacts,
) -> Result<BTreeMap<&'static str, String>, Refusal> {
    let mut values = BTreeMap::new();
    let p = &job.placeholders;
    values.insert("node_rank", job.rank.to_string());
    values.insert("nnodes", job.nnodes.to_string());
    // Port: inside the node's range, unless the definition fixes it.
    let fixed = launch.port.map(|port| port.fixed);
    let port_ok = p.port >= 1024
        && match fixed {
            Some(fixed) => p.port == fixed,
            None => store
                .port_range()
                .is_some_and(|[start, end]| (start..=end).contains(&p.port)),
        };
    if !port_ok {
        return Err(refuse(JobError::BadJob, "placeholders.port"));
    }
    values.insert("port", p.port.to_string());
    if let Some(dist) = p.dist_port {
        let in_range = store
            .port_range()
            .is_some_and(|[start, end]| (start..=end).contains(&dist));
        if dist < 1024 || dist == p.port || !in_range {
            return Err(refuse(JobError::BadJob, "placeholders.dist_port"));
        }
        values.insert("dist_port", dist.to_string());
    }
    if let Some(ids) = &p.gpu_ids {
        if !gpu_ids(ids) {
            return Err(refuse(JobError::BadJob, "placeholders.gpu_ids"));
        }
        values.insert("gpu_ids", ids.clone());
    }
    for (name, value) in [("memory_gb", &p.memory_gb), ("vram_gb", &p.vram_gb)] {
        if let Some(value) = value {
            if !positive_decimal(value) {
                return Err(refuse(JobError::BadJob, format!("placeholders.{name}")));
            }
            values.insert(name, value.clone());
        }
    }
    if let Some(value) = &p.memory_fraction {
        if !fraction(value) {
            return Err(refuse(JobError::BadJob, "placeholders.memory_fraction"));
        }
        values.insert("memory_fraction", value.clone());
    }
    // Multi-node: the head and this node's own address on the job's fabric,
    // both from the node's (frozen at Relay only) fabric sets.
    if job.nnodes > 1 {
        let (Some(fabric_id), Some(head)) = (&job.fabric_id, &p.head_addr) else {
            return Err(refuse(JobError::BadJob, "fabricId"));
        };
        let Some(set) = store.fabric(fabric_id) else {
            return Err(refuse(JobError::DefinitionFrozen, "fabricId"));
        };
        if !is_fabric_ip(head) || !set.member_ips.iter().any(|ip| ip == head) {
            return Err(refuse(JobError::DefinitionFrozen, "placeholders.head_addr"));
        }
        if launch
            .fabric
            .as_deref()
            .is_some_and(|name| name != set.name)
        {
            return Err(refuse(JobError::BadJob, "fabricId"));
        }
        // The node's own address on the fabric must be on this machine.
        let Some(iface) = super::fabric::interface_for(&set.self_ip, &facts.addresses) else {
            return Err(refuse(JobError::BadJob, "placeholders.fabric_ip"));
        };
        if !is_fabric_device_name(&iface) {
            return Err(refuse(JobError::BadJob, "placeholders.fabric_iface"));
        }
        values.insert("head_addr", head.clone());
        values.insert("fabric_ip", set.self_ip.clone());
        if let Some(device) = super::fabric::rdma_device_for(&iface, &facts.sys) {
            values.insert("fabric_rdma_device", device);
        }
        values.insert("fabric_iface", iface);
    } else if job.fabric_id.is_some() || p.head_addr.is_some() {
        return Err(refuse(JobError::BadJob, "fabricId"));
    }
    for name in ["fabric_iface", "fabric_rdma_device"] {
        if values
            .get(name)
            .is_some_and(|value| !is_fabric_device_name(value))
        {
            values.remove(name);
        }
    }
    Ok(values)
}

/// Replace every `{{name}}`; an unknown or absent value names itself.
pub fn substitute(text: &str, values: &BTreeMap<&'static str, String>) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return Ok(out);
        };
        let name = &after[..end];
        if !name.is_empty() && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
            match values.get(name) {
                Some(value) => out.push_str(value),
                None => return Err(name.to_string()),
            }
            rest = &after[end + 2..];
        } else {
            out.push_str("{{");
            rest = after;
        }
    }
    out.push_str(rest);
    Ok(out)
}

#[cfg(test)]
mod tests;
