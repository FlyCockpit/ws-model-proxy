//! Held definitions: every server-origin runtime version the node was sent
//! and not told to drop, keyed by `versionId`, plus the node's own definition
//! (port range, metric commands, fabrics, command lifetime).
//!
//! - `runtime-store.json` (state dir, 0600): the live set, changed only by
//!   `runtime.define` at Full control.
//! - `frozen-definitions.json`: the copy taken when the node becomes Relay
//!   only. At Relay only, jobs render, metric commands run and fabric checks
//!   read from this copy alone, and `runtime.define` is refused; raising trust
//!   deletes it (the server re-syncs).
//!
//! Specs are stored exactly as received (raw JSON) so `launchHash` can be
//! recomputed byte for byte; the typed form is parsed on use.

pub mod validate;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::protocol::canonical::{canonical_sha256, launch_hash};
use crate::protocol::frames::{
    DEFINE_CHUNK_MAX_VERSIONS, DefineEntryResult, DefineNodeResult, DefineRejectReason,
    DefineStatus, DefinitionEnvelope, FabricSet, FabricsPush, HeldDefinition, MetricCommandsPush,
    NodeDefinition, NodeFrame, ServerFrame, TrustValue,
};
use crate::protocol::runtime_spec::{
    NodeMetricCommand, RUNTIME_DEFINITIONS_MAX, RuntimeKind, RuntimeSpec,
};
use validate::SpecIssue;

const STORE_FILE: &str = "runtime-store.json";
const FROZEN_FILE: &str = "frozen-definitions.json";
const STORE_VERSION: u32 = 1;
const STORE_MAX_BYTES: u64 = 16 * 1024 * 1024;
/// Define operations one session keeps open at once.
const OPEN_OPS_MAX: usize = 8;

/// One held version, its spec exactly as received.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldVersion {
    pub runtime_id: String,
    pub version_id: String,
    pub launch_hash: String,
    pub kind: RuntimeKind,
    pub slug: String,
    pub spec: Value,
}

impl HeldVersion {
    pub fn parsed(&self) -> Result<RuntimeSpec> {
        serde_json::from_value(self.spec.clone()).context("parsing a held definition")
    }

    pub fn held(&self) -> HeldDefinition {
        HeldDefinition {
            runtime_id: self.runtime_id.clone(),
            version_id: self.version_id.clone(),
            launch_hash: self.launch_hash.clone(),
        }
    }
}

/// The node's own definition as last received.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePart {
    pub port_range: [u16; 2],
    pub metric_commands: MetricCommandsPush,
    pub fabrics: FabricsPush,
    pub command_max_ms: u64,
}

impl From<NodeDefinition> for NodePart {
    fn from(node: NodeDefinition) -> Self {
        Self {
            port_range: node.port_range,
            metric_commands: node.metric_commands,
            fabrics: node.fabrics,
            command_max_ms: node.command_max_ms,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Store {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub held: Vec<HeldVersion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<NodePart>,
}

impl Store {
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(error) => {
                return Err(error).with_context(|| format!("reading `{}`", path.display()));
            }
        };
        anyhow::ensure!(
            bytes.len() as u64 <= STORE_MAX_BYTES,
            "`{}` is too large",
            path.display()
        );
        let store: Self = serde_json::from_slice(&bytes)
            .with_context(|| format!("parsing `{}`", path.display()))?;
        anyhow::ensure!(
            store.version == STORE_VERSION,
            "`{}` has an unknown version",
            path.display()
        );
        Ok(store)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let mut store = self.clone();
        store.version = STORE_VERSION;
        let mut bytes =
            serde_json::to_vec_pretty(&store).context("serializing held definitions")?;
        bytes.push(b'\n');
        crate::approvals::write_private_atomic(path, &bytes, "held definitions", false).map(|_| ())
    }

    pub fn held_definitions(&self) -> Vec<HeldDefinition> {
        self.held.iter().map(HeldVersion::held).collect()
    }

    /// The version a job names, only when its hash matches too.
    pub fn find(&self, version_id: &str, launch_hash: &str) -> Option<&HeldVersion> {
        self.held
            .iter()
            .find(|held| held.version_id == version_id && held.launch_hash == launch_hash)
    }

    pub fn metric_commands_hash(&self) -> Option<String> {
        self.node
            .as_ref()
            .map(|node| node.metric_commands.hash.clone())
    }

    pub fn port_range(&self) -> Option<[u16; 2]> {
        self.node.as_ref().map(|node| node.port_range)
    }

    pub fn fabrics_hash(&self) -> Option<String> {
        self.node.as_ref().map(|node| node.fabrics.hash.clone())
    }

    pub fn fabric(&self, fabric_id: &str) -> Option<&FabricSet> {
        self.node
            .as_ref()?
            .fabrics
            .sets
            .iter()
            .find(|set| set.fabric_id == fabric_id)
    }

    pub fn metric_commands(&self) -> &[NodeMetricCommand] {
        self.node
            .as_ref()
            .map_or(&[], |node| node.metric_commands.commands.as_slice())
    }

    pub fn command_max_ms(&self) -> Option<u64> {
        self.node.as_ref().map(|node| node.command_max_ms)
    }

    /// Always-on server-origin versions, newest received last.
    pub fn always_on(&self) -> impl Iterator<Item = &HeldVersion> {
        self.held
            .iter()
            .filter(|held| held.kind == RuntimeKind::AlwaysOn)
    }
}

pub fn live_path() -> Result<PathBuf> {
    Ok(crate::paths::state_dir()?.join(STORE_FILE))
}

pub fn frozen_path() -> Result<PathBuf> {
    Ok(crate::paths::state_dir()?.join(FROZEN_FILE))
}

/// The set the node acts on at `trust`: the frozen copy at Relay only (the
/// live set when nothing was frozen yet, which Relay only never changes).
pub fn load_for(trust: TrustValue) -> Result<Store> {
    load_for_at(trust, &live_path()?, &frozen_path()?)
}

fn load_for_at(trust: TrustValue, live: &Path, frozen: &Path) -> Result<Store> {
    if trust == TrustValue::Relay && frozen.exists() {
        return Store::load(frozen);
    }
    Store::load(live)
}

/// Copy the live set to the frozen copy (once: an existing copy stays).
pub fn freeze() -> Result<()> {
    freeze_at(&live_path()?, &frozen_path()?)
}

fn freeze_at(live: &Path, frozen: &Path) -> Result<()> {
    if frozen.exists() {
        return Ok(());
    }
    Store::load(live)?.save(frozen)
}

/// Replace the frozen copy with today's held set (a Full to Relay change).
pub fn freeze_now() -> Result<()> {
    Store::load(&live_path()?)?.save(&frozen_path()?)
}

/// An empty frozen copy (fail closed when the live set cannot be read).
pub fn freeze_empty() -> Result<()> {
    Store::default().save(&frozen_path()?)
}

/// Drop the frozen copy (raising trust).
pub fn unfreeze() -> Result<()> {
    let path = frozen_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("removing `{}`", path.display())),
    }
}

// ── runtime.define ──

/// What the daemon needs to judge a define.
pub struct DefineContext<'a> {
    pub trust: TrustValue,
    pub runtime_hosts: &'a [String],
    /// Ports of live instances, by the runtime they run.
    pub busy_ports: &'a BTreeMap<u16, String>,
}

struct PendingOp {
    next_chunk: u32,
    complete: bool,
    staged: Vec<HeldVersion>,
    keep: BTreeSet<String>,
    remove: BTreeSet<String>,
    node: Option<NodePart>,
}

/// Define operations in progress on one connection.
#[derive(Default)]
pub struct Defines {
    ops: BTreeMap<String, PendingOp>,
}

/// One define chunk's answer, and the store after the final chunk.
pub struct DefineOutcome {
    pub answer: NodeFrame,
    /// The live set changed (the daemon reloads and re-sends inventory).
    pub changed: bool,
}

impl Defines {
    /// Answer one `runtime.define` chunk. `text` is the frame as received
    /// (its `put[].spec` is hashed exactly as sent).
    pub fn handle(
        &mut self,
        text: &str,
        frame: &ServerFrame,
        ctx: &DefineContext<'_>,
        live: &Path,
    ) -> Result<DefineOutcome> {
        let ServerFrame::RuntimeDefine {
            op_id,
            chunk_index,
            is_final,
            put,
            keep,
            remove,
            complete,
            node,
        } = frame
        else {
            anyhow::bail!("not a runtime.define frame");
        };
        let raw: Value = serde_json::from_str(text).context("re-reading a runtime.define")?;
        let raw_puts = raw
            .get("put")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let puts = put.as_deref().unwrap_or_default();
        anyhow::ensure!(raw_puts.len() == puts.len(), "runtime.define put mismatch");
        let current = Store::load(live)?;

        if ctx.trust != TrustValue::Full {
            self.ops.remove(op_id);
            let results = puts
                .iter()
                .map(|envelope| rejected(envelope, DefineRejectReason::TrustRelay, None))
                .collect();
            let frozen = load_for(TrustValue::Relay).unwrap_or(current);
            return Ok(DefineOutcome {
                answer: answer(
                    op_id,
                    *chunk_index,
                    *is_final,
                    results,
                    node.as_ref().map(|_| DefineNodeResult {
                        status: DefineStatus::Rejected,
                        reason: Some(DefineRejectReason::TrustRelay),
                    }),
                    &frozen,
                    true,
                ),
                changed: false,
            });
        }

        if *chunk_index == 0 {
            if self.ops.len() >= OPEN_OPS_MAX && !self.ops.contains_key(op_id) {
                // Forget the oldest unfinished operation; the server retries.
                if let Some(oldest) = self.ops.keys().next().cloned() {
                    self.ops.remove(&oldest);
                }
            }
            self.ops.insert(
                op_id.clone(),
                PendingOp {
                    next_chunk: 0,
                    complete: complete.unwrap_or(false),
                    staged: Vec::new(),
                    keep: BTreeSet::new(),
                    remove: BTreeSet::new(),
                    node: None,
                },
            );
        }
        let op = self
            .ops
            .get_mut(op_id)
            .filter(|op| op.next_chunk == *chunk_index && op.complete == complete.unwrap_or(false));
        let Some(op) = op else {
            self.ops.remove(op_id);
            anyhow::bail!("runtime.define chunks out of order");
        };
        op.next_chunk += 1;
        op.keep.extend(keep.iter().flatten().cloned());
        op.remove.extend(remove.iter().flatten().cloned());

        let mut results = Vec::new();
        for (envelope, raw_put) in puts.iter().zip(&raw_puts) {
            let raw_spec = raw_put.get("spec").cloned().unwrap_or(Value::Null);
            results.push(stage(op, &current, envelope, raw_spec, ctx));
        }
        for version_id in remove.iter().flatten() {
            if let Some(held) = current.held.iter().find(|h| &h.version_id == version_id) {
                results.push(DefineEntryResult {
                    runtime_id: held.runtime_id.clone(),
                    version_id: version_id.clone(),
                    status: DefineStatus::Removed,
                    reason: None,
                    detail: None,
                });
            }
        }
        results.truncate(DEFINE_CHUNK_MAX_VERSIONS);
        let node_result = node.as_ref().map(|node| {
            let raw_node = raw.get("node").cloned().unwrap_or(Value::Null);
            match check_node(node, &raw_node) {
                Ok(()) => {
                    let part = NodePart::from(node.clone());
                    let status = if current.node.as_ref() == Some(&part) {
                        DefineStatus::Unchanged
                    } else {
                        DefineStatus::Applied
                    };
                    op.node = Some(part);
                    DefineNodeResult {
                        status,
                        reason: None,
                    }
                }
                Err(reason) => DefineNodeResult {
                    status: DefineStatus::Rejected,
                    reason: Some(reason),
                },
            }
        });

        if !*is_final {
            return Ok(DefineOutcome {
                answer: answer(
                    op_id,
                    *chunk_index,
                    false,
                    results,
                    node_result,
                    &current,
                    false,
                ),
                changed: false,
            });
        }
        let Some(op) = self.ops.remove(op_id) else {
            anyhow::bail!("runtime.define operation vanished");
        };
        let next = apply(&current, op);
        let changed = next != current;
        if changed {
            next.save(live)?;
            log_define(&current, &next);
        }
        Ok(DefineOutcome {
            answer: answer(
                op_id,
                *chunk_index,
                true,
                results,
                node_result,
                &next,
                false,
            ),
            changed,
        })
    }
}

fn log_define(before: &Store, after: &Store) {
    let before_ids: BTreeSet<&str> = before.held.iter().map(|h| h.version_id.as_str()).collect();
    let after_ids: BTreeSet<&str> = after.held.iter().map(|h| h.version_id.as_str()).collect();
    let added = after_ids.difference(&before_ids).count();
    let removed = before_ids.difference(&after_ids).count();
    tracing::info!(
        added,
        removed,
        held = after.held.len(),
        node_changed = before.node != after.node,
        "applied runtime definitions"
    );
    for held in &after.held {
        if before_ids.contains(held.version_id.as_str()) {
            continue;
        }
        if let Ok(spec) = held.parsed()
            && binds_all_interfaces(&spec)
        {
            tracing::warn!(
                runtime = held.slug,
                version_id = held.version_id,
                "this definition binds 0.0.0.0 or ::, which exposes the server beyond this machine; bind 127.0.0.1 (or {{fabric_ip}} for multi-node)"
            );
        }
    }
}

/// `binds_all_interfaces` (the server's `runtimeSpecWarnings`): a command or
/// address binds 0.0.0.0 or `::`.
pub fn binds_all_interfaces(spec: &RuntimeSpec) -> bool {
    let mut texts: Vec<&str> = Vec::new();
    if let Some(address) = &spec.address {
        texts.push(&address.base_url);
    }
    for commands in spec.launch.iter().flat_map(|launch| &launch.commands) {
        texts.push(&commands.start);
        texts.extend(
            [
                &commands.stop,
                &commands.prepare,
                &commands.after_join,
                &commands.status,
                &commands.health,
            ]
            .into_iter()
            .flatten()
            .map(String::as_str),
        );
    }
    texts.iter().any(|text| has_all_interfaces(text))
}

fn has_all_interfaces(text: &str) -> bool {
    let before_ok = |prefix: &str| {
        prefix
            .chars()
            .last()
            .is_none_or(|c| c.is_whitespace() || "=:'\"(,/".contains(c))
    };
    let after_ok = |suffix: &str| {
        suffix
            .chars()
            .next()
            .is_none_or(|c| c.is_whitespace() || ":'\"/),]".contains(c))
    };
    let literal = ["0.0.0.0", "[::]", "::"].iter().any(|needle| {
        text.match_indices(needle)
            .any(|(index, _)| before_ok(&text[..index]) && after_ok(&text[index + needle.len()..]))
    });
    literal || vllm_serve_without_host(text)
}

/// `vllm serve` binds every interface unless the same command passes `--host`.
fn vllm_serve_without_host(text: &str) -> bool {
    text.match_indices("vllm").any(|(index, _)| {
        let before = text[..index].chars().last();
        if !before.is_none_or(|c| c.is_whitespace() || ";&|".contains(c)) {
            return false;
        }
        let rest = &text[index + 4..];
        let trimmed = rest.trim_start();
        if trimmed.len() == rest.len() || !trimmed.starts_with("serve") {
            return false;
        }
        let after = &trimmed[5..];
        if after
            .chars()
            .next()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
        {
            return false;
        }
        let command = after.split([';', '&', '|']).next().unwrap_or_default();
        !command
            .match_indices("--host")
            .any(|(at, _)| command[at + 6..].starts_with(|c: char| c.is_whitespace() || c == '='))
    })
}

fn rejected(
    envelope: &DefinitionEnvelope,
    reason: DefineRejectReason,
    detail: Option<String>,
) -> DefineEntryResult {
    DefineEntryResult {
        runtime_id: envelope.runtime_id.clone(),
        version_id: envelope.version_id.clone(),
        status: DefineStatus::Rejected,
        reason: Some(reason),
        detail,
    }
}

/// The node's view of the set after this operation, for conflict and limit
/// checks while staging.
fn projected<'a>(op: &'a PendingOp, current: &'a Store) -> Vec<&'a HeldVersion> {
    let mut set: Vec<&HeldVersion> = current
        .held
        .iter()
        .filter(|held| {
            if op.complete {
                op.keep.contains(&held.version_id)
            } else {
                !op.remove.contains(&held.version_id)
            }
        })
        .collect();
    set.extend(op.staged.iter());
    set
}

fn stage(
    op: &mut PendingOp,
    current: &Store,
    envelope: &DefinitionEnvelope,
    raw_spec: Value,
    ctx: &DefineContext<'_>,
) -> DefineEntryResult {
    match launch_hash(&raw_spec) {
        Ok(hash) if hash == envelope.launch_hash => {}
        Ok(_) => return rejected(envelope, DefineRejectReason::HashMismatch, None),
        Err(_) => {
            return rejected(
                envelope,
                DefineRejectReason::Invalid,
                Some("spec".to_string()),
            );
        }
    }
    if !validate::runtime_slug_ok(&envelope.slug) {
        return rejected(
            envelope,
            DefineRejectReason::Invalid,
            Some("slug".to_string()),
        );
    }
    if let Err(issue) = validate::validate_spec(&envelope.spec, ctx.runtime_hosts) {
        return match issue {
            SpecIssue::Invalid(path) => rejected(envelope, DefineRejectReason::Invalid, Some(path)),
            SpecIssue::BaseUrlNotAllowed(path) => {
                rejected(envelope, DefineRejectReason::BaseUrlNotAllowed, Some(path))
            }
            SpecIssue::EnvNotAllowed(path) => {
                rejected(envelope, DefineRejectReason::EnvNotAllowed, Some(path))
            }
        };
    }
    let known = current
        .held
        .iter()
        .chain(op.staged.iter())
        .find(|held| held.version_id == envelope.version_id)
        .map(|held| {
            (
                held.launch_hash.clone(),
                held.runtime_id.clone(),
                held.slug.clone(),
                held.kind,
            )
        });
    if let Some((hash, runtime_id, slug, kind)) = known {
        // A version never changes: the same id with another hash, runtime,
        // slug or kind conflicts.
        if hash != envelope.launch_hash
            || runtime_id != envelope.runtime_id
            || slug != envelope.slug
            || kind != envelope.kind
        {
            return rejected(
                envelope,
                DefineRejectReason::Conflict,
                Some("versionId".into()),
            );
        }
        if envelope.kind == RuntimeKind::AlwaysOn
            && projected(op, current)
                .iter()
                .any(|held| held.slug == envelope.slug && held.runtime_id != envelope.runtime_id)
        {
            return rejected(envelope, DefineRejectReason::Conflict, Some("slug".into()));
        }
        if !op
            .staged
            .iter()
            .any(|s| s.version_id == envelope.version_id)
        {
            op.staged.push(held_from(envelope, raw_spec));
        }
        return DefineEntryResult {
            runtime_id: envelope.runtime_id.clone(),
            version_id: envelope.version_id.clone(),
            status: DefineStatus::Unchanged,
            reason: None,
            detail: None,
        };
    }
    let set = projected(op, current);
    // An always-on runtime is addressed by its slug: one runtime per slug.
    if envelope.kind == RuntimeKind::AlwaysOn
        && set
            .iter()
            .any(|held| held.slug == envelope.slug && held.runtime_id != envelope.runtime_id)
    {
        return rejected(envelope, DefineRejectReason::Conflict, Some("slug".into()));
    }
    if let Some(port) = envelope.spec.launch.as_ref().and_then(|launch| launch.port)
        && ctx
            .busy_ports
            .get(&port.fixed)
            .is_some_and(|owner| owner != &envelope.runtime_id)
    {
        return rejected(
            envelope,
            DefineRejectReason::Conflict,
            Some("launch.port".into()),
        );
    }
    if set.len() >= RUNTIME_DEFINITIONS_MAX {
        return rejected(envelope, DefineRejectReason::Limit, None);
    }
    op.staged.push(held_from(envelope, raw_spec));
    DefineEntryResult {
        runtime_id: envelope.runtime_id.clone(),
        version_id: envelope.version_id.clone(),
        status: DefineStatus::Applied,
        reason: None,
        detail: None,
    }
}

fn held_from(envelope: &DefinitionEnvelope, raw_spec: Value) -> HeldVersion {
    HeldVersion {
        runtime_id: envelope.runtime_id.clone(),
        version_id: envelope.version_id.clone(),
        launch_hash: envelope.launch_hash.clone(),
        kind: envelope.kind,
        slug: envelope.slug.clone(),
        spec: raw_spec,
    }
}

fn check_node(node: &NodeDefinition, raw: &Value) -> Result<(), DefineRejectReason> {
    let [start, end] = node.port_range;
    if start < 1024 || start > end {
        return Err(DefineRejectReason::Invalid);
    }
    let raw_commands = raw
        .get("metricCommands")
        .and_then(|commands| commands.get("commands"))
        .ok_or(DefineRejectReason::Invalid)?;
    if canonical_sha256(raw_commands).ok().as_deref() != Some(node.metric_commands.hash.as_str()) {
        return Err(DefineRejectReason::HashMismatch);
    }
    let raw_sets = raw
        .get("fabrics")
        .and_then(|fabrics| fabrics.get("sets"))
        .ok_or(DefineRejectReason::Invalid)?;
    if canonical_sha256(raw_sets).ok().as_deref() != Some(node.fabrics.hash.as_str()) {
        return Err(DefineRejectReason::HashMismatch);
    }
    validate::validate_metric_commands(&node.metric_commands.commands)
        .map_err(|_| DefineRejectReason::Invalid)?;
    validate::validate_fabrics(&node.fabrics.sets).map_err(|_| DefineRejectReason::Invalid)
}

fn apply(current: &Store, op: PendingOp) -> Store {
    let mut held: Vec<HeldVersion> = current
        .held
        .iter()
        .filter(|held| {
            if op.complete {
                op.keep.contains(&held.version_id)
            } else {
                !op.remove.contains(&held.version_id)
            }
        })
        .cloned()
        .collect();
    for staged in op.staged {
        if !held.iter().any(|h| h.version_id == staged.version_id) {
            held.push(staged);
        }
    }
    held.truncate(RUNTIME_DEFINITIONS_MAX);
    Store {
        version: STORE_VERSION,
        held,
        node: op.node.or_else(|| current.node.clone()),
    }
}

fn answer(
    op_id: &str,
    chunk_index: u32,
    is_final: bool,
    results: Vec<DefineEntryResult>,
    node: Option<DefineNodeResult>,
    store: &Store,
    frozen: bool,
) -> NodeFrame {
    NodeFrame::RuntimeDefineResult {
        op_id: op_id.to_string(),
        chunk_index,
        is_final,
        results,
        node,
        held: is_final.then(|| store.held_definitions()),
        held_metric_commands_hash: is_final.then(|| store.metric_commands_hash()),
        held_port_range: is_final.then(|| store.port_range()),
        held_fabrics_hash: is_final.then(|| store.fabrics_hash()),
        frozen: is_final.then_some(frozen),
    }
}

#[cfg(test)]
mod tests;
