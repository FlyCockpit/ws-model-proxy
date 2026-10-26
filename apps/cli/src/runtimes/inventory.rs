//! `runtime.inventory`: one chunked snapshot of the always-on runtimes this
//! node holds (probed for status and models) and its managed instances.
//! Built off the relay loop: probes take time.

use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Condvar, Mutex, PoisonError};

use rand::distr::SampleString;

use crate::protocol::frames::{
    AlwaysOnInventory, AlwaysOnStatus, CHUNK_BUDGET_BYTES, InstanceRecord, NodeFrame,
    RUNTIME_INVENTORY_CHUNK_MAX,
};
use crate::relay_bus::FromWorker;
use crate::runtime_store::Store;

/// The daemon's one inventory worker, across reconnects. The server applies snapshots in the
/// order they arrive, so they must arrive in the order they were captured, and an older one
/// never after a newer one. One worker probes and sends them all, one at a time, so they leave
/// in capture order. A capture replaces the one the worker has not started on, but every
/// snapshot it has probed is sent: captures that keep coming while probes are slow still let
/// one snapshot out per probe. Capturing never needs a new thread.
pub(crate) struct Inventories {
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    next: Mutex<Next>,
    wake: Condvar,
}

#[derive(Default)]
struct Next {
    capture: Option<Capture>,
    closed: bool,
}

struct Capture {
    tx: SyncSender<FromWorker>,
    store: Store,
    instances: Vec<InstanceRecord>,
}

type Probe = dyn Fn(&Store) -> Vec<AlwaysOnInventory> + Send;

impl Inventories {
    /// Start the worker. Failing to start it is the daemon's failure to start: without it the
    /// server never learns what this node holds.
    pub(crate) fn start() -> std::io::Result<Self> {
        Self::start_with(Box::new(probe_always_on))
    }

    fn start_with(probe: Box<Probe>) -> std::io::Result<Self> {
        let shared = Arc::new(Shared::default());
        let worker = Arc::clone(&shared);
        std::thread::Builder::new()
            .name("wsmp-inventory".into())
            .spawn(move || work(&worker, &*probe))?;
        Ok(Self { shared })
    }

    /// Probe every always-on runtime off the relay loop, then send the snapshot through `tx`.
    pub(crate) fn capture(
        &self,
        tx: SyncSender<FromWorker>,
        store: Store,
        instances: Vec<InstanceRecord>,
    ) {
        let mut next = lock(&self.shared);
        next.capture = Some(Capture {
            tx,
            store,
            instances,
        });
        self.shared.wake.notify_one();
    }
}

impl Drop for Inventories {
    fn drop(&mut self) {
        lock(&self.shared).closed = true;
        self.shared.wake.notify_one();
    }
}

fn lock(shared: &Shared) -> std::sync::MutexGuard<'_, Next> {
    shared.next.lock().unwrap_or_else(PoisonError::into_inner)
}

fn work(shared: &Shared, probe: &Probe) {
    loop {
        let capture = {
            let mut next = lock(shared);
            loop {
                if next.closed {
                    return;
                }
                if let Some(capture) = next.capture.take() {
                    break capture;
                }
                next = shared
                    .wake
                    .wait(next)
                    .unwrap_or_else(PoisonError::into_inner);
            }
        };
        let always_on = probe(&capture.store);
        // Not sent under the lock: the relay loop captures while it drains `tx`.
        for frame in frames(always_on, capture.instances) {
            match crate::protocol::encode_control(&frame) {
                Ok(text) => {
                    if capture.tx.send(FromWorker::Telemetry(text)).is_err() {
                        break;
                    }
                }
                Err(error) => tracing::warn!(
                    error = %format!("{error:#}"),
                    "encoding the runtime inventory failed"
                ),
            }
        }
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
    #[test]
    fn captures_while_probing_send_the_probed_snapshot_then_the_newest() {
        use std::sync::mpsc;
        use std::time::Duration;
        // The first probe waits until the test lets it go; later ones return at once.
        let (probing_tx, probing_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = std::sync::Mutex::new(release_rx);
        let first = std::sync::atomic::AtomicBool::new(true);
        let inventories = super::Inventories::start_with(Box::new(move |_| {
            if first.swap(false, std::sync::atomic::Ordering::SeqCst) {
                probing_tx.send(()).unwrap();
                release_rx.lock().unwrap().recv().unwrap();
            }
            Vec::new()
        }))
        .unwrap();
        let (tx, rx) = mpsc::sync_channel(16);
        let record = |id: &str| InstanceRecord {
            instance_id: id.into(),
            launch_version_id: "vr1".into(),
            launch_hash: "a".repeat(64),
            rank: 0,
            intent_hash: "b".repeat(64),
            step_id: None,
            phase: InstancePhase::Ready,
            unit_name: "wsmp-i-abcdefabcdef-r0".into(),
            port: 30000,
            handle: "i-abcdefabcdef".into(),
            models: vec!["m".into()],
            engine_facts: None,
            rank_idle: None,
        };
        let sent = || {
            let FromWorker::Telemetry(text) = rx.recv_timeout(Duration::from_secs(5)).unwrap()
            else {
                panic!("not a frame");
            };
            text
        };
        inventories.capture(tx.clone(), Store::default(), vec![record("first")]);
        probing_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        inventories.capture(tx.clone(), Store::default(), vec![record("second")]);
        inventories.capture(tx, Store::default(), vec![record("third")]);
        release_tx.send(()).unwrap();
        // The probed one is sent although newer ones came, then only the newest of those.
        let text = sent();
        assert!(text.contains("first"), "{text}");
        let text = sent();
        assert!(text.contains("third") && !text.contains("second"), "{text}");
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

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
                rank_idle: None,
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
