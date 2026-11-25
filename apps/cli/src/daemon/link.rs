//! What outlives one relay connection ([`NodeLink`]).

use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::Instant;

use anyhow::{Context, Result};

use crate::relay_bus::FromWorker;
use crate::runtime_store::Store;
use crate::sessions::{DEFAULT_COMMAND_MAX, ExecRegistry, OutboundFrame};

use super::node_runtimes::command_max;

/// Bounded capacity for the worker -> main-loop outbound frame channel. Provides
/// backpressure toward workers (and therefore upstream response reads) so a fast
/// upstream cannot grow unbounded memory ahead of the websocket writer.
pub(super) const RELAY_WORKER_OUTBOUND_CAPACITY: usize = 64;

/// What outlives one relay connection: the worker channel and the node
/// commands (a long command keeps running through a reconnect), plus the
/// command results that ended while disconnected and the image worker's
/// storage quota and pending cleanup, and the runtime step runner.
pub(super) struct NodeLink {
    // One owner across reconnects: cleanup cannot reset or bypass the node quota.
    pub(super) images: Arc<crate::terminal_images::ImageWorker>,
    pub(super) worker_tx: SyncSender<FromWorker>,
    pub(super) worker_rx: Receiver<FromWorker>,
    pub(super) execs: ExecRegistry,
    pub(super) deferred: Vec<OutboundFrame>,
    /// One runner across reconnects: a step admitted under an earlier
    /// connection still runs, and a stop under a later one cancels it
    /// (`admit_step`), and a stop's or status probe's answer says whether
    /// any step that may launch is still in flight there (`rank_idle`).
    pub(super) runner: Option<crate::runtimes::runner::Runner>,
    /// The one inventory worker, across reconnects (`runtimes::inventory::Inventories`): it
    /// sends snapshots in capture order, so an older one never reaches the server after a newer
    /// one.
    pub(super) inventories: Arc<crate::runtimes::inventory::Inventories>,
    /// The update in flight or awaiting confirmation, across reconnects.
    pub(super) update: crate::update::agent::DaemonUpdate,
    /// The trust lowering count whose effects were applied, online or off
    /// ([`take_lowering`](super::local::take_lowering)).
    pub(super) lowerings_applied: u64,
}

impl NodeLink {
    pub(super) fn new(
        store: &Store,
        update: crate::update::agent::DaemonUpdate,
        lowerings_applied: u64,
    ) -> Result<Self> {
        let (worker_tx, worker_rx) =
            mpsc::sync_channel::<FromWorker>(RELAY_WORKER_OUTBOUND_CAPACITY);
        let mut execs = ExecRegistry::new(worker_tx.clone(), DEFAULT_COMMAND_MAX);
        let mut deferred = Vec::new();
        match crate::paths::state_dir() {
            Ok(dir) => {
                let (with_table, interrupted) = execs.with_table(dir.join("node-commands.json"));
                execs = with_table;
                deferred = interrupted;
            }
            Err(error) => tracing::warn!(
                error = %format!("{error:#}"),
                "running commands are not recorded"
            ),
        }
        execs.set_command_max(command_max(store));
        let inventories = crate::runtimes::inventory::Inventories::start()
            .context("starting the runtime inventory worker")?;
        Ok(Self {
            images: Arc::new(crate::terminal_images::ImageWorker::new()),
            worker_tx,
            worker_rx,
            execs,
            deferred,
            runner: crate::runtimes::runner::Runner::start()
                .inspect_err(|error| {
                    tracing::warn!(
                        error = %format!("{error:#}"),
                        "runtime steps are unavailable"
                    );
                })
                .ok(),
            inventories: Arc::new(inventories),
            update,
            lowerings_applied,
        })
    }

    /// While disconnected: keep command output flowing into the registry
    /// (so commands never block on a full pipe) and keep their end results
    /// for the next connection. Everything else from a closed session drops.
    pub(super) fn drain_offline(&mut self) {
        while let Ok(message) = self.worker_rx.try_recv() {
            match message {
                FromWorker::ExecBytes {
                    command_id,
                    stderr,
                    bytes,
                } => self.execs.on_bytes(&command_id, stderr, &bytes),
                FromWorker::ExecEof { command_id, stderr } => {
                    self.execs.on_eof(&command_id, stderr);
                }
                _ => {}
            }
        }
        let ended = self.execs.poll(Instant::now());
        self.deferred.extend(ended);
        // Step results and observations of a closed session drop (as when
        // each connection had its own runner): the next connection observes
        // afresh. Drained so the runner's threads never block on a full
        // channel while offline.
        if let Some(runner) = self.runner.as_ref() {
            while runner.try_update().is_some() {}
        }
    }
}
