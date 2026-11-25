use super::*;
use crate::protocol::canonical::{canonical_sha256, launch_hash};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// F-FB-2: the release versions this node reads are exactly the ones the
/// server accepts (`agentReleaseVersionSchema` checks the same vectors),
/// so the server never offers or sends one the node cannot install.
#[test]
fn release_versions_match_the_servers_vectors() {
    #[derive(serde::Deserialize)]
    struct Vector {
        value: String,
        valid: bool,
    }
    #[derive(serde::Deserialize)]
    struct Shared {
        vectors: Vec<Vector>,
    }
    let shared: Shared = serde_json::from_str(include_str!(
        "../../../../../packages/api/src/lib/agent-release-version-vectors.json"
    ))
    .expect("shared release version vectors");
    assert!(shared.vectors.len() > 30);
    for vector in shared.vectors {
        assert_eq!(
            is_release_version(&vector.value),
            vector.valid,
            "{:?}",
            vector.value
        );
    }
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/relay-4.0")
}

fn load(dir: &str) -> Vec<(String, Value)> {
    let mut entries: Vec<(String, Value)> = std::fs::read_dir(fixtures().join(dir))
        .expect("fixture dir exists")
        .map(|entry| entry.expect("dir entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .map(|path| {
            let text = std::fs::read_to_string(&path).expect("fixture is readable");
            (
                file_name(&path),
                serde_json::from_str(&text).expect("fixture is JSON"),
            )
        })
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(!entries.is_empty(), "no fixtures in {dir}");
    entries
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_owned()
}

/// JSON equality where `87` and `87.0` are the same number.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(l, r)| same(l, r))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

trait Validated {
    fn ok(&self) -> bool;
}
impl Validated for NodeFrame {
    fn ok(&self) -> bool {
        self.validate().is_ok()
    }
}
impl Validated for ServerFrame {
    fn ok(&self) -> bool {
        self.validate().is_ok()
    }
}
impl Validated for ServerBinaryMetadata {
    fn ok(&self) -> bool {
        true
    }
}
impl Validated for NodeBinaryMetadata {
    fn ok(&self) -> bool {
        true
    }
}
fn valid<T: Validated>(frame: &T) -> bool {
    frame.ok()
}

fn round_trip<T: DeserializeOwned + Serialize + Validated>(dir: &str) -> Vec<(String, T)> {
    load(dir)
        .into_iter()
        .map(|(name, json)| {
            let frame: T = serde_json::from_value(json.clone())
                .unwrap_or_else(|error| panic!("{dir}/{name}: {error}"));
            assert!(valid(&frame), "{dir}/{name} breaks a cross-field rule");
            let back = serde_json::to_value(&frame).expect("serializes");
            assert!(
                same(&back, &json),
                "{dir}/{name} did not round-trip:\n{back}\n{json}"
            );
            (name, frame)
        })
        .collect()
}

#[test]
fn fabric_ips_match_the_shared_vectors() {
    let text = std::fs::read_to_string(fixtures().join("rules/fabric-ip.json"))
        .expect("fabric-ip vectors");
    let vectors: Value = serde_json::from_str(&text).expect("vectors are JSON");
    let list = |key: &str| -> Vec<String> {
        vectors[key]
            .as_array()
            .expect("a list")
            .iter()
            .map(|value| value.as_str().expect("a string").to_owned())
            .collect()
    };
    for ip in list("valid") {
        assert!(is_fabric_ip(&ip), "{ip} should be accepted");
    }
    for ip in list("invalid") {
        assert!(!is_fabric_ip(&ip), "{ip} should be refused");
    }
}

#[test]
fn relay_requests_may_delete_stored_responses() {
    let mut frame: Value = serde_json::from_str(
        &std::fs::read_to_string(fixtures().join("frames/server-to-node/relay.request.json"))
            .expect("relay.request fixture"),
    )
    .expect("fixture is JSON");
    frame["method"] = Value::String("DELETE".into());
    frame["path"] = Value::String("/v1/responses/resp_1".into());
    let parsed: ServerFrame = serde_json::from_value(frame).expect("DELETE parses");
    assert!(
        serde_json::to_string(&parsed)
            .expect("serializes")
            .contains("\"DELETE\"")
    );
}

#[test]
fn fabric_device_names_stay_plain() {
    for name in ["eth0", "enp1s0f0", "ib0", "mlx5_0", "eth0.100", "bond0:1"] {
        assert!(is_fabric_device_name(name), "{name}");
    }
    for name in [
        "",
        "-eth0",
        "eth0;reboot",
        "$(id)",
        "eth 0",
        &"a".repeat(65),
    ] {
        assert!(!is_fabric_device_name(name), "{name}");
    }
}

#[test]
fn node_frames_round_trip() {
    round_trip::<NodeFrame>("frames/node-to-server");
}

#[test]
fn server_frames_round_trip() {
    round_trip::<ServerFrame>("frames/server-to-node");
}

#[test]
fn secret_values_never_reach_debug_output() {
    let frames = round_trip::<ServerFrame>("frames/server-to-node");
    let (_, frame) = frames
        .iter()
        .find(|(name, _)| name == "secret.set.json")
        .expect("secret.set fixture");
    let ServerFrame::SecretSet(secret) = frame else {
        panic!("secret.set parses as SecretSet");
    };
    let printed = format!("{frame:?}");
    assert!(!printed.contains(&secret.value), "{printed}");
    assert!(printed.contains("[redacted]"));
}

#[test]
fn fabric_sets_hash_as_sent() {
    let frames = round_trip::<ServerFrame>("frames/server-to-node");
    let (_, frame) = frames
        .iter()
        .find(|(name, _)| name == "runtime.define.json")
        .expect("runtime.define fixture");
    let ServerFrame::RuntimeDefine {
        node: Some(node), ..
    } = frame
    else {
        panic!("runtime.define carries the node part");
    };
    let sets = serde_json::to_value(&node.fabrics.sets).expect("serializes");
    assert_eq!(
        canonical_sha256(&sets).expect("canonical"),
        node.fabrics.hash
    );
}

#[test]
fn binary_metadata_round_trips() {
    round_trip::<ServerBinaryMetadata>("binary/server-to-node");
    round_trip::<NodeBinaryMetadata>("binary/node-to-server");
}

/// Shared vectors the server's schema refuses only for a field it does
/// not have. wsmp ignores such a field (a later server may add one), and
/// none of these grants anything: the node renders from its own held
/// definition and resolves its own interface.
const IGNORED_FIELD_VECTORS: &[&str] = &[
    "file-op-with-2.4-mode.json",
    "job-carries-command-text.json",
    "job-reservation-unknown-field.json",
    "job-server-sent-interface-name.json",
];

#[test]
fn ran_with_has_its_wire_shape() {
    let frame = NodeFrame::ExecStarted {
        command_id: "UnecweYLMFV6n8TpDjNYfQ".into(),
        started_at: "2026-10-06T12:00:00.000Z".into(),
        ends_by: "2026-10-06T13:00:00.000Z".into(),
        ran_with: RanWith {
            shell: None,
            mode: RanMode::Direct,
        },
    };
    let json = serde_json::to_value(&frame).expect("serializes");
    assert_eq!(
        json["ranWith"],
        serde_json::json!({ "shell": null, "mode": "direct" })
    );
}

#[test]
fn invalid_frames_are_refused() {
    for (name, json) in load("invalid/server-to-node") {
        let parsed = serde_json::from_value::<ServerFrame>(json.clone())
            .ok()
            .filter(|frame| frame.validate().is_ok());
        if IGNORED_FIELD_VECTORS.contains(&name.as_str()) {
            let frame = parsed.unwrap_or_else(|| panic!("server-to-node/{name} must parse"));
            let back = serde_json::to_value(&frame).expect("serializes");
            assert!(!same(&back, &json), "{name}: the extra field is dropped");
            continue;
        }
        assert!(parsed.is_none(), "server-to-node/{name} must be refused");
    }
    for (name, json) in load("invalid/node-to-server") {
        let refused = serde_json::from_value::<NodeFrame>(json)
            .map_or(true, |frame| frame.validate().is_err());
        assert!(refused, "node-to-server/{name} must be refused");
    }
}

#[test]
fn define_and_inventory_name_the_launch_hash_of_their_spec() {
    let defines: Vec<Value> = load("frames/server-to-node")
        .into_iter()
        .map(|(_, json)| json)
        .filter(|json| json["type"] == "runtime.define")
        .collect();
    let put: Vec<&Value> = defines
        .iter()
        .filter_map(|define| define["put"].as_array())
        .flatten()
        .collect();
    assert!(put.len() > 1);
    for envelope in put {
        // Hash the spec exactly as received ...
        assert_eq!(
            launch_hash(&envelope["spec"]).expect("hash"),
            envelope["launchHash"].as_str().unwrap_or_default()
        );
        // ... and the typed mirror is complete: re-serializing changes nothing.
        let typed: DefinitionEnvelope =
            serde_json::from_value(envelope.clone()).expect("envelope parses");
        assert_eq!(typed.spec.kind(), typed.kind);
        let reserialized = serde_json::to_value(&typed.spec).expect("spec serializes");
        assert_eq!(
            launch_hash(&reserialized).expect("hash"),
            envelope["launchHash"].as_str().unwrap_or_default()
        );
    }
    let define = defines
        .iter()
        .find(|define| define.get("node").is_some())
        .expect("a define with the node part");
    let commands = &define["node"]["metricCommands"];
    assert_eq!(
        canonical_sha256(&commands["commands"]).expect("hash"),
        commands["hash"].as_str().unwrap_or_default()
    );
    let inventory = load("frames/node-to-server")
        .into_iter()
        .find(|(name, _)| name == "runtime.inventory.json")
        .map(|(_, json)| json)
        .expect("runtime.inventory fixture");
    for entry in inventory["alwaysOn"].as_array().expect("alwaysOn") {
        if let Some(spec) = entry.get("spec") {
            assert_eq!(
                launch_hash(spec).expect("hash"),
                entry["launchHash"].as_str().unwrap_or_default()
            );
        }
    }
}

#[test]
fn job_unit_names_follow_the_handle() {
    for (name, frame) in round_trip::<ServerFrame>("frames/server-to-node") {
        if let ServerFrame::RuntimeJob(job) = frame {
            assert_eq!(
                job.unit_name,
                runtime_unit_name(&job.handle, job.rank),
                "{name}"
            );
            assert!(job.rank < job.nnodes, "{name}");
        }
    }
}

#[test]
fn job_reservations_follow_the_rules() {
    let frames = round_trip::<ServerFrame>("frames/server-to-node");
    let Some(ServerFrame::RuntimeJob(job)) = frames
        .into_iter()
        .find(|(name, _)| name == "runtime.job-reservations.json")
        .map(|(_, frame)| frame)
    else {
        panic!("runtime.job-reservations fixture");
    };
    let job = *job;
    assert_eq!(job.reservations.len(), 2);
    assert!(job.validate().is_ok());
    let broken = |change: &dyn Fn(&mut RuntimeJob)| {
        let mut copy = job.clone();
        change(&mut copy);
        copy.validate().is_err()
    };
    let entry = |index: u8| JobReservation {
        index,
        node_id: format!("wk{index}"),
        node: format!("worker-{index}"),
        gpu_ids: None,
    };
    assert!(broken(&|job| job.reservations[1].index = 0));
    assert!(broken(&|job| job.reservations[1].index = 8));
    assert!(broken(
        &|job| job.reservations = (0..9).map(|_| entry(0)).collect()
    ));
    assert!(broken(&|job| job.reservations[0].node_id = String::new()));
    assert!(broken(&|job| job.reservations[0].node_id = "a".repeat(65)));
    assert!(broken(&|job| job.reservations[0].node_id = "wk 1".into()));
    assert!(broken(&|job| job.reservations[0].node = "Worker-a".into()));
    assert!(broken(&|job| job.reservations[0].node = "worker--a".into()));
    assert!(broken(&|job| job.reservations[0].node = "-worker".into()));
    assert!(broken(&|job| job.reservations[0].node = "worker-".into()));
    assert!(broken(&|job| job.reservations[0].node = "ab".into()));
    assert!(broken(&|job| job.reservations[0].node = "a".repeat(64)));
    assert!(!broken(
        &|job| job.reservations = (0..8).map(entry).collect()
    ));
    assert!(!broken(&|job| job.reservations[0].node = "a".repeat(63)));
    assert!(!broken(&|job| job.reservations[0].node = "a1b".into()));
    // Worker GPUs: indices like the rank's `gpu_ids`, never keys or repeats.
    assert_eq!(job.reservations[0].gpu_ids.as_deref(), Some("1"));
    assert!(!broken(
        &|job| job.reservations[0].gpu_ids = Some("0,3".into())
    ));
    assert!(!broken(&|job| job.reservations[0].gpu_ids = None));
    assert!(broken(
        &|job| job.reservations[0].gpu_ids = Some(String::new())
    ));
    assert!(broken(
        &|job| job.reservations[0].gpu_ids = Some("nvidia:1".into())
    ));
    assert!(broken(
        &|job| job.reservations[0].gpu_ids = Some("01".into())
    ));
    assert!(broken(
        &|job| job.reservations[0].gpu_ids = Some("1,1".into())
    ));
    assert!(broken(
        &|job| job.reservations[0].gpu_ids = Some("256".into())
    ));
    assert!(!broken(&|job| job.reservations.clear()));
    // Multi-node jobs carry none.
    assert!(broken(&|job| {
        job.nnodes = 2;
        job.fabric_id = Some("fab_qsfp1".into());
        job.placeholders.head_addr = Some("10.0.0.5".into());
    }));
    // An empty list is never sent.
    let wire = serde_json::to_value(RuntimeJob {
        reservations: Vec::new(),
        ..job
    })
    .expect("serializes");
    assert!(wire.get("reservations").is_none());
}

#[test]
fn agent_updates_follow_the_rules() {
    let frames = round_trip::<ServerFrame>("frames/server-to-node");
    let (_, update) = frames
        .into_iter()
        .find(|(name, _)| name == "agent.update.json")
        .expect("agent.update fixture");
    assert!(update.validate().is_ok());
    let broken = |change: &dyn Fn(&mut Value)| {
        let mut json = serde_json::to_value(&update).expect("serializes");
        change(&mut json);
        serde_json::from_value::<ServerFrame>(json).map_or(true, |frame| frame.validate().is_err())
    };
    for url in [
        "http://example.com/a.tar.xz",
        "ftp://example.com/a.tar.xz",
        "https://user:pw@example.com/a.tar.xz",
        "file:///tmp/a.tar.xz",
        "not a url",
    ] {
        assert!(broken(&|json| json["artifactUrl"] = url.into()), "{url}");
    }
    for url in [
        "http://127.0.0.1:8080/a.tar.xz",
        "http://localhost/a.tar.xz",
        "http://[::1]:3000/a.zip",
        "https://objects.example.com/a.zip?sig=1",
    ] {
        assert!(!broken(&|json| json["artifactUrl"] = url.into()), "{url}");
    }
    assert!(broken(&|json| json["rollbackAfterSecs"] = 29.into()));
    assert!(broken(&|json| json["rollbackAfterSecs"] = 601.into()));
    assert!(!broken(&|json| json["rollbackAfterSecs"] = 30.into()));
    assert!(!broken(&|json| json["rollbackAfterSecs"] = 600.into()));
    assert!(broken(&|json| json["sha256"] = "ab".into()));
    assert!(broken(&|json| json["updateId"] = "short".into()));
    assert!(broken(&|json| json["version"] = "v0.4.3".into()));
    assert!(broken(&|json| json["version"] = "0.4".into()));
    assert!(!broken(&|json| json["version"] = "0.5.0-rc.1".into()));
    assert!(broken(&|json| json["signature"] = "".into()));
    assert!(!broken(&|json| json["signature"] = "RWQ...".into()));
    // A field a later server adds is ignored.
    assert!(!broken(&|json| json["unknown"] = true.into()));
}

#[test]
fn update_progress_follows_the_rules() {
    let frame = |phase: UpdatePhase, reason: Option<UpdateReason>, detail: Option<String>| {
        NodeFrame::AgentUpdateProgress {
            update_id: "q8Zr0T3vX1yB2nC4dE5fGw".into(),
            phase,
            reason,
            detail,
            available_version: None,
        }
    };
    assert!(
        frame(UpdatePhase::Downloading, None, None)
            .validate()
            .is_ok()
    );
    assert!(
        frame(UpdatePhase::Failed, Some(UpdateReason::Internal), None)
            .validate()
            .is_ok()
    );
    assert!(frame(UpdatePhase::Failed, None, None).validate().is_err());
    assert!(
        frame(UpdatePhase::Swapped, Some(UpdateReason::Busy), None)
            .validate()
            .is_err()
    );
    assert!(
        frame(UpdatePhase::RolledBack, None, Some("é".repeat(4000)))
            .validate()
            .is_ok()
    );
    assert!(
        frame(UpdatePhase::RolledBack, None, Some("x".repeat(4001)))
            .validate()
            .is_err()
    );
    let available = |phase, reason, version: &str| NodeFrame::AgentUpdateProgress {
        update_id: "q8Zr0T3vX1yB2nC4dE5fGw".into(),
        phase,
        reason,
        detail: None,
        available_version: Some(version.into()),
    };
    let refused = Some(UpdateReason::VersionMismatch);
    let ok = available(UpdatePhase::Refused, refused, "0.4.4");
    assert!(ok.validate().is_ok());
    assert_eq!(
        serde_json::to_value(&ok).expect("serializes")["availableVersion"],
        "0.4.4"
    );
    assert!(
        available(UpdatePhase::Refused, refused, "latest")
            .validate()
            .is_err()
    );
    assert!(
        available(UpdatePhase::Refused, Some(UpdateReason::Busy), "0.4.4")
            .validate()
            .is_err()
    );
    assert!(
        available(UpdatePhase::Failed, refused, "0.4.4")
            .validate()
            .is_err()
    );
    // Absent unless there is a version to offer.
    assert!(
        serde_json::to_value(frame(UpdatePhase::Refused, refused, None))
            .expect("serializes")
            .get("availableVersion")
            .is_none()
    );
}

#[test]
fn relay_failures_use_the_wire_spelling() {
    assert_eq!(
        serde_json::to_value(RelayFailure::Upstream5xx).expect("serializes"),
        Value::from("upstream_5xx")
    );
}
