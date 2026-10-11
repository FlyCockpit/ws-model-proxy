use super::*;
use crate::protocol::parse_server_control;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/relay-3.0/frames/server-to-node")
            .join(name),
    )
    .expect("fixture")
}

struct Fx {
    _dir: tempfile::TempDir,
    live: PathBuf,
    frozen: PathBuf,
    defines: Defines,
    hosts: Vec<String>,
    busy: BTreeMap<u16, String>,
}

impl Fx {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("dir");
        Self {
            live: dir.path().join(STORE_FILE),
            frozen: dir.path().join(FROZEN_FILE),
            _dir: dir,
            defines: Defines::default(),
            hosts: Vec::new(),
            busy: BTreeMap::new(),
        }
    }

    fn send(&mut self, text: &str, trust: TrustValue) -> DefineOutcome {
        let frame = parse_server_control(text).expect("frame");
        let ctx = DefineContext {
            trust,
            runtime_hosts: &self.hosts,
            busy_ports: &self.busy,
        };
        let outcome = self
            .defines
            .handle(text, &frame, &ctx, &self.live)
            .expect("handled");
        assert!(outcome.answer.validate().is_ok(), "{:?}", outcome.answer);
        outcome
    }

    fn store(&self) -> Store {
        Store::load(&self.live).expect("store")
    }
}

fn results(frame: &NodeFrame) -> Vec<(String, DefineStatus, Option<DefineRejectReason>)> {
    let NodeFrame::RuntimeDefineResult { results, .. } = frame else {
        panic!("define result");
    };
    results
        .iter()
        .map(|r| (r.version_id.clone(), r.status, r.reason))
        .collect()
}

/// A single-chunk incremental define of `spec` (hash computed here).
fn define(op: &str, version: &str, runtime: &str, slug: &str, spec: Value) -> String {
    let hash = launch_hash(&spec).expect("hash");
    let kind = if spec.get("launch").is_some() {
        "startable"
    } else {
        "always_on"
    };
    serde_json::json!({
        "type": "runtime.define", "opId": op, "chunkIndex": 0, "final": true,
        "put": [{
            "runtimeId": runtime, "versionId": version, "launchHash": hash,
            "kind": kind, "slug": slug, "spec": spec
        }]
    })
    .to_string()
}

fn always_on(base_url: &str) -> Value {
    serde_json::json!({
        "api": "openai", "engine": "vllm", "modelType": "llm",
        "address": { "baseUrl": base_url }
    })
}

#[test]
fn a_chunked_complete_define_applies_after_the_final_chunk() {
    let mut fx = Fx::new();
    let first = fx.send(&fixture("runtime.define-chunk.json"), TrustValue::Full);
    assert!(!first.changed);
    assert_eq!(
        results(&first.answer),
        vec![(
            "vr1a2b3c4d5e6f7g8h9i0j1k2".to_string(),
            DefineStatus::Applied,
            None
        )]
    );
    assert!(fx.store().held.is_empty(), "nothing applies before final");
    let last = fx.send(&fixture("runtime.define.json"), TrustValue::Full);
    assert!(last.changed);
    let NodeFrame::RuntimeDefineResult {
        held,
        held_port_range,
        held_metric_commands_hash,
        held_fabrics_hash,
        frozen,
        node,
        ..
    } = &last.answer
    else {
        panic!("result");
    };
    // `keep` names a version this node never held: it simply is not held.
    let held: Vec<_> = held
        .iter()
        .flatten()
        .map(|h| h.version_id.as_str())
        .collect();
    assert_eq!(
        held,
        ["vr1a2b3c4d5e6f7g8h9i0j1k2", "vr2z9y8x7w6v5u4t3s2r1q0p9"]
    );
    assert_eq!(*held_port_range, Some(Some([30000, 30999])));
    assert!(held_metric_commands_hash.clone().flatten().is_some());
    assert!(held_fabrics_hash.clone().flatten().is_some());
    assert_eq!(*frozen, Some(false));
    assert_eq!(node.as_ref().map(|n| n.status), Some(DefineStatus::Applied));
    let store = fx.store();
    assert_eq!(store.held.len(), 2);
    // The spec is kept exactly as received and still hashes to its launchHash.
    for held in &store.held {
        assert_eq!(launch_hash(&held.spec).expect("hash"), held.launch_hash);
    }
}

#[test]
fn relay_only_refuses_every_define_and_keeps_nothing() {
    let mut fx = Fx::new();
    let outcome = fx.send(&fixture("runtime.define.json"), TrustValue::Relay);
    assert!(!outcome.changed);
    assert!(
        results(&outcome.answer)
            .iter()
            .all(|(_, status, reason)| *status == DefineStatus::Rejected
                && *reason == Some(DefineRejectReason::TrustRelay))
    );
    let NodeFrame::RuntimeDefineResult { node, frozen, .. } = &outcome.answer else {
        panic!("result");
    };
    assert_eq!(
        node.as_ref().and_then(|n| n.reason),
        Some(DefineRejectReason::TrustRelay)
    );
    assert_eq!(*frozen, Some(true));
    assert!(fx.store().held.is_empty());
}

#[test]
fn a_spec_that_does_not_hash_to_its_launch_hash_is_refused() {
    let mut fx = Fx::new();
    let text = define(
        "op1",
        "vr1",
        "rt1",
        "bge",
        always_on("http://127.0.0.1:8080/v1"),
    );
    // The spec was edited after it was hashed.
    let tampered = text.replace("http://127.0.0.1:8080/v1", "http://127.0.0.1:8081/v1");
    let outcome = fx.send(&tampered, TrustValue::Full);
    assert_eq!(
        results(&outcome.answer),
        vec![(
            "vr1".to_string(),
            DefineStatus::Rejected,
            Some(DefineRejectReason::HashMismatch)
        )]
    );
    assert!(fx.store().held.is_empty());
}

#[test]
fn addresses_off_loopback_need_runtime_hosts() {
    let mut fx = Fx::new();
    let text = define(
        "op1",
        "vr1",
        "rt1",
        "lan",
        always_on("http://10.0.0.5:8000/v1"),
    );
    let refused = fx.send(&text, TrustValue::Full);
    assert_eq!(
        results(&refused.answer)[0].2,
        Some(DefineRejectReason::BaseUrlNotAllowed)
    );
    fx.hosts = vec!["10.0.0.5:8000".into()];
    let applied = fx.send(&text.replace("op1", "op2"), TrustValue::Full);
    assert_eq!(results(&applied.answer)[0].1, DefineStatus::Applied);
}

#[test]
fn slugs_conflict_across_runtimes_and_versions_never_change() {
    let mut fx = Fx::new();
    let spec = always_on("http://127.0.0.1:8080/v1");
    fx.send(
        &define("op1", "vr1", "rt1", "bge", spec.clone()),
        TrustValue::Full,
    );
    let other = fx.send(
        &define("op2", "vr2", "rt2", "bge", spec.clone()),
        TrustValue::Full,
    );
    assert_eq!(
        results(&other.answer)[0].2,
        Some(DefineRejectReason::Conflict)
    );
    let again = fx.send(&define("op3", "vr1", "rt1", "bge", spec), TrustValue::Full);
    assert_eq!(results(&again.answer)[0].1, DefineStatus::Unchanged);
    assert!(!again.changed);
    let changed = fx.send(
        &define(
            "op4",
            "vr1",
            "rt1",
            "bge",
            always_on("http://127.0.0.1:9090"),
        ),
        TrustValue::Full,
    );
    assert_eq!(
        results(&changed.answer)[0].2,
        Some(DefineRejectReason::Conflict)
    );
    // The same version under another slug is not the same version.
    let renamed = fx.send(
        &define(
            "op6",
            "vr1",
            "rt1",
            "renamed",
            always_on("http://127.0.0.1:8080/v1"),
        ),
        TrustValue::Full,
    );
    assert_eq!(
        results(&renamed.answer)[0].2,
        Some(DefineRejectReason::Conflict)
    );
    // A complete operation cannot end with two runtimes on one slug.
    let put = |version: &str, runtime: &str, base: &str| -> Value {
        serde_json::from_str::<Value>(&define("x", version, runtime, "bge", always_on(base)))
            .expect("json")["put"][0]
            .clone()
    };
    let complete = serde_json::json!({
        "type": "runtime.define", "opId": "op7", "chunkIndex": 0, "final": true, "complete": true,
        "put": [put("vr9", "rt9", "http://127.0.0.1:7000"), put("vr1", "rt1", "http://127.0.0.1:8080/v1")]
    })
    .to_string();
    let both = fx.send(&complete, TrustValue::Full);
    assert!(
        results(&both.answer)
            .iter()
            .any(|(_, _, reason)| *reason == Some(DefineRejectReason::Conflict))
    );
    let held = fx.store().held;
    assert_eq!(held.iter().filter(|h| h.slug == "bge").count(), 1);
    let instance_slug = fx.send(
        &define(
            "op5",
            "vr5",
            "rt5",
            "i-abcdefabcdef",
            always_on("http://127.0.0.1:1"),
        ),
        TrustValue::Full,
    );
    assert_eq!(
        results(&instance_slug.answer)[0].2,
        Some(DefineRejectReason::Invalid)
    );
}

#[test]
fn remove_drops_named_versions_and_complete_drops_the_rest() {
    let mut fx = Fx::new();
    for (op, version) in [("a", "vr1"), ("b", "vr2")] {
        fx.send(
            &define(
                op,
                version,
                "rt1",
                "bge",
                always_on("http://127.0.0.1:8080/v1"),
            ),
            TrustValue::Full,
        );
    }
    assert_eq!(fx.store().held.len(), 2);
    let remove = r#"{"type":"runtime.define","opId":"c","chunkIndex":0,"final":true,"remove":["vr1","vr-unknown"]}"#;
    let removed = fx.send(remove, TrustValue::Full);
    assert_eq!(
        results(&removed.answer),
        vec![("vr1".to_string(), DefineStatus::Removed, None)]
    );
    assert_eq!(fx.store().held.len(), 1);
    let complete =
        r#"{"type":"runtime.define","opId":"d","chunkIndex":0,"final":true,"complete":true}"#;
    let emptied = fx.send(complete, TrustValue::Full);
    assert!(emptied.changed);
    assert!(fx.store().held.is_empty());
}

#[test]
fn out_of_order_chunks_are_refused() {
    let mut fx = Fx::new();
    let text = fixture("runtime.define.json");
    let frame = parse_server_control(&text).expect("frame");
    let ctx = DefineContext {
        trust: TrustValue::Full,
        runtime_hosts: &[],
        busy_ports: &BTreeMap::new(),
    };
    // Chunk 1 without chunk 0.
    assert!(fx.defines.handle(&text, &frame, &ctx, &fx.live).is_err());
    assert!(fx.store().held.is_empty());
}

#[test]
fn a_tampered_node_part_is_refused() {
    let mut fx = Fx::new();
    let text = fixture("runtime.define.json")
        .replace("\"chunkIndex\": 1", "\"chunkIndex\": 0")
        .replace("--format=csv,noheader,nounits", "--format=csv");
    let outcome = fx.send(&text, TrustValue::Full);
    let NodeFrame::RuntimeDefineResult { node, .. } = &outcome.answer else {
        panic!("result");
    };
    assert_eq!(
        node.as_ref().and_then(|n| n.reason),
        Some(DefineRejectReason::HashMismatch)
    );
    assert!(fx.store().node.is_none());
}

#[test]
fn freezing_copies_once_and_relay_reads_the_copy() {
    let mut fx = Fx::new();
    fx.send(
        &define(
            "a",
            "vr1",
            "rt1",
            "bge",
            always_on("http://127.0.0.1:8080/v1"),
        ),
        TrustValue::Full,
    );
    freeze_at(&fx.live, &fx.frozen).expect("freeze");
    // A later change to the live file never reaches the frozen copy.
    fx.send(
        &define(
            "b",
            "vr2",
            "rt2",
            "other",
            always_on("http://127.0.0.1:8081/v1"),
        ),
        TrustValue::Full,
    );
    freeze_at(&fx.live, &fx.frozen).expect("freeze is idempotent");
    let relay = load_for_at(TrustValue::Relay, &fx.live, &fx.frozen).expect("relay");
    assert_eq!(relay.held.len(), 1);
    let full = load_for_at(TrustValue::Full, &fx.live, &fx.frozen).expect("full");
    assert_eq!(full.held.len(), 2);
}

#[test]
fn bind_warnings_follow_the_server_rule() {
    assert!(has_all_interfaces(
        "vllm serve m --host 0.0.0.0 --port 8000"
    ));
    assert!(has_all_interfaces("--host=::"));
    assert!(has_all_interfaces("--bind [::]:8000"));
    assert!(!has_all_interfaces("--host 127.0.0.1"));
    assert!(has_all_interfaces("cd x && vllm  serve m"));
    assert!(!has_all_interfaces("--host 10.0.0.0.5"));
    assert!(!has_all_interfaces("a::b"));
}
