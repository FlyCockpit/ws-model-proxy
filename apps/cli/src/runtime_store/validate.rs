//! Node-side rules for a server-pushed definition (spec §4.3), mirroring
//! `packages/api/src/lib/runtime-spec.ts`. Serde (`deny_unknown_fields`)
//! fixes the shape; these checks add the value and cross-field rules. A
//! failure names the JSON path, never spec text.

use std::collections::BTreeSet;
use std::net::IpAddr;

use crate::protocol::frames::{FabricSet, is_fabric_ip, is_secret_name};
use crate::protocol::runtime_spec::{
    Address, Commands, FABRIC_MEMBERS_MAX, Launch, Management, MetricsReader, ModelType,
    NODE_FABRICS_MAX, NODE_METRIC_COMMANDS_MAX, NodeMetricCommand, RUNTIME_COMMAND_MAX_BYTES,
    RUNTIME_PLACEHOLDERS, ReaderMapEntry, Resource, RuntimeApi, RuntimeSpec, SpecModel,
    TranscriptionProfile,
};

/// Why a put was refused: the reason and the JSON path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpecIssue {
    Invalid(String),
    BaseUrlNotAllowed(String),
    EnvNotAllowed(String),
}

type Check = Result<(), SpecIssue>;

fn invalid(path: impl Into<String>) -> SpecIssue {
    SpecIssue::Invalid(path.into())
}

fn ensure(ok: bool, path: impl FnOnce() -> String) -> Check {
    if ok { Ok(()) } else { Err(invalid(path())) }
}

const RUNTIME_GROUP_SIZE_MAX: usize = 64;
const RUNTIME_MODELS_MAX: usize = 64;
const RUNTIME_LABELS_MAX: usize = 32;
const NODE_SECRETS_MAX: usize = 64;

// ── Text rules ──

/// Code points that are invisible, reorder text or look like a plain space
/// (controls except TAB/LF, format characters, default-ignorables, non-ASCII
/// spaces, line/paragraph separators, U+2800).
pub fn is_hidden_char(c: char) -> bool {
    let cp = c as u32;
    if c == '\t' || c == '\n' || c == ' ' {
        return false;
    }
    if c.is_control() {
        return true;
    }
    matches!(
        cp,
        0x00A0
            | 0x00AD
            | 0x034F
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x0890..=0x0891
            | 0x08E2
            | 0x0600..=0x0605
            | 0x115F..=0x1160
            | 0x1680
            | 0x17B4..=0x17B5
            | 0x180B..=0x180F
            | 0x2000..=0x200F
            | 0x2028..=0x202F
            | 0x205F..=0x206F
            | 0x2800
            | 0x3000
            | 0x3164
            | 0xFE00..=0xFE0F
            | 0xFEFF
            | 0xFFA0
            | 0xFFF0..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0000..=0xE0FFF
    )
}

/// Reviewed text: no hidden characters, at most `max_bytes` UTF-8 bytes.
pub fn text_ok(value: &str, max_bytes: usize) -> bool {
    value.len() <= max_bytes && !value.chars().any(is_hidden_char)
}

/// Text with no surrounding whitespace, not blank.
fn exact_text_ok(value: &str, max_bytes: usize) -> bool {
    text_ok(value, max_bytes) && !value.is_empty() && value.trim() == value
}

/// Placeholders in `{{name}}` form.
pub fn placeholders(command: &str) -> impl Iterator<Item = &str> {
    command.match_indices("{{").filter_map(move |(start, _)| {
        let rest = &command[start + 2..];
        let end = rest.find("}}")?;
        let name = &rest[..end];
        (!name.is_empty() && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
            .then_some(name)
    })
}

pub fn command_ok(command: &str) -> bool {
    text_ok(command, RUNTIME_COMMAND_MAX_BYTES)
        && !command.trim().is_empty()
        && placeholders(command).all(|name| RUNTIME_PLACEHOLDERS.contains(&name))
}

/// An origin-relative route: one leading slash, no `//`, `..`, `#`, `?`,
/// whitespace, backslash or `%2e`/`%2f`.
pub fn route_ok(route: &str) -> bool {
    text_ok(route, 1024)
        && route.starts_with('/')
        && !route.starts_with("//")
        && !route.contains(':')
        && !route
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '#' | '?' | '\\'))
        && !route.split('/').any(|segment| segment == "..")
        && !route.to_ascii_lowercase().contains("%2e")
        && !route.to_ascii_lowercase().contains("%2f")
}

fn label_ok(label: &str) -> bool {
    let bytes = label.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// `^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,40}$`, and never an instance handle.
pub fn runtime_slug_ok(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    let shape = !bytes.is_empty()
        && bytes.len() <= 41
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && !slug.ends_with('-')
        && !slug.contains("--");
    shape && !is_instance_handle(slug)
}

/// `i-<id12>`: an instance handle.
pub fn is_instance_handle(value: &str) -> bool {
    value.strip_prefix("i-").is_some_and(|rest| {
        rest.len() == 12
            && rest
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    })
}

fn series_name_ok(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}

/// A number canonical JSON can hash: a safe integer, or 1e-6 ≤ |x| < 1e15.
fn canonical_number(value: f64) -> bool {
    if !value.is_finite() {
        return false;
    }
    if value.fract() == 0.0 {
        return value.abs() <= 9_007_199_254_740_991.0;
    }
    (1e-6..1e15).contains(&value.abs())
}

fn gib_ok(value: f64) -> bool {
    canonical_number(value) && value > 0.0 && value <= 1_000_000.0
}

// ── The spec ──

pub fn validate_spec(spec: &RuntimeSpec, runtime_hosts: &[String]) -> Check {
    ensure(spec.address.is_some() != spec.launch.is_some(), || {
        "launch".into()
    })?;
    // The contract's own shape rule first (same as the server's).
    if spec.validate_shape().is_err() {
        let serves = spec.serves();
        let path = if spec.launch.as_ref().is_some_and(|l| l.readiness.is_none()) && serves {
            "launch.readiness"
        } else if spec.api.is_some() != serves {
            "api"
        } else if spec.engine.is_some() != serves {
            "engine"
        } else if spec.model_type.is_some() != serves {
            "modelType"
        } else {
            "launch.readiness"
        };
        return Err(invalid(path));
    }
    let serves = spec.address.is_some() || spec.models.is_some();
    ensure(spec.api.is_some() == serves, || "api".into())?;
    ensure(spec.engine.is_some() == serves, || "engine".into())?;
    ensure(spec.model_type.is_some() == serves, || "modelType".into())?;
    if !serves {
        ensure(spec.metrics_reader.is_none(), || "metricsReader".into())?;
        ensure(spec.expand_media.is_none(), || "expandMedia".into())?;
    }
    if spec.api == Some(RuntimeApi::Anthropic) {
        ensure(spec.model_type == Some(ModelType::Llm), || {
            "modelType".into()
        })?;
    }
    if let Some(models) = &spec.models {
        validate_models(models, spec.model_type)?;
    }
    if let Some(address) = &spec.address {
        validate_address(address, runtime_hosts)?;
    }
    if let Some(launch) = &spec.launch {
        validate_launch(launch, serves)?;
    }
    if let Some(reader) = &spec.metrics_reader {
        validate_reader(reader)?;
    }
    Ok(())
}

fn validate_models(models: &[SpecModel], model_type: Option<ModelType>) -> Check {
    ensure((1..=RUNTIME_MODELS_MAX).contains(&models.len()), || {
        "models".into()
    })?;
    let mut ids = BTreeSet::new();
    for (index, model) in models.iter().enumerate() {
        let path = |field: &str| format!("models[{index}].{field}");
        ensure(
            exact_text_ok(&model.id, 256) && !model.id.contains(['\n', '\t']),
            || path("id"),
        )?;
        ensure(ids.insert(model.id.as_str()), || path("id"))?;
        if let Some(capabilities) = &model.capabilities {
            ensure(capabilities.len() <= 7, || path("capabilities"))?;
        }
        if let Some(contract) = &model.embedding_contract {
            ensure(model_type == Some(ModelType::Embeddings), || {
                path("embeddingContract")
            })?;
            ensure(
                exact_text_ok(&contract.model, 256)
                    && exact_text_ok(&contract.revision, 256)
                    && exact_text_ok(&contract.vector_space, 256)
                    && (1..=1_000_000).contains(&contract.dimensions),
                || path("embeddingContract"),
            )?;
        }
        if let Some(profile) = &model.transcription {
            ensure(model_type == Some(ModelType::Transcription), || {
                path("transcription")
            })?;
            ensure(transcription_ok(profile), || path("transcription"))?;
        }
    }
    Ok(())
}

fn transcription_ok(profile: &TranscriptionProfile) -> bool {
    let tokens = |values: &Option<Vec<String>>, max: usize| {
        values.as_ref().is_none_or(|values| {
            values.len() <= max
                && values.iter().all(|value| {
                    !value.is_empty()
                        && value.len() <= 64
                        && value
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_.+/-".contains(&b))
                })
        })
    };
    tokens(&profile.response_formats, 8)
        && tokens(&profile.timestamp_granularities, 4)
        && tokens(&profile.languages, 128)
        && tokens(&profile.accepted_mime_types, 16)
        && profile.max_upload_bytes.is_none_or(|bytes| bytes > 0)
        && profile.realtime.as_ref().is_none_or(|realtime| {
            realtime
                .max_item_seconds
                .is_none_or(|seconds| (5..=600).contains(&seconds))
                && realtime
                    .max_sessions
                    .is_none_or(|sessions| (1..=8).contains(&sessions))
        })
}

fn header_name_ok(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn validate_address(address: &Address, runtime_hosts: &[String]) -> Check {
    if let Some(auth) = &address.auth {
        ensure(
            (auth.mode == crate::protocol::runtime_spec::AuthMode::Header) == auth.header.is_some()
                && auth.header.as_deref().is_none_or(header_name_ok),
            || "address.auth.header".into(),
        )?;
        if !is_secret_name(&auth.env) {
            return Err(SpecIssue::EnvNotAllowed("address.auth.env".into()));
        }
    }
    if let Some(headers) = &address.headers {
        ensure(headers.len() <= 16, || "address.headers".into())?;
        for (index, header) in headers.iter().enumerate() {
            ensure(header_name_ok(&header.name), || {
                format!("address.headers[{index}].name")
            })?;
            if !is_secret_name(&header.env) {
                return Err(SpecIssue::EnvNotAllowed(format!(
                    "address.headers[{index}].env"
                )));
            }
        }
    }
    check_base_url(&address.base_url, runtime_hosts)
}

/// `http(s)://host[:port][/prefix]` written in normalized form, host
/// `localhost` or an IP literal, and allowed here: loopback, or an IP
/// literal listed in `runtimeHosts` (`ip` or `ip:port`). Hostnames are never
/// accepted, so DNS rebinding cannot redirect the node.
pub fn check_base_url(value: &str, runtime_hosts: &[String]) -> Check {
    let path = || invalid("address.baseUrl");
    let url = url::Url::parse(value).map_err(|_| path())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || value.contains('#')
        || value.len() > 2048
    {
        return Err(path());
    }
    let host = url.host().ok_or_else(path)?;
    let ip = match host {
        url::Host::Domain("localhost") => None,
        url::Host::Domain(_) => return Err(path()),
        url::Host::Ipv4(ip) => Some(IpAddr::V4(ip)),
        url::Host::Ipv6(ip) => Some(IpAddr::V6(ip)),
    };
    let normalized = if url.path() == "/" {
        url.origin().ascii_serialization()
    } else {
        format!("{}{}", url.origin().ascii_serialization(), url.path())
    };
    if value != normalized {
        return Err(path());
    }
    if url.path() != "/" {
        let plain = url.path().split('/').skip(1).all(|segment| {
            segment
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_alphanumeric() || b"_~-".contains(&b))
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._~-".contains(&b))
        });
        if !plain {
            return Err(path());
        }
    }
    let Some(ip) = ip else {
        return Ok(());
    };
    if ip.is_loopback() {
        return Ok(());
    }
    let port = url.port_or_known_default();
    if runtime_hosts
        .iter()
        .any(|entry| runtime_host_matches(entry, ip, port))
    {
        Ok(())
    } else {
        Err(SpecIssue::BaseUrlNotAllowed("address.baseUrl".into()))
    }
}

/// A `runtimeHosts` entry (`1.2.3.4`, `1.2.3.4:8000`, `[::1]`, `[fd00::1]:8000`).
pub fn parse_runtime_host(entry: &str) -> Option<(IpAddr, Option<u16>)> {
    if let Some(rest) = entry.strip_prefix('[') {
        let (ip, tail) = rest.split_once(']')?;
        let ip = ip.parse::<std::net::Ipv6Addr>().ok()?;
        let port = match tail {
            "" => None,
            tail => Some(tail.strip_prefix(':')?.parse().ok()?),
        };
        return Some((IpAddr::V6(ip), port));
    }
    match entry.split_once(':') {
        Some((ip, port)) => Some((IpAddr::V4(ip.parse().ok()?), Some(port.parse().ok()?))),
        None => Some((IpAddr::V4(entry.parse().ok()?), None)),
    }
}

fn runtime_host_matches(entry: &str, ip: IpAddr, port: Option<u16>) -> bool {
    parse_runtime_host(entry).is_some_and(|(allowed, allowed_port)| {
        allowed == ip && allowed_port.is_none_or(|p| Some(p) == port)
    })
}

fn validate_launch(launch: &Launch, serves: bool) -> Check {
    let group = usize::from(launch.group_size);
    ensure((1..=RUNTIME_GROUP_SIZE_MAX).contains(&group), || {
        "launch.groupSize".into()
    })?;
    for (key, len) in [
        ("resources", launch.resources.len()),
        ("commands", launch.commands.len()),
    ] {
        ensure(len == 1 || len == group, || format!("launch.{key}"))?;
        ensure((1..=RUNTIME_GROUP_SIZE_MAX).contains(&len), || {
            format!("launch.{key}")
        })?;
    }
    for (index, resource) in launch.resources.iter().enumerate() {
        let ok = match resource {
            Resource::None {} => true,
            Resource::Unified { memory_gb } => gib_ok(*memory_gb),
            Resource::Cpu { ram_gb } => gib_ok(*ram_gb),
            Resource::Discrete {
                gpu_count,
                vram_gb,
                ram_gb,
                ..
            } => (1..=256).contains(gpu_count) && gib_ok(*vram_gb) && ram_gb.is_none_or(gib_ok),
        };
        ensure(ok, || format!("launch.resources[{index}]"))?;
    }
    let mut labels = BTreeSet::new();
    ensure(launch.labels.len() <= RUNTIME_LABELS_MAX, || {
        "launch.labels".into()
    })?;
    for label in &launch.labels {
        ensure(label_ok(label) && labels.insert(label), || {
            "launch.labels".into()
        })?;
    }
    if let Some(port) = launch.port {
        ensure(port.fixed >= 1024 && group == 1, || "launch.port".into())?;
    }
    if let Some(fabric) = &launch.fabric {
        ensure(label_ok(fabric) && group > 1, || "launch.fabric".into())?;
    }
    if let Some(secrets) = &launch.secrets {
        ensure(secrets.len() <= NODE_SECRETS_MAX, || {
            "launch.secrets".into()
        })?;
        let unique: BTreeSet<&String> = secrets.iter().collect();
        ensure(unique.len() == secrets.len(), || "launch.secrets".into())?;
        for (index, name) in secrets.iter().enumerate() {
            if !is_secret_name(name) {
                return Err(SpecIssue::EnvNotAllowed(format!("launch.secrets[{index}]")));
            }
        }
    }
    if let Some(readiness) = &launch.readiness {
        ensure(
            route_ok(&readiness.path)
                && (200..=399).contains(&readiness.expected_status)
                && (1_000..=3_600_000).contains(&readiness.timeout_ms),
            || "launch.readiness".into(),
        )?;
    } else if serves {
        return Err(invalid("launch.readiness"));
    } else {
        ensure(
            launch
                .commands
                .iter()
                .all(|commands| commands.status.is_some() || commands.health.is_some()),
            || "launch.readiness".into(),
        )?;
    }
    let health = launch.health;
    ensure(
        (5_000..=300_000).contains(&health.interval_ms)
            && (1..=20).contains(&health.failure_threshold)
            && (1..=20).contains(&health.success_threshold),
        || "launch.health".into(),
    )?;
    for (index, commands) in launch.commands.iter().enumerate() {
        validate_commands(commands, launch.management, index)?;
    }
    Ok(())
}

fn validate_commands(commands: &Commands, management: Management, index: usize) -> Check {
    let path = |field: &str| format!("launch.commands[{index}].{field}");
    for (field, command) in [
        ("start", Some(&commands.start)),
        ("stop", Some(&commands.stop)),
        ("prepare", commands.prepare.as_ref()),
        ("afterJoin", commands.after_join.as_ref()),
        ("status", commands.status.as_ref()),
        ("health", commands.health.as_ref()),
    ] {
        if let Some(command) = command {
            ensure(command_ok(command), || path(field))?;
        }
    }
    if management == Management::Service {
        ensure(commands.status.is_some(), || path("status"))?;
    }
    if let Some(interactive) = commands.interactive {
        let flags = [
            interactive.start,
            interactive.stop,
            interactive.prepare,
            interactive.after_join,
        ];
        ensure(flags.iter().all(|flag| *flag != Some(false)), || {
            path("interactive")
        })?;
        if flags.contains(&Some(true)) {
            ensure(commands.status.is_some(), || path("status"))?;
        }
        if interactive.start.is_some() || interactive.after_join.is_some() {
            ensure(management == Management::Service, || {
                "launch.management".into()
            })?;
        }
        if interactive.prepare.is_some() {
            ensure(commands.prepare.is_some(), || path("interactive.prepare"))?;
        }
        if interactive.after_join.is_some() {
            ensure(commands.after_join.is_some(), || {
                path("interactive.afterJoin")
            })?;
        }
    }
    if let Some(timeouts) = commands.timeouts_sec {
        for (field, value, max) in [
            ("prepare", timeouts.prepare, 86_400),
            ("start", timeouts.start, 3_600),
            ("afterJoin", timeouts.after_join, 3_600),
            ("stop", timeouts.stop, 3_600),
            ("status", timeouts.status, 3_600),
        ] {
            ensure(value.is_none_or(|secs| (1..=max).contains(&secs)), || {
                path(&format!("timeoutsSec.{field}"))
            })?;
        }
    }
    Ok(())
}

fn reader_entry_ok(entry: &ReaderMapEntry) -> bool {
    exact_text_ok(&entry.series, 256)
        && entry.labels.as_ref().is_none_or(|labels| {
            labels.len() <= 16
                && labels.iter().all(|(name, value)| {
                    series_name_ok(name) && (1..=64).contains(&value.chars().count())
                })
        })
        && entry.scale.is_none_or(canonical_number)
        && entry
            .divide_by
            .as_deref()
            .is_none_or(|divide| exact_text_ok(divide, 256))
}

fn validate_reader(reader: &MetricsReader) -> Check {
    match reader {
        MetricsReader::Builtin {} => Ok(()),
        MetricsReader::Route {
            route,
            interval_secs,
            map,
            count_route,
            ..
        } => {
            ensure(route_ok(route), || "metricsReader.route".into())?;
            ensure(count_route.as_deref().is_none_or(route_ok), || {
                "metricsReader.countRoute".into()
            })?;
            ensure(interval_secs.is_none_or(|s| (2..=60).contains(&s)), || {
                "metricsReader.intervalSecs".into()
            })?;
            ensure(map.values().all(reader_entry_ok), || {
                "metricsReader.map".into()
            })
        }
        MetricsReader::Command {
            command,
            interval_secs,
            map,
            ..
        } => {
            ensure(command_ok(command), || "metricsReader.command".into())?;
            ensure(interval_secs.is_none_or(|s| (2..=60).contains(&s)), || {
                "metricsReader.intervalSecs".into()
            })?;
            ensure(map.values().all(reader_entry_ok), || {
                "metricsReader.map".into()
            })
        }
    }
}

// ── The node part ──

fn metric_name_ok(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

pub fn validate_metric_commands(commands: &[NodeMetricCommand]) -> Check {
    ensure(commands.len() <= NODE_METRIC_COMMANDS_MAX, || {
        "node.metricCommands".into()
    })?;
    let mut names = BTreeSet::new();
    for (index, command) in commands.iter().enumerate() {
        let path = |field: &str| format!("node.metricCommands.commands[{index}].{field}");
        ensure(
            metric_name_ok(&command.name) && names.insert(&command.name),
            || path("name"),
        )?;
        ensure(command_ok(&command.command), || path("command"))?;
        ensure((5..=3_600).contains(&command.interval_secs), || {
            path("intervalSecs")
        })?;
        ensure((1..=60).contains(&command.timeout_secs), || {
            path("timeoutSecs")
        })?;
        if let Some(map) = &command.map {
            ensure(
                map.len() <= 16
                    && map.iter().all(|(name, entry)| {
                        series_name_ok(name)
                            && !["node.", "endpoint.", "runtime."]
                                .iter()
                                .any(|prefix| name.starts_with(prefix))
                            && reader_entry_ok(entry)
                    }),
                || path("map"),
            )?;
        }
    }
    Ok(())
}

/// A fabric address: the shared canonical IP-literal rule (no brackets,
/// never unspecified, loopback or IPv4-mapped).
pub fn fabric_ip_ok(value: &str) -> bool {
    is_fabric_ip(value)
}

fn fabric_id_ok(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn validate_fabrics(sets: &[FabricSet]) -> Check {
    ensure(sets.len() <= NODE_FABRICS_MAX, || "node.fabrics".into())?;
    let mut names = BTreeSet::new();
    let mut ids = BTreeSet::new();
    for (index, set) in sets.iter().enumerate() {
        ensure(
            fabric_id_ok(&set.fabric_id)
                && ids.insert(&set.fabric_id)
                && label_ok(&set.name)
                && names.insert(&set.name)
                && fabric_ip_ok(&set.self_ip)
                && (1..=FABRIC_MEMBERS_MAX).contains(&set.member_ips.len())
                && set.member_ips.iter().all(|ip| fabric_ip_ok(ip))
                && set.member_ips.contains(&set.self_ip),
            || format!("node.fabrics.sets[{index}]"),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(value: serde_json::Value) -> RuntimeSpec {
        serde_json::from_value(value).expect("spec shape")
    }

    fn always_on(base_url: &str) -> serde_json::Value {
        serde_json::json!({
            "api": "openai", "engine": "vllm", "modelType": "llm",
            "address": { "baseUrl": base_url }
        })
    }

    fn startable(start: &str) -> serde_json::Value {
        serde_json::json!({
            "api": "openai", "engine": "vllm", "modelType": "llm",
            "models": [{ "id": "m" }],
            "launch": {
                "management": "process", "groupSize": 1,
                "resources": [{ "kind": "none" }], "labels": [],
                "commands": [{ "start": start, "stop": "true" }],
                "readiness": { "path": "/health", "expectedStatus": 200, "timeoutMs": 60000 },
                "health": { "intervalMs": 30000, "failureThreshold": 3, "successThreshold": 1 }
            }
        })
    }

    #[test]
    fn base_urls_are_loopback_or_listed_ip_literals_in_normal_form() {
        for ok in [
            "http://127.0.0.1:8000/v1",
            "http://localhost:11434",
            "http://[::1]:8080",
            "https://127.0.0.2/api/v1",
        ] {
            assert_eq!(validate_spec(&spec(always_on(ok)), &[]), Ok(()), "{ok}");
        }
        for bad in [
            "http://example.com:8000",
            "http://127.0.0.1:8000/",
            "http://127.0.0.1:8000/v1/",
            "http://user:pw@127.0.0.1:8000",
            "http://127.0.0.1:8000/v1?x=1",
            "http://127.0.0.1:8000/v1#x",
            "ftp://127.0.0.1",
            "HTTP://127.0.0.1:8000",
            "http://2130706433:8000",
            "http://127.0.0.1:8000/v1/../admin",
            "http://127.0.0.1:8000/%2e%2e",
        ] {
            assert!(
                matches!(
                    validate_spec(&spec(always_on(bad)), &[]),
                    Err(SpecIssue::Invalid(_))
                ),
                "{bad}"
            );
        }
        let lan = spec(always_on("http://10.0.0.5:8000/v1"));
        assert_eq!(
            validate_spec(&lan, &[]),
            Err(SpecIssue::BaseUrlNotAllowed("address.baseUrl".into()))
        );
        assert_eq!(validate_spec(&lan, &["10.0.0.5:8000".into()]), Ok(()));
        assert_eq!(validate_spec(&lan, &["10.0.0.5".into()]), Ok(()));
        assert!(validate_spec(&lan, &["10.0.0.5:9000".into()]).is_err());
        assert!(validate_spec(&lan, &["10.0.0.6".into()]).is_err());
    }

    #[test]
    fn commands_refuse_hidden_characters_and_unknown_placeholders() {
        assert_eq!(
            validate_spec(&spec(startable("vllm serve m --port {{port}}")), &[]),
            Ok(())
        );
        for bad in [
            "vllm serve m --port {{port}} {{evil}}",
            "echo \u{202E}txt.exe",
            "echo a\u{200B}b",
            "echo\u{0007}",
            "   ",
        ] {
            assert_eq!(
                validate_spec(&spec(startable(bad)), &[]),
                Err(SpecIssue::Invalid("launch.commands[0].start".into())),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn the_service_shape_is_enforced() {
        // A service: no api/engine/modelType, status per rank, no readiness.
        let mut service = startable("run");
        let object = service.as_object_mut().expect("object");
        for key in ["api", "engine", "modelType", "models"] {
            object.remove(key);
        }
        object["launch"]
            .as_object_mut()
            .expect("launch")
            .remove("readiness");
        object["launch"]["commands"][0]["status"] = "systemctl --user is-active x".into();
        assert_eq!(validate_spec(&spec(service.clone()), &[]), Ok(()));
        // api without models is refused; models without readiness too.
        let mut partial = service.clone();
        partial["api"] = "openai".into();
        assert!(validate_spec(&spec(partial), &[]).is_err());
        let mut unready = startable("run");
        unready["launch"]
            .as_object_mut()
            .expect("launch")
            .remove("readiness");
        assert_eq!(
            validate_spec(&spec(unready), &[]),
            Err(SpecIssue::Invalid("launch.readiness".into()))
        );
        // A service without status or health proof.
        service["launch"]["commands"][0]
            .as_object_mut()
            .expect("commands")
            .remove("status");
        assert!(validate_spec(&spec(service), &[]).is_err());
    }

    #[test]
    fn launch_cross_field_rules() {
        let mut fixed_multi = startable("run");
        fixed_multi["launch"]["groupSize"] = 2.into();
        fixed_multi["launch"]["port"] = serde_json::json!({ "fixed": 8000 });
        assert!(validate_spec(&spec(fixed_multi), &[]).is_err());
        let mut low_port = startable("run");
        low_port["launch"]["port"] = serde_json::json!({ "fixed": 80 });
        assert!(validate_spec(&spec(low_port), &[]).is_err());
        let mut fabric_single = startable("run");
        fabric_single["launch"]["fabric"] = "qsfp".into();
        assert!(validate_spec(&spec(fabric_single), &[]).is_err());
        let mut three_commands = startable("run");
        three_commands["launch"]["groupSize"] = 2.into();
        three_commands["launch"]["commands"] = serde_json::json!([
            {"start":"a","stop":"b"},{"start":"a","stop":"b"},{"start":"a","stop":"b"}
        ]);
        assert!(validate_spec(&spec(three_commands), &[]).is_err());
        let mut old_secret = startable("run");
        old_secret["launch"]["secrets"] = serde_json::json!(["WSMP_ENDPOINT_X"]);
        assert!(matches!(
            validate_spec(&spec(old_secret), &[]),
            Err(SpecIssue::EnvNotAllowed(_))
        ));
    }

    #[test]
    fn slugs_and_fabric_addresses() {
        assert!(runtime_slug_ok("qwen3-32b"));
        assert!(!runtime_slug_ok("i-abcdef123456"));
        assert!(!runtime_slug_ok("Qwen"));
        assert!(!runtime_slug_ok("a--b"));
        assert!(fabric_ip_ok("10.0.0.5"));
        assert!(fabric_ip_ok("fd00::5"));
        for bad in [
            "[fd00::5]",
            "0.0.0.0",
            "::",
            "127.0.0.1",
            "::1",
            "host",
            "10.0.0.5:80",
        ] {
            assert!(!fabric_ip_ok(bad), "{bad}");
        }
    }

    #[test]
    fn runtime_hosts_parse() {
        assert!(parse_runtime_host("10.0.0.5").is_some());
        assert!(parse_runtime_host("10.0.0.5:8000").is_some());
        assert!(parse_runtime_host("[fd00::1]:8000").is_some());
        assert!(parse_runtime_host("example.com").is_none());
        assert!(parse_runtime_host("10.0.0.5:x").is_none());
    }
}
