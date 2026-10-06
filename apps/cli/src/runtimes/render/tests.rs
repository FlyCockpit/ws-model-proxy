use super::*;
use crate::protocol::canonical::launch_hash;
use crate::protocol::frames::JobPlaceholders;
use crate::protocol::runtime_spec::RuntimeKind;
use crate::runtime_store::{HeldVersion, NodePart};
use serde_json::{Value, json};

fn spec(start: &str, group_size: u8) -> Value {
    json!({
        "api": "openai", "engine": "vllm", "modelType": "llm",
        "models": [{ "id": "m" }],
        "launch": {
            "management": "process", "groupSize": group_size,
            "resources": [{ "kind": "none" }], "labels": [],
            "commands": [{ "start": start, "stop": "pkill -f {{port}}", "status": "true" }],
            "readiness": { "path": "/health", "expectedStatus": 200, "timeoutMs": 60000 },
            "health": { "intervalMs": 30000, "failureThreshold": 3, "successThreshold": 1 }
        }
    })
}

fn store_with(spec: Value) -> (Store, String) {
    let hash = launch_hash(&spec).expect("hash");
    let fabrics = json!([{
        "fabricId": "fab1", "name": "qsfp", "selfIp": "10.0.0.6",
        "memberIps": ["10.0.0.5", "10.0.0.6"]
    }]);
    let commands = json!([]);
    let store = Store {
        version: 1,
        held: vec![HeldVersion {
            runtime_id: "rt1".into(),
            version_id: "vr1".into(),
            launch_hash: hash.clone(),
            kind: RuntimeKind::Startable,
            slug: "qwen".into(),
            spec,
        }],
        node: Some(NodePart {
            port_range: [30000, 30999],
            metric_commands: serde_json::from_value(json!({
                "hash": crate::protocol::canonical::canonical_sha256(&commands).expect("hash"),
                "commands": commands
            }))
            .expect("commands"),
            fabrics: serde_json::from_value(json!({
                "hash": crate::protocol::canonical::canonical_sha256(&fabrics).expect("hash"),
                "sets": fabrics
            }))
            .expect("fabrics"),
            command_max_ms: 86_400_000,
        }),
    };
    (store, hash)
}

fn job(hash: &str, rank: u8, nnodes: u8) -> RuntimeJob {
    RuntimeJob {
        step_id: "st1".into(),
        instance_id: "in1".into(),
        runtime_id: "rt1".into(),
        launch_version_id: "vr1".into(),
        launch_hash: hash.into(),
        generation: 1,
        rank,
        nnodes,
        phase: JobPhase::Start,
        handle: "i-abcdefabcdef".into(),
        unit_name: format!("wsmp-i-abcdefabcdef-r{rank}"),
        placeholders: JobPlaceholders {
            port: 30001,
            dist_port: (nnodes > 1).then_some(30002),
            head_addr: (nnodes > 1).then(|| "10.0.0.5".to_string()),
            gpu_ids: Some("0,1".into()),
            memory_gb: None,
            vram_gb: Some("79.5".into()),
            memory_fraction: Some("0.9".into()),
        },
        fabric_id: (nnodes > 1).then(|| "fab1".to_string()),
        timeout_ms: 1_800_000,
        owner_epoch: "0b0c3a5e-1111:7".into(),
        intent_hash: "a".repeat(64),
        operator: None,
    }
}

fn facts(iface: &str) -> NodeFacts {
    let mut addresses = BTreeMap::new();
    addresses.insert(iface.to_string(), vec!["10.0.0.6".to_string()]);
    NodeFacts {
        addresses,
        sys: std::path::PathBuf::from("/nonexistent-sys"),
    }
}

#[test]
fn renders_typed_values_from_the_held_definition_only() {
    let (store, hash) = store_with(spec(
        "vllm serve m --port {{port}} --gpu-memory-utilization {{memory_fraction}} --devices {{gpu_ids}}",
        1,
    ));
    let rendered =
        render(&job(&hash, 0, 1), TrustValue::Full, &store, &facts("eth0")).expect("rendered");
    assert_eq!(
        rendered.command,
        "vllm serve m --port 30001 --gpu-memory-utilization 0.9 --devices 0,1"
    );
    assert_eq!(rendered.stop_command, "pkill -f 30001");
    assert_eq!(rendered.host, "127.0.0.1");
    // The job's version id with another hash is not held.
    let refused = render(
        &job(&"b".repeat(64), 0, 1),
        TrustValue::Full,
        &store,
        &facts("eth0"),
    )
    .expect_err("not held");
    assert_eq!(refused.error, JobError::DefinitionMissing);
    let frozen = render(
        &job(&"b".repeat(64), 0, 1),
        TrustValue::Relay,
        &store,
        &facts("eth0"),
    )
    .expect_err("not frozen");
    assert_eq!(frozen.error, JobError::DefinitionFrozen);
    let mut other_runtime = job(&hash, 0, 1);
    other_runtime.runtime_id = "rt2".into();
    assert!(render(&other_runtime, TrustValue::Full, &store, &facts("eth0")).is_err());
}

#[test]
fn every_server_value_is_typed_before_rendering() {
    let (store, hash) = store_with(spec("serve {{port}} {{vram_gb}} {{memory_fraction}}", 1));
    let case = |mutate: &dyn Fn(&mut RuntimeJob)| {
        let mut bad = job(&hash, 0, 1);
        mutate(&mut bad);
        render(&bad, TrustValue::Full, &store, &facts("eth0")).map(|job| job.command)
    };
    assert!(case(&|_| {}).is_ok());
    for (name, mutate) in [
        (
            "port",
            &(|j: &mut RuntimeJob| j.placeholders.port = 31000) as &dyn Fn(&mut RuntimeJob),
        ),
        ("port", &|j: &mut RuntimeJob| j.placeholders.port = 22),
        ("vram_gb", &|j: &mut RuntimeJob| {
            j.placeholders.vram_gb = Some("1e3".into())
        }),
        ("vram_gb", &|j: &mut RuntimeJob| {
            j.placeholders.vram_gb = Some("80; rm -rf ~".into())
        }),
        ("vram_gb", &|j: &mut RuntimeJob| {
            j.placeholders.vram_gb = Some("0".into())
        }),
        ("vram_gb", &|j: &mut RuntimeJob| {
            j.placeholders.vram_gb = Some("-1".into())
        }),
        ("memory_fraction", &|j: &mut RuntimeJob| {
            j.placeholders.memory_fraction = Some("1.5".into())
        }),
        ("memory_fraction", &|j: &mut RuntimeJob| {
            j.placeholders.memory_fraction = Some("0.1234567".into())
        }),
        ("gpu_ids", &|j: &mut RuntimeJob| {
            j.placeholders.gpu_ids = Some("0,0".into())
        }),
        ("gpu_ids", &|j: &mut RuntimeJob| {
            j.placeholders.gpu_ids = Some("0 1".into())
        }),
        ("gpu_ids", &|j: &mut RuntimeJob| {
            j.placeholders.gpu_ids = Some("$(id)".into())
        }),
    ] {
        let refused = case(mutate).expect_err(name);
        assert_eq!(refused.error, JobError::BadJob, "{name}");
        assert_eq!(
            refused.detail.as_deref(),
            Some(format!("placeholders.{name}").as_str())
        );
    }
    // A value the command needs but the job does not send.
    let refused = case(&|j: &mut RuntimeJob| j.placeholders.vram_gb = None).expect_err("absent");
    assert_eq!(refused.detail.as_deref(), Some("placeholders.vram_gb"));
    // Identity checks.
    for mutate in [
        &(|j: &mut RuntimeJob| j.nnodes = 2) as &dyn Fn(&mut RuntimeJob),
        &|j: &mut RuntimeJob| j.unit_name = "wsmp-other-r0".into(),
        &|j: &mut RuntimeJob| j.handle = "qwen".into(),
        &|j: &mut RuntimeJob| j.intent_hash = "z".repeat(64),
    ] {
        assert_eq!(case(mutate).expect_err("identity").error, JobError::BadJob);
    }
}

#[test]
fn a_fixed_port_is_the_only_port_outside_the_range() {
    let mut fixed = spec("serve {{port}}", 1);
    fixed["launch"]["port"] = json!({ "fixed": 8000 });
    let (store, hash) = store_with(fixed);
    let mut on_fixed = job(&hash, 0, 1);
    on_fixed.placeholders.port = 8000;
    assert!(render(&on_fixed, TrustValue::Full, &store, &facts("eth0")).is_ok());
    // Inside the range but not the fixed port: refused.
    let in_range = job(&hash, 0, 1);
    assert!(render(&in_range, TrustValue::Full, &store, &facts("eth0")).is_err());
}

#[test]
fn multi_node_jobs_use_the_node_fabric_and_a_member_head() {
    let start =
        "vllm serve m --host {{fabric_ip}} --master-addr {{head_addr}} --nccl {{fabric_iface}}";
    let (store, hash) = store_with(spec(start, 2));
    let rendered = render(
        &job(&hash, 1, 2),
        TrustValue::Relay,
        &store,
        &facts("enp1s0f0"),
    )
    .expect("rendered");
    assert_eq!(
        rendered.command,
        "vllm serve m --host 10.0.0.6 --master-addr 10.0.0.5 --nccl enp1s0f0"
    );
    assert_eq!(rendered.host, "10.0.0.6");
    // A head outside the (frozen) fabric is refused.
    let mut stranger = job(&hash, 1, 2);
    stranger.placeholders.head_addr = Some("10.0.0.99".into());
    let refused =
        render(&stranger, TrustValue::Relay, &store, &facts("enp1s0f0")).expect_err("not a member");
    assert_eq!(refused.error, JobError::DefinitionFrozen);
    // An unknown fabric is refused.
    let mut unknown = job(&hash, 1, 2);
    unknown.fabric_id = Some("fab9".into());
    assert!(render(&unknown, TrustValue::Relay, &store, &facts("enp1s0f0")).is_err());
}

#[test]
fn a_malicious_interface_name_never_reaches_a_command() {
    let start = "nccl {{fabric_iface}} serve {{port}} on {{fabric_ip}}";
    let (store, hash) = store_with(spec(start, 2));
    for iface in ["eth0;reboot", "$(id)", "-oProxyCommand", "e th0"] {
        let refused =
            render(&job(&hash, 1, 2), TrustValue::Full, &store, &facts(iface)).expect_err(iface);
        assert_eq!(refused.error, JobError::BadJob, "{iface}");
        assert_eq!(refused.detail.as_deref(), Some("placeholders.fabric_iface"));
    }
}

#[test]
fn interactive_steps_are_refused_before_admission() {
    let mut interactive = spec("serve {{port}}", 1);
    interactive["launch"]["management"] = json!("service");
    interactive["launch"]["commands"][0]["interactive"] = json!({ "start": true });
    let (store, hash) = store_with(interactive);
    let refused =
        render(&job(&hash, 0, 1), TrustValue::Full, &store, &facts("eth0")).expect_err("refused");
    assert_eq!(refused.error, JobError::InteractiveUnsupported);
    assert!(refused.error.is_pre_admission());
}

#[test]
fn substitution_and_decimals() {
    let mut values = BTreeMap::new();
    values.insert("port", "1".to_string());
    assert_eq!(
        substitute("a {{port}} {{ port }} {{", &values).as_deref(),
        Ok("a 1 {{ port }} {{")
    );
    assert_eq!(
        substitute("{{gpu_ids}}", &values),
        Err("gpu_ids".to_string())
    );
    for ok in ["0", "1", "79.5", "0.000001", "120"] {
        assert!(canonical_decimal(ok), "{ok}");
    }
    for bad in ["", "01", "1.", ".5", "1e3", "-1", "1.0000001", "NaN", "1,5"] {
        assert!(!canonical_decimal(bad), "{bad}");
    }
    assert!(fraction("1") && fraction("0.5") && fraction("1.000"));
    assert!(!fraction("0") && !fraction("1.01") && !fraction("2"));
}
