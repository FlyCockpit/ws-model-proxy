//! What this node holds and runs, read from its own files: the held
//! definitions (the frozen copy at Relay only) and the instance records.
//! Read only: nothing here writes a file or asks the relay. `wsmp runtime
//! list` and `wsmp status` show it.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::config::Config;
use crate::protocol::frames::{InstancePhase, JobPhase, TrustValue};
use crate::protocol::runtime_spec::{Engine, Management, ModelType, RuntimeApi, RuntimeKind};
use crate::runtime_store::{HeldVersion, Store};
use crate::runtimes::executor::{Executor, Job};

/// One runtime the node holds: its newest held version.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRow {
    pub slug: String,
    pub runtime_id: String,
    pub kind: RuntimeKind,
    pub version_id: String,
    /// Versions of this runtime the node holds (instances may run older ones).
    pub held_versions: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api: Option<RuntimeApi>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<Engine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_type: Option<ModelType>,
    pub models: Vec<String>,
    /// Always-on: where it listens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Startable: who proves its state (`process` or `service`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub management: Option<Management>,
    /// The held spec could not be parsed.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unreadable: bool,
}

/// One instance rank, as its record holds it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRow {
    pub instance_id: String,
    pub handle: String,
    pub rank: u8,
    /// The runtime's slug, when this node still holds a version of it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    pub runtime_id: String,
    pub version_id: String,
    /// The phase the record holds (not checked against the machine).
    pub phase: InstancePhase,
    /// A step still unresolved on this rank.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<JobPhase>,
    pub host: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dist_port: Option<u16>,
    pub unit: String,
    /// Units the run was launched in and not yet proven stopped.
    pub units: Vec<String>,
    pub models: Vec<String>,
    /// Stopping or stopped ranks, when asked: `proven`, or why the stop is
    /// not proven (`port_in_use`, `port_held_outside_runtime`, `process_alive`,
    /// `status_unknown`, ...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_proof: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalView {
    pub trust: TrustValue,
    /// `frozen` at Relay only once lowered, else `live`.
    pub definitions: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port_range: Option<[u16; 2]>,
    pub runtimes: Vec<RuntimeRow>,
    pub instances: Vec<InstanceRow>,
    /// Files that could not be read.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Read the node's view. `stop_proof`: also prove the stop of every stopping
/// or stopped rank the way the inventory does (it asks the user manager and
/// checks the rank's ports; no definition command runs).
pub fn load(config: &Config, stop_proof: bool) -> LocalView {
    let frozen = crate::runtime_store::frozen_path()
        .map(|path| path.exists())
        .unwrap_or(true);
    // As the relay starts: a frozen copy keeps the node Relay only.
    let trust = if frozen {
        TrustValue::Relay
    } else {
        crate::trust::configured(config)
    };
    let mut warnings = Vec::new();
    let store = crate::runtime_store::load_for(trust).unwrap_or_else(|error| {
        warnings.push(format!("held definitions: {error:#}"));
        Store::default()
    });
    let (executors, unreadable) = match crate::runtimes::executor::instances_dir() {
        Ok(dir) => crate::runtimes::executor::read_all(&dir),
        Err(error) => (Vec::new(), vec![format!("instance records: {error:#}")]),
    };
    warnings.extend(unreadable);
    let runtimes = runtime_rows(&store);
    let instances = instance_rows(&store, &executors, stop_proof);
    LocalView {
        trust,
        definitions: if trust == TrustValue::Relay && frozen {
            "frozen"
        } else {
            "live"
        },
        port_range: store.port_range(),
        runtimes,
        instances,
        warnings,
    }
}

/// One row per runtime: the newest held version (the last received).
pub fn runtime_rows(store: &Store) -> Vec<RuntimeRow> {
    let mut by_runtime: BTreeMap<&str, (usize, &HeldVersion)> = BTreeMap::new();
    for held in &store.held {
        let entry = by_runtime
            .entry(held.runtime_id.as_str())
            .or_insert((0, held));
        entry.0 += 1;
        entry.1 = held;
    }
    let mut rows: Vec<RuntimeRow> = by_runtime
        .into_values()
        .map(|(count, held)| {
            let spec = held.parsed().ok();
            RuntimeRow {
                slug: held.slug.clone(),
                runtime_id: held.runtime_id.clone(),
                kind: held.kind,
                version_id: held.version_id.clone(),
                held_versions: count,
                api: spec.as_ref().and_then(|spec| spec.api),
                engine: spec.as_ref().and_then(|spec| spec.engine),
                model_type: spec.as_ref().and_then(|spec| spec.model_type),
                models: spec
                    .as_ref()
                    .and_then(|spec| spec.models.as_ref())
                    .map(|models| models.iter().map(|model| model.id.clone()).collect())
                    .unwrap_or_default(),
                base_url: spec
                    .as_ref()
                    .and_then(|spec| spec.address.as_ref())
                    .map(|address| address.base_url.clone()),
                management: spec
                    .as_ref()
                    .and_then(|spec| spec.launch.as_ref())
                    .map(|launch| launch.management),
                unreadable: spec.is_none(),
            }
        })
        .collect();
    rows.sort_by(|a, b| a.slug.cmp(&b.slug).then(a.runtime_id.cmp(&b.runtime_id)));
    rows
}

fn slug_of<'a>(store: &'a Store, job: &Job) -> Option<&'a str> {
    store
        .held
        .iter()
        .rev()
        .find(|held| held.runtime_id == job.runtime_id)
        .map(|held| held.slug.as_str())
}

fn instance_rows(store: &Store, executors: &[Executor], stop_proof: bool) -> Vec<InstanceRow> {
    let mut rows = Vec::new();
    for executor in executors {
        for rank in executor.ranks() {
            let proof = (stop_proof
                && matches!(rank.phase, InstancePhase::Stopping | InstancePhase::Stopped))
            .then(|| prove(executor, &rank.job));
            let job = rank.job;
            rows.push(InstanceRow {
                runtime: slug_of(store, &job).map(str::to_string),
                models: job.models(),
                instance_id: job.instance_id,
                handle: job.handle,
                rank: job.rank,
                runtime_id: job.runtime_id,
                version_id: job.version_id,
                phase: rank.phase,
                pending: rank.pending,
                host: job.host,
                port: job.port,
                dist_port: job.dist_port,
                unit: job.unit_name,
                units: rank.units,
                stop_proof: proof,
            });
        }
    }
    rows.sort_by(|a, b| a.instance_id.cmp(&b.instance_id).then(a.rank.cmp(&b.rank)));
    rows
}

#[cfg(unix)]
fn prove(executor: &Executor, job: &Job) -> String {
    use std::time::Duration;

    use crate::runtimes::executor::{Deadline, NativeRuntime};
    let runtime = NativeRuntime { cancel: None };
    match executor.stop_unproven_now(job, &runtime, Deadline::new(Duration::from_secs(10))) {
        Ok(None) => "proven".to_string(),
        Ok(Some(reason)) => reason.to_string(),
        Err(_) => "unknown".to_string(),
    }
}

#[cfg(not(unix))]
fn prove(_executor: &Executor, _job: &Job) -> String {
    "unknown".to_string()
}

/// `snake_case` name of a serde enum value (phases, kinds, engines).
pub fn word<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(text)) => text,
        _ => "?".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn held(runtime: &str, version: &str, slug: &str, spec: serde_json::Value) -> HeldVersion {
        HeldVersion {
            runtime_id: runtime.into(),
            version_id: version.into(),
            launch_hash: "h".into(),
            kind: RuntimeKind::AlwaysOn,
            slug: slug.into(),
            spec,
        }
    }

    #[test]
    fn a_runtime_row_shows_its_newest_held_version() {
        let spec = serde_json::json!({
            "api": "openai", "engine": "ollama", "modelType": "llm",
            "models": [{ "id": "llama3" }],
            "address": { "baseUrl": "http://127.0.0.1:11434/v1" },
        });
        let store = Store {
            version: 1,
            held: vec![
                held("rt-b", "v1", "beta", serde_json::json!({ "bad": true })),
                held("rt-a", "v1", "alpha", spec.clone()),
                held("rt-a", "v2", "alpha", spec),
            ],
            node: None,
        };
        let rows = runtime_rows(&store);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].slug, "alpha");
        assert_eq!(rows[0].version_id, "v2");
        assert_eq!(rows[0].held_versions, 2);
        assert_eq!(rows[0].models, ["llama3"]);
        assert_eq!(
            rows[0].base_url.as_deref(),
            Some("http://127.0.0.1:11434/v1")
        );
        assert!(!rows[0].unreadable);
        assert_eq!(rows[1].slug, "beta");
        assert!(rows[1].unreadable);
        assert_eq!(word(&rows[0].kind), "always_on");
    }
}
