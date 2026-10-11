//! `runtime.inventory`: one chunked snapshot of the always-on runtimes this
//! node holds (probed for status and models) and its managed instances.
//! Built off the relay loop: probes take time.

use std::sync::mpsc::SyncSender;

use rand::distr::SampleString;

use crate::protocol::frames::{
    AlwaysOnInventory, AlwaysOnStatus, CHUNK_BUDGET_BYTES, InstanceRecord, NodeFrame,
    RUNTIME_INVENTORY_CHUNK_MAX,
};
use crate::relay_bus::FromWorker;
use crate::runtime_store::Store;

/// Probe every always-on runtime, then send the snapshot through `tx`.
pub(crate) fn spawn(tx: SyncSender<FromWorker>, store: Store, instances: Vec<InstanceRecord>) {
    let spawned = std::thread::Builder::new()
        .name("wsmp-inventory".into())
        .spawn(move || {
            let always_on = probe_always_on(&store);
            for frame in frames(always_on, instances) {
                match crate::protocol::encode_control(&frame) {
                    Ok(text) => {
                        if tx.send(FromWorker::Telemetry(text)).is_err() {
                            return;
                        }
                    }
                    Err(error) => tracing::warn!(
                        error = %format!("{error:#}"),
                        "encoding the runtime inventory failed"
                    ),
                }
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(error = %error, "starting the inventory worker failed");
    }
}

fn probe_always_on(store: &Store) -> Vec<AlwaysOnInventory> {
    super::endpoints::current_always_on(store)
        .into_iter()
        .filter_map(|(held, spec)| {
            let base_url = spec.address.as_ref()?.base_url.clone();
            let endpoint = super::endpoints::endpoint_for(&held.slug, &spec, base_url);
            let report = crate::probe::probe_endpoint(&endpoint);
            let status = match report.status {
                crate::config::ProbeStatus::Online => AlwaysOnStatus::Online,
                crate::config::ProbeStatus::Offline => AlwaysOnStatus::Offline,
            };
            Some(super::endpoints::always_on_entry(
                held,
                &spec,
                status,
                &report.discovered_model_ids,
            ))
        })
        .collect()
}

fn encoded(frame: &NodeFrame) -> usize {
    serde_json::to_vec(frame).map_or(usize::MAX, |bytes| bytes.len())
}

fn chunk(
    snapshot_id: &str,
    chunk_index: u32,
    always_on: Vec<AlwaysOnInventory>,
    instances: Vec<InstanceRecord>,
) -> NodeFrame {
    NodeFrame::RuntimeInventory {
        snapshot_id: snapshot_id.to_string(),
        chunk_index,
        is_final: false,
        always_on,
        instances,
    }
}

/// Cut one entry down until it fits a chunk alone: engine facts first, then
/// models.
fn fit_alone(snapshot_id: &str, mut entry: AlwaysOnInventory) -> AlwaysOnInventory {
    if encoded(&chunk(snapshot_id, 0, vec![entry.clone()], Vec::new())) <= CHUNK_BUDGET_BYTES {
        return entry;
    }
    entry.truncated = Some(true);
    entry.engine_facts = None;
    for model in &mut entry.models {
        model.engine_facts = None;
    }
    while !entry.models.is_empty()
        && encoded(&chunk(snapshot_id, 0, vec![entry.clone()], Vec::new())) > CHUNK_BUDGET_BYTES
    {
        entry.models.pop();
    }
    entry
}

pub fn frames(always_on: Vec<AlwaysOnInventory>, instances: Vec<InstanceRecord>) -> Vec<NodeFrame> {
    let snapshot_id = rand::distr::Alphanumeric.sample_string(&mut rand::rng(), 32);
    let mut frames = Vec::new();
    let mut current_on: Vec<AlwaysOnInventory> = Vec::new();
    let mut current_instances: Vec<InstanceRecord> = Vec::new();
    let flush = |frames: &mut Vec<NodeFrame>,
                 on: &mut Vec<AlwaysOnInventory>,
                 inst: &mut Vec<InstanceRecord>| {
        let index = u32::try_from(frames.len()).unwrap_or(u32::MAX);
        frames.push(chunk(
            &snapshot_id,
            index,
            std::mem::take(on),
            std::mem::take(inst),
        ));
    };
    for entry in always_on {
        let entry = fit_alone(&snapshot_id, entry);
        current_on.push(entry);
        let full = current_on.len() + current_instances.len() > RUNTIME_INVENTORY_CHUNK_MAX
            || encoded(&chunk(&snapshot_id, 0, current_on.clone(), Vec::new()))
                > CHUNK_BUDGET_BYTES;
        if full {
            let last = current_on.pop();
            flush(&mut frames, &mut current_on, &mut current_instances);
            current_on.extend(last);
        }
    }
    for record in instances {
        current_instances.push(record);
        let full = current_on.len() + current_instances.len() > RUNTIME_INVENTORY_CHUNK_MAX
            || encoded(&chunk(
                &snapshot_id,
                0,
                current_on.clone(),
                current_instances.clone(),
            )) > CHUNK_BUDGET_BYTES;
        if full {
            let last = current_instances.pop();
            flush(&mut frames, &mut current_on, &mut current_instances);
            current_instances.extend(last);
        }
    }
    flush(&mut frames, &mut current_on, &mut current_instances);
    if let Some(NodeFrame::RuntimeInventory { is_final, .. }) = frames.last_mut() {
        *is_final = true;
    }
    frames
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::frames::{InstancePhase, InventoryModel, RuntimeOrigin};
    use crate::protocol::runtime_spec::ModelCapability;

    fn entry(slug: &str, models: usize) -> AlwaysOnInventory {
        AlwaysOnInventory {
            slug: slug.into(),
            origin: RuntimeOrigin::Server,
            runtime_id: Some("rt1".into()),
            version_id: Some("vr1".into()),
            launch_hash: "a".repeat(64),
            spec: None,
            status: AlwaysOnStatus::Online,
            models: (0..models)
                .map(|index| InventoryModel {
                    id: format!("{}-{index}", "m".repeat(200)),
                    capabilities: vec![ModelCapability::TextGeneration],
                    embedding_contract: None,
                    transcription: None,
                    engine_facts: None,
                })
                .collect(),
            engine_facts: None,
            truncated: None,
        }
    }

    #[test]
    fn an_empty_snapshot_is_one_final_chunk() {
        let frames = frames(Vec::new(), Vec::new());
        assert_eq!(frames.len(), 1);
        assert!(matches!(
            frames[0],
            NodeFrame::RuntimeInventory { is_final: true, .. }
        ));
    }

    #[test]
    fn chunks_stay_within_the_budget_and_an_oversized_entry_is_cut() {
        let on: Vec<_> = (0..40)
            .map(|i| entry(&format!("r{i}"), 20))
            .chain([entry("huge", 1000)])
            .collect();
        let instances = (0..3)
            .map(|rank| InstanceRecord {
                instance_id: "in1".into(),
                launch_version_id: "vr1".into(),
                launch_hash: "a".repeat(64),
                rank,
                intent_hash: "b".repeat(64),
                step_id: None,
                phase: InstancePhase::Ready,
                unit_name: format!("wsmp-i-abcdefabcdef-r{rank}"),
                port: 30000,
                handle: "i-abcdefabcdef".into(),
                models: vec!["m".into()],
                engine_facts: None,
            })
            .collect();
        let frames = frames(on, instances);
        assert!(frames.len() > 1);
        let mut seen = 0;
        for (index, frame) in frames.iter().enumerate() {
            assert!(encoded(frame) <= CHUNK_BUDGET_BYTES);
            assert!(frame.validate().is_ok());
            let NodeFrame::RuntimeInventory {
                chunk_index,
                is_final,
                always_on,
                instances,
                ..
            } = frame
            else {
                panic!("inventory");
            };
            assert_eq!(*chunk_index as usize, index);
            assert_eq!(*is_final, index + 1 == frames.len());
            seen += always_on.len() + instances.len();
            if let Some(huge) = always_on.iter().find(|e| e.slug == "huge") {
                assert_eq!(huge.truncated, Some(true));
            }
        }
        assert_eq!(seen, 44);
    }
}
