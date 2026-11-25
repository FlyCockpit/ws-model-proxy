//! The held runtime definitions and the targets their handles reach, for
//! the node's current trust.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::Result;

use crate::node::runtime_store::Store;
use crate::relay::sessions::DEFAULT_COMMAND_MAX;
use crate::services::runtimes::endpoints::Target;
use crate::services::runtimes::executor::Job;
use crate::wire::protocol::frames::{InstancePhase, InstanceRecord, TrustValue};

/// Held definitions and what their handles reach, for the current trust.
#[cfg_attr(test, derive(Default))]
pub(super) struct NodeRuntimes {
    pub(super) store: Store,
    /// `runtimeHosts` as last read: always-on addresses are re-checked.
    runtime_hosts: Vec<String>,
    targets: BTreeMap<String, Target>,
    /// Every instance rank on this node, as last observed.
    instances: Vec<(Job, InstanceRecord)>,
}

impl NodeRuntimes {
    pub(super) fn load(trust: TrustValue, runtime_hosts: &[String]) -> Self {
        let store = crate::node::runtime_store::load_for(trust).unwrap_or_else(|error| {
            tracing::warn!(
                error = %format!("{error:#}"),
                "reading held definitions failed; holding none"
            );
            Store::default()
        });
        let mut runtimes = Self {
            store,
            runtime_hosts: runtime_hosts.to_vec(),
            targets: BTreeMap::new(),
            instances: Vec::new(),
        };
        runtimes.retarget();
        runtimes
    }

    /// Reload the held set for `trust`, keeping the observed instances.
    pub(super) fn reload(&mut self, trust: TrustValue, runtime_hosts: &[String]) {
        let instances = std::mem::take(&mut self.instances);
        *self = Self::load(trust, runtime_hosts);
        self.instances = instances;
        self.retarget();
    }

    pub(super) fn set_instances(&mut self, instances: Vec<(Job, InstanceRecord)>) {
        self.instances = instances;
        self.retarget();
    }

    fn retarget(&mut self) {
        let mut targets = crate::services::runtimes::endpoints::always_on_targets(&self.store);
        // An address no longer allowed (a host removed from `runtimeHosts`)
        // stops being reachable at once.
        targets.retain(|slug, target| {
            let allowed = crate::node::runtime_store::validate::check_base_url(
                &target.endpoint.base_url,
                &self.runtime_hosts,
            )
            .is_ok();
            if !allowed {
                tracing::warn!(
                    runtime = slug,
                    "an always-on address is no longer allowed here"
                );
            }
            allowed
        });
        targets.extend(crate::services::runtimes::endpoints::instance_targets(
            &self.instances,
        ));
        self.targets = targets;
    }

    /// Ports live instances hold, by the runtime they run.
    pub(super) fn busy_ports(&self) -> BTreeMap<u16, String> {
        self.instances
            .iter()
            .filter(|(_, record)| record.phase != InstancePhase::Stopped)
            .map(|(job, _)| (job.port, job.runtime_id.clone()))
            .collect()
    }

    pub(super) fn instance_records(&self) -> Vec<InstanceRecord> {
        self.instances
            .iter()
            .map(|(_, record)| record.clone())
            .collect()
    }

    pub(super) fn endpoints(&self) -> Vec<crate::node::config::EndpointConfig> {
        self.targets
            .values()
            .map(|target| target.endpoint.clone())
            .collect()
    }

    /// Where a relay request for `handle` goes, when this node serves it.
    pub(super) fn target(&self, handle: &str) -> Option<&Target> {
        self.targets.get(handle)
    }

    /// Whether the launch version `version_id` with `launch_hash` is held.
    pub(super) fn holds(&self, version_id: &str, launch_hash: &str) -> bool {
        self.store.find(version_id, launch_hash).is_some()
    }

    /// A runtime step rendered from its held definition, or why it is refused.
    pub(super) fn render(
        &self,
        job: &crate::wire::protocol::frames::RuntimeJob,
        trust: TrustValue,
        facts: &crate::services::runtimes::render::NodeFacts,
    ) -> Result<Job, crate::services::runtimes::render::Refusal> {
        crate::services::runtimes::render::render(job, trust, &self.store, facts)
    }

    /// How long a node command may run, by the held node definition.
    pub(super) fn command_max(&self) -> Duration {
        command_max(&self.store)
    }

    pub(super) fn held_definitions(&self) -> Vec<crate::wire::protocol::frames::HeldDefinition> {
        self.store.held_definitions()
    }

    pub(super) fn metric_commands_hash(&self) -> Option<String> {
        self.store.metric_commands_hash()
    }

    pub(super) fn metric_commands(
        &self,
    ) -> Vec<crate::wire::protocol::runtime_spec::NodeMetricCommand> {
        self.store.metric_commands().to_vec()
    }

    pub(super) fn port_range(&self) -> Option<[u16; 2]> {
        self.store.port_range()
    }

    pub(super) fn fabrics_hash(&self) -> Option<String> {
        self.store.fabrics_hash()
    }
}

/// The command lifetime cap the held node definition sets (24 h without one).
pub(super) fn command_max(store: &Store) -> Duration {
    store
        .command_max_ms()
        .map_or(DEFAULT_COMMAND_MAX, Duration::from_millis)
}
