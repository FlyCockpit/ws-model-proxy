use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};

use super::*;
use crate::file_ops::Step;

const WAIT: Duration = Duration::from_secs(10);

fn op_id(n: u8) -> String {
    URL_SAFE_NO_PAD.encode([n; 16])
}

fn runtime(euid: u32, allow_root: bool) -> Arc<FileRuntime> {
    let policy = Policy::from_environment(Vec::new(), allow_root).with_euid(euid);
    Arc::new(FileRuntime::new(FileOps::new(policy, EtagKey::random())))
}

struct Harness {
    relay: FileRelay,
    rx: Receiver<(String, Vec<FileFrame>)>,
}

fn harness_with(runtime: Arc<FileRuntime>, mode: McpCommandMode) -> Harness {
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    let sink: FileSink = Arc::new(move |op_id, frames| {
        let _ = tx.lock().expect("sink").send((op_id, frames));
    });
    Harness {
        relay: FileRelay::new(runtime, mode, false, sink),
        rx,
    }
}

fn harness() -> Harness {
    harness_with(runtime(1000, false), McpCommandMode::Unsupervised)
}

impl Harness {
    /// Next settled op, as its pending-checked frames.
    fn settled(&mut self) -> (String, Vec<FileFrame>, bool) {
        let (id, frames) = self.rx.recv_timeout(WAIT).expect("op settles");
        let current = self.relay.complete(&id);
        (id, frames, current)
    }
}

fn json_of(frame: &FileFrame) -> Value {
    match frame {
        FileFrame::Control(message) => serde_json::to_value(message).expect("json"),
        FileFrame::Binary(..) => panic!("expected a control frame"),
    }
}

fn only_control(frames: &[FileFrame]) -> Value {
    assert_eq!(frames.len(), 1, "{frames:?}");
    json_of(&frames[0])
}

fn path_str(path: &std::path::Path) -> String {
    path.to_str().expect("utf8").to_string()
}

#[test]
fn admit_is_a_pure_table_over_mode_and_root() {
    let normal = Policy::from_environment(Vec::new(), false).with_euid(1000);
    let root = Policy::from_environment(Vec::new(), false).with_euid(0);
    let root_ok = Policy::from_environment(Vec::new(), true).with_euid(0);
    let rows: [(McpCommandMode, &Policy, Result<(), &str>); 7] = [
        (McpCommandMode::Off, &normal, Err("feature_disabled")),
        (McpCommandMode::Supervised, &normal, Err("supervised_only")),
        (McpCommandMode::Unsupervised, &normal, Ok(())),
        (McpCommandMode::Unsupervised, &root, Err("unsupported")),
        (McpCommandMode::Unsupervised, &root_ok, Ok(())),
        // The mode refusal wins over the root refusal.
        (McpCommandMode::Off, &root, Err("feature_disabled")),
        (McpCommandMode::Supervised, &root, Err("supervised_only")),
    ];
    for (mode, policy, expected) in rows {
        assert_eq!(
            admit(
                mode,
                FilePermission {
                    mode: McpCommandMode::Unsupervised,
                    read_grant: false
                },
                true,
                false,
                policy.roots_configured(),
                policy.euid(),
                policy.allow_root()
            ),
            expected,
            "{mode:?}"
        );
    }
}

#[test]
fn read_grant_admit_matrix() {
    for mode in [
        McpCommandMode::Off,
        McpCommandMode::Supervised,
        McpCommandMode::Unsupervised,
    ] {
        for server_mode in [
            McpCommandMode::Off,
            McpCommandMode::Supervised,
            McpCommandMode::Unsupervised,
        ] {
            for read in [false, true] {
                for grant in [false, true] {
                    for switch in [false, true] {
                        for roots in [false, true] {
                            for euid in [0, 1000] {
                                for allow_root in [false, true] {
                                    let effective = mode.min(server_mode);
                                    let expected = if effective != McpCommandMode::Unsupervised
                                        && !(read && grant && switch && roots)
                                    {
                                        Err(if effective == McpCommandMode::Supervised {
                                            "supervised_only"
                                        } else if server_mode == McpCommandMode::Off {
                                            "grant_disabled"
                                        } else {
                                            "feature_disabled"
                                        })
                                    } else if euid == 0 && !allow_root {
                                        Err("unsupported")
                                    } else {
                                        Ok(())
                                    };
                                    assert_eq!(
                                        admit(
                                            mode,
                                            FilePermission {
                                                mode: server_mode,
                                                read_grant: grant
                                            },
                                            read,
                                            switch,
                                            roots,
                                            euid,
                                            allow_root
                                        ),
                                        expected,
                                        "local={mode:?} server={server_mode:?} read={read} grant={grant} switch={switch} roots={roots} euid={euid} allow_root={allow_root}"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn only_the_four_read_ops_are_read_class() {
    for op in ["read", "stat", "list", "search"] {
        assert!(is_read_op(op), "{op}");
    }
    for op in [
        "edit", "write", "rename", "mkdir", "delete", "", "READ", "read ", "unknown",
    ] {
        assert!(!is_read_op(op), "{op:?}");
    }
    assert_eq!(OPS.iter().filter(|op| is_read_op(op)).count(), 4);
}

#[test]
fn read_grant_admit_literal_rows() {
    use McpCommandMode::{Off, Supervised, Unsupervised};
    // (local, server, read, grant, switch, roots) -> result, at euid 1000.
    let rows = [
        (Supervised, Unsupervised, true, true, true, true, Ok(())),
        (Off, Unsupervised, true, true, true, true, Ok(())),
        (
            Supervised,
            Unsupervised,
            false,
            true,
            true,
            true,
            Err("supervised_only"),
        ),
        (
            Off,
            Unsupervised,
            false,
            true,
            true,
            true,
            Err("feature_disabled"),
        ),
        (
            Supervised,
            Unsupervised,
            true,
            false,
            true,
            true,
            Err("supervised_only"),
        ),
        (
            Supervised,
            Unsupervised,
            true,
            true,
            false,
            true,
            Err("supervised_only"),
        ),
        (
            Supervised,
            Unsupervised,
            true,
            true,
            true,
            false,
            Err("supervised_only"),
        ),
        (Unsupervised, Off, true, true, true, true, Ok(())),
        (
            Unsupervised,
            Off,
            true,
            false,
            true,
            true,
            Err("grant_disabled"),
        ),
        (
            Unsupervised,
            Unsupervised,
            false,
            false,
            false,
            false,
            Ok(()),
        ),
    ];
    for (local, server, read, grant, switch, roots, expected) in rows {
        let permission = FilePermission {
            mode: server,
            read_grant: grant,
        };
        assert_eq!(
            admit(local, permission, read, switch, roots, 1000, false),
            expected,
            "{local:?} {server:?} read={read} grant={grant} switch={switch} roots={roots}"
        );
    }
}

#[test]
fn local_read_consent_and_roots_are_rechecked_for_server_requests() {
    let dir = tempfile::tempdir().expect("root");
    let path = dir.path().join("plain.txt");
    std::fs::write(&path, "plain").expect("file");
    for mode in [McpCommandMode::Off, McpCommandMode::Supervised] {
        for switch in [false, true] {
            for roots in [false, true] {
                let policy = Policy::from_environment(
                    if roots {
                        vec![dir.path().to_path_buf()]
                    } else {
                        vec![]
                    },
                    false,
                )
                .with_euid(1000);
                let mut harness = harness_with(
                    Arc::new(FileRuntime::new(FileOps::new(policy, EtagKey::random()))),
                    mode,
                );
                harness.relay.read_switch = switch;
                let frames = harness.relay.handle_op(
                    &op_id(80),
                    "read",
                    json!({"path":path}),
                    None,
                    FilePermission {
                        mode: McpCommandMode::Unsupervised,
                        read_grant: true,
                    },
                );
                if switch && roots {
                    assert!(frames.is_empty());
                    assert_eq!(only_control(&harness.settled().1)["type"], "file.result");
                } else {
                    assert_eq!(
                        only_control(&frames)["reason"],
                        if mode == McpCommandMode::Off {
                            "feature_disabled"
                        } else {
                            "supervised_only"
                        }
                    );
                }
            }
        }
    }
    // Server lowers an unsupervised CLI to off without read permission.
    let mut harness = harness();
    let frames = harness.relay.handle_op(
        &op_id(81),
        "read",
        json!({"path":path}),
        None,
        FilePermission {
            mode: McpCommandMode::Off,
            read_grant: false,
        },
    );
    assert_eq!(only_control(&frames)["reason"], "grant_disabled");
}

#[test]
fn a_supervised_or_off_config_refuses_a_server_op_and_touches_nothing() {
    let dir = tempfile::tempdir().expect("dir");
    let target = dir.path().join("made");
    for (mode, reason) in [
        (McpCommandMode::Supervised, "supervised_only"),
        (McpCommandMode::Off, "feature_disabled"),
    ] {
        let mut harness = harness_with(runtime(1000, false), mode);
        let frames = harness.relay.handle_op(
            &op_id(1),
            "mkdir",
            json!({ "path": path_str(&target) }),
            None,
            FilePermission {
                mode: McpCommandMode::Unsupervised,
                read_grant: false,
            },
        );
        assert_eq!(
            only_control(&frames),
            json!({ "type": "file.rejected", "opId": op_id(1), "reason": reason })
        );
        assert_eq!(harness.relay.pending_len(), 0);
        assert!(harness.rx.try_recv().is_err());
        assert!(!target.exists());
    }
}

#[test]
fn euid_zero_is_refused_unless_allowed() {
    let dir = tempfile::tempdir().expect("dir");
    let target = dir.path().join("made");
    let mut refused = harness_with(runtime(0, false), McpCommandMode::Unsupervised);
    let frames = refused.relay.handle_op(
        &op_id(2),
        "mkdir",
        json!({ "path": path_str(&target) }),
        None,
        FilePermission {
            mode: McpCommandMode::Unsupervised,
            read_grant: false,
        },
    );
    assert_eq!(only_control(&frames)["reason"], "unsupported");
    assert!(!target.exists());

    let mut allowed = harness_with(runtime(0, true), McpCommandMode::Unsupervised);
    assert!(
        allowed
            .relay
            .handle_op(
                &op_id(2),
                "mkdir",
                json!({ "path": path_str(&target) }),
                None,
                FilePermission {
                    mode: McpCommandMode::Unsupervised,
                    read_grant: false
                }
            )
            .is_empty()
    );
    let (_, frames, current) = allowed.settled();
    assert!(current);
    assert_eq!(only_control(&frames)["result"], json!({ "created": true }));
    assert!(target.is_dir());
}

#[test]
fn malformed_ops_are_bad_frame_and_never_run() {
    let dir = tempfile::tempdir().expect("dir");
    let file = path_str(&dir.path().join("f"));
    let rows: Vec<(&str, &str, Value, Option<usize>)> = vec![
        ("unknown op", "chmod", json!({ "path": file }), None),
        ("args not an object", "read", json!("x"), None),
        ("args null", "stat", Value::Null, None),
        (
            "write without a body",
            "write",
            json!({ "path": file }),
            None,
        ),
        ("read with a body", "read", json!({ "path": file }), Some(3)),
        (
            "write body over 1 MiB",
            "write",
            json!({ "path": file }),
            Some(BODY_MAX_BYTES + 1),
        ),
        (
            "write with inline content",
            "write",
            json!({ "path": file, "content": "x" }),
            Some(1),
        ),
        (
            "write with inline encoding",
            "write",
            json!({ "path": file, "encoding": "base64" }),
            Some(1),
        ),
    ];
    let mut harness = harness();
    for (index, (name, op, args, body)) in rows.into_iter().enumerate() {
        let id = op_id(10 + index as u8);
        let frames = harness.relay.handle_op(
            &id,
            op,
            args,
            body,
            FilePermission {
                mode: McpCommandMode::Unsupervised,
                read_grant: false,
            },
        );
        assert_eq!(
            only_control(&frames),
            json!({ "type": "file.rejected", "opId": id, "reason": "bad_frame" }),
            "{name}"
        );
    }
    assert_eq!(harness.relay.pending_len(), 0);
    assert!(harness.rx.try_recv().is_err());
    // An op id that is not 16 bytes of base64url is dropped without an answer.
    assert!(
        harness
            .relay
            .handle_op(
                "short",
                "read",
                json!({ "path": file }),
                None,
                FilePermission {
                    mode: McpCommandMode::Unsupervised,
                    read_grant: false
                }
            )
            .is_empty()
    );
}

/// The wire refusal set, mirrored by `FILE_WIRE_REASONS` in
/// `apps/server/src/relay/file-protocol.ts`: every one must parse there, and
/// `admit` must only ever produce a member. Pinned so a new reason cannot be
/// added on one side only.
#[test]
fn wire_refusal_reasons_are_pinned_and_admit_only_produces_members() {
    assert_eq!(
        WIRE_REFUSAL_REASONS,
        [
            "bad_frame",
            "supervised_only",
            "grant_disabled",
            "feature_disabled"
        ]
    );
    // Every refusal `handle_op`/`admit` can emit, over the full consent table.
    // `unsupported` is a file error code (root without consent), accepted by
    // the server's union but NOT a wire reason the server enumerates
    // separately; the rest must be in WIRE_REFUSAL_REASONS.
    let file_error_codes = [
        crate::file_ops::ErrorCode::Unsupported.as_str(),
        crate::file_ops::ErrorCode::Limit.as_str(),
    ];
    let mut seen: Vec<&str> = Vec::new();
    for mode in [
        McpCommandMode::Off,
        McpCommandMode::Supervised,
        McpCommandMode::Unsupervised,
    ] {
        for (server_mode, read, grant, switch, roots, euid, allow_root) in [
            (
                McpCommandMode::Unsupervised,
                true,
                false,
                false,
                false,
                1000,
                false,
            ),
            (
                McpCommandMode::Supervised,
                true,
                true,
                true,
                true,
                1000,
                false,
            ),
            (McpCommandMode::Off, false, true, true, true, 1000, false),
            (
                McpCommandMode::Unsupervised,
                false,
                false,
                false,
                false,
                0,
                false,
            ),
        ] {
            if let Err(reason) = admit(
                mode,
                FilePermission {
                    mode: server_mode,
                    read_grant: grant,
                },
                read,
                switch,
                roots,
                euid,
                allow_root,
            ) {
                assert!(
                    WIRE_REFUSAL_REASONS.contains(&reason) || file_error_codes.contains(&reason),
                    "{reason} is neither a wire refusal nor a file error code"
                );
                seen.push(reason);
            }
        }
    }
    for expected in [
        "supervised_only",
        "grant_disabled",
        "feature_disabled",
        "unsupported",
    ] {
        assert!(seen.contains(&expected), "{expected} never produced");
    }
}

#[test]
fn every_refuse_reason_is_a_pinned_wire_reason_or_a_file_error_code() {
    // The reasons `refuse` is called with, read out of the module source so a
    // NEW call site cannot slip in without updating the pin. The server accepts
    // the union of FILE_WIRE_REASONS and FILE_ERROR_CODES; a reason outside it
    // makes the server fail the strict schema and settle the op as io_error.
    assert_eq!(
        REFUSE_REASONS,
        [
            "bad_frame",
            "supervised_only",
            "grant_disabled",
            "feature_disabled",
            "unsupported",
            "limit",
        ]
    );
    let file_error_codes = [
        crate::file_ops::ErrorCode::Unsupported.as_str(),
        crate::file_ops::ErrorCode::Limit.as_str(),
    ];
    for reason in REFUSE_REASONS {
        assert!(
            WIRE_REFUSAL_REASONS.contains(&reason) || file_error_codes.contains(&reason),
            "{reason} is neither a wire refusal nor a file error code"
        );
    }
    // `refuse` asserts this same set at runtime, so every exercised refusal path
    // (malformed frame, the pending cap, each `admit` reason) is covered.
}

#[test]
fn unknown_op_ids_are_ignored_not_fatal() {
    let mut harness = harness();
    harness.relay.handle_cancel(&op_id(3));
    assert!(
        harness
            .relay
            .handle_body(&op_id(3), b"x".to_vec())
            .is_empty()
    );
    assert!(!harness.relay.complete(&op_id(3)));
    assert_eq!(harness.relay.pending_len(), 0);
}

#[test]
fn a_read_returns_a_result_frame_with_the_etag() {
    let dir = tempfile::tempdir().expect("dir");
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "one\ntwo\n").expect("write");
    let mut harness = harness();
    assert!(
        harness
            .relay
            .handle_op(
                &op_id(4),
                "read",
                json!({ "path": path_str(&file) }),
                None,
                FilePermission {
                    mode: McpCommandMode::Unsupervised,
                    read_grant: false
                }
            )
            .is_empty()
    );
    let (id, frames, current) = harness.settled();
    assert_eq!(id, op_id(4));
    assert!(current);
    let frame = only_control(&frames);
    assert_eq!(frame["type"], "file.result");
    assert_eq!(frame["op"], "read");
    assert_eq!(frame["result"]["text"], "1|one\n2|two");
    assert!(
        frame["result"]["etag"]
            .as_str()
            .is_some_and(|e| e.starts_with("h:"))
    );
    assert!(frame.get("dataField").is_none());
}

#[test]
fn file_errors_become_file_rejected_with_only_the_documented_detail() {
    let dir = tempfile::tempdir().expect("dir");
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "one\n").expect("write");
    let mut harness = harness();
    // A stale etag is a `conflict` carrying `currentEtag`.
    harness.relay.handle_op(
        &op_id(5),
        "delete",
        json!({ "path": path_str(&file), "expectedEtag": "h:AAAAAAAAAAAAAAAAAAAAAA" }),
        None,
        FilePermission {
            mode: McpCommandMode::Unsupervised,
            read_grant: false,
        },
    );
    let (_, frames, _) = harness.settled();
    let frame = only_control(&frames);
    assert_eq!(frame["type"], "file.rejected");
    assert_eq!(frame["reason"], "conflict");
    assert!(frame["detail"]["currentEtag"].as_str().is_some());
    assert!(file.exists());

    assert_eq!(
        filter_detail(
            &json!({ "currentEtag": "h:AAAAAAAAAAAAAAAAAAAAAA", "secret": "leak", "lines": [1, 2] })
        ),
        Some(json!({ "currentEtag": "h:AAAAAAAAAAAAAAAAAAAAAA", "lines": [1, 2] }))
    );
    // Only etag-shaped text, or the library's `replaced`/`gone`, is a currentEtag.
    for word in ["replaced", "gone"] {
        assert_eq!(
            filter_detail(&json!({ "currentEtag": word })),
            Some(json!({ "currentEtag": word }))
        );
    }
    for bad in [
        "h:x",
        "wsmp_cli_secretsecretsecretsecret",
        "x:AAAAAAAAAAAAAAAAAAAAAA",
        "",
    ] {
        assert_eq!(filter_detail(&json!({ "currentEtag": bad })), None, "{bad}");
    }
    assert_eq!(filter_detail(&json!({ "etag": "gone" })), None);
    assert_eq!(filter_detail(&json!({ "lines": [1, 2, 3, 4, 5, 6] })), None);
    assert_eq!(filter_detail(&json!({ "sniff": 5 })), None);
    assert_eq!(filter_detail(&json!("x")), None);
}

#[test]
fn unsafe_filesystem_is_serialized_as_a_file_rejected_without_cli_text() {
    let (frames, code) = frames_for(
        "op",
        "rename",
        Err(FileError::new(
            ErrorCode::UnsafeFilesystem,
            "private CLI diagnostic",
        )),
    );
    assert_eq!(code, "unsafe_filesystem");
    assert_eq!(
        only_control(&frames),
        json!({ "type": "file.rejected", "opId": "op", "reason": "unsafe_filesystem" })
    );
}

#[test]
fn delete_recovered_is_optional_and_survives_result_frame_encoding() {
    for recovered in [
        Vec::new(),
        vec!["/workspace/.wsmp-recover-a1b2c3d4e5".to_string()],
    ] {
        let value = serde_json::to_value(crate::file_ops::mutate::DeleteResult {
            deleted: true,
            kind: "file",
            recovered: recovered.clone(),
        })
        .expect("delete result");
        if recovered.is_empty() {
            assert_eq!(value, json!({ "deleted": true, "type": "file" }));
        } else {
            assert_eq!(value["recovered"], json!(recovered));
        }
        let (frames, code) = frames_for("op", "delete", Ok(value.clone()));
        assert_eq!(code, "ok");
        assert_eq!(
            only_control(&frames),
            json!({ "type": "file.result", "opId": "op", "op": "delete", "result": value })
        );
    }
}

#[test]
fn a_delete_result_carries_retained_recovery_after_real_dispatch() {
    for kind in ["file", "symlink"] {
        for retain in [false, true] {
            let dir = tempfile::tempdir().expect("dir");
            let file = dir.path().join("delete-me");
            let target = dir.path().join("keep-target");
            std::fs::write(&target, "target bytes").expect("target");
            if kind == "file" {
                std::fs::write(&file, "delete bytes").expect("file");
            } else {
                std::os::unix::fs::symlink(&target, &file).expect("symlink");
            }
            let parent = dir.path().to_path_buf();
            let euid = nix::unistd::geteuid().as_raw();
            let policy = Policy::from_environment(Vec::new(), euid == 0).with_euid(euid);
            let ops =
                FileOps::new(policy, EtagKey::random()).with_step_hook(Arc::new(move |step| {
                    if retain && step == Step::Vacated {
                        let recovery = std::fs::read_dir(&parent)
                            .expect("parent entries")
                            .map(|entry| entry.expect("entry").path())
                            .find(|path| {
                                path.file_name().is_some_and(|name| {
                                    name.to_string_lossy().starts_with(".wsmp-recover-")
                                })
                            })
                            .expect("recovery directory");
                        std::fs::write(recovery.join("retained-object"), "retained bytes")
                            .expect("retain cleanup object");
                    }
                    Ok(())
                }));
            let mut harness = harness_with(
                Arc::new(FileRuntime::new(ops)),
                McpCommandMode::Unsupervised,
            );
            assert!(
                harness
                    .relay
                    .handle_op(
                        &op_id(30),
                        "delete",
                        json!({ "path": path_str(&file) }),
                        None,
                        FilePermission {
                            mode: McpCommandMode::Unsupervised,
                            read_grant: false,
                        },
                    )
                    .is_empty()
            );
            let (id, frames, current) = harness.settled();
            assert_eq!(id, op_id(30));
            assert!(current);
            let frame = only_control(&frames);
            assert_eq!(frame["type"], "file.result");
            assert_eq!(frame["op"], "delete");
            assert_eq!(frame["result"]["deleted"], true);
            assert_eq!(frame["result"]["type"], kind);
            assert!(std::fs::symlink_metadata(&file).is_err());
            assert_eq!(
                std::fs::read_to_string(&target).expect("target"),
                "target bytes"
            );
            if retain {
                let recovered = frame["result"]["recovered"].as_array().expect("recovered");
                assert_eq!(recovered.len(), 1);
                let recovery = std::path::Path::new(recovered[0].as_str().expect("absolute path"));
                assert!(recovery.is_absolute());
                assert_eq!(
                    std::fs::read_to_string(recovery.join("retained-object")).expect("retained"),
                    "retained bytes"
                );
            } else {
                assert!(frame["result"].get("recovered").is_none());
            }
        }
    }
}

#[test]
fn uncertain_outcome_recovery_facts_survive_the_detail_filter_as_a_pair() {
    let facts = json!({ "recovery": "/w/.wsmp-recover-AAAAAAAAAA", "kept": ["/w/.wsmp-recover-AAAAAAAAAA/slot-1"] });
    assert_eq!(filter_detail(&facts), Some(facts.clone()));
    // the whole wire path: the error's detail reaches the rejected frame
    let error = ErrorCode::UncertainOutcome;
    let (frames, code) = frames_for(
        "op",
        "edit",
        Err(FileError::new(error, "uncertain").with_detail(facts.clone())),
    );
    assert_eq!(code, "uncertain_outcome");
    let frame = only_control(&frames);
    assert_eq!(frame["reason"], "uncertain_outcome");
    assert_eq!(frame["detail"], facts);
    // the server accepts the facts only together and only as bounded absolute paths
    assert_eq!(filter_detail(&json!({ "recovery": "/w/r" })), None);
    assert_eq!(filter_detail(&json!({ "kept": ["/w/r/slot-1"] })), None);
    assert_eq!(
        filter_detail(&json!({ "recovery": "relative", "kept": ["/w/r/slot-1"] })),
        None
    );
    assert_eq!(
        filter_detail(&json!({ "recovery": "/w/r", "kept": ["/a", "/b", "/c", "/d", "/e"] })),
        None
    );
    let long = format!("/{}", "a".repeat(8192));
    assert_eq!(
        filter_detail(&json!({ "recovery": long, "kept": ["/w/r/slot-1"] })),
        None
    );
}

#[test]
fn a_write_waits_for_its_body_then_runs_with_base64_content() {
    let dir = tempfile::tempdir().expect("dir");
    let file = dir.path().join("w.bin");
    let mut harness = harness();
    let content = b"line1\nline2\n".to_vec();
    assert!(
        harness
            .relay
            .handle_op(
                &op_id(6),
                "write",
                json!({ "path": path_str(&file) }),
                Some(content.len()),
                FilePermission {
                    mode: McpCommandMode::Unsupervised,
                    read_grant: false
                }
            )
            .is_empty()
    );
    // Nothing runs before the body arrives.
    assert!(harness.rx.try_recv().is_err());
    assert!(!file.exists());
    assert!(
        harness
            .relay
            .handle_body(&op_id(6), content.clone())
            .is_empty()
    );
    let (_, frames, current) = harness.settled();
    assert!(current);
    let frame = only_control(&frames);
    assert_eq!(frame["result"]["created"], true);
    assert_eq!(std::fs::read(&file).expect("read"), content);
    // A second body for the settled op is dropped.
    assert!(
        harness
            .relay
            .handle_body(&op_id(6), b"again".to_vec())
            .is_empty()
    );
}

#[test]
fn a_body_of_the_wrong_size_is_bad_frame_and_writes_nothing() {
    let dir = tempfile::tempdir().expect("dir");
    let file = dir.path().join("w.txt");
    for body in [&b"toolong!"[..], &b"sh"[..], &b""[..]] {
        let mut harness = harness();
        harness.relay.handle_op(
            &op_id(7),
            "write",
            json!({ "path": path_str(&file) }),
            Some(5),
            FilePermission {
                mode: McpCommandMode::Unsupervised,
                read_grant: false,
            },
        );
        let frames = harness.relay.handle_body(&op_id(7), body.to_vec());
        assert_eq!(
            only_control(&frames),
            json!({ "type": "file.rejected", "opId": op_id(7), "reason": "bad_frame" })
        );
        assert_eq!(harness.relay.pending_len(), 0);
        assert!(!file.exists());
    }
}

#[test]
fn a_write_whose_body_never_arrives_expires() {
    let dir = tempfile::tempdir().expect("dir");
    let file = dir.path().join("w.txt");
    let mut harness = harness();
    harness.relay.handle_op(
        &op_id(8),
        "write",
        json!({ "path": path_str(&file) }),
        Some(2),
        FilePermission {
            mode: McpCommandMode::Unsupervised,
            read_grant: false,
        },
    );
    assert!(harness.relay.expire_stale(Instant::now()).is_empty());
    let frames = harness.relay.expire_stale(Instant::now() + BODY_WAIT);
    assert_eq!(only_control(&frames)["reason"], "bad_frame");
    assert_eq!(harness.relay.pending_len(), 0);
    // The late body is dropped.
    assert!(
        harness
            .relay
            .handle_body(&op_id(8), b"ab".to_vec())
            .is_empty()
    );
    assert!(!file.exists());
}

#[test]
fn a_marker_in_write_content_is_still_refused_after_injection() {
    let dir = tempfile::tempdir().expect("dir");
    let file = dir.path().join("m.txt");
    let mut harness = harness();
    let body = "KEY=\u{27e6}redacted:5\u{27e7}".as_bytes().to_vec();
    harness.relay.handle_op(
        &op_id(9),
        "write",
        json!({ "path": path_str(&file) }),
        Some(body.len()),
        FilePermission {
            mode: McpCommandMode::Unsupervised,
            read_grant: false,
        },
    );
    harness.relay.handle_body(&op_id(9), body);
    let (_, frames, _) = harness.settled();
    assert_eq!(only_control(&frames)["reason"], "redacted_span");
    assert!(!file.exists());
}

#[test]
fn a_result_over_48_kib_spills_its_text_into_a_file_data_frame() {
    let dir = tempfile::tempdir().expect("dir");
    let file = dir.path().join("big.txt");
    let text: String = (0..2000).map(|n| format!("line {n:0>40}\n")).collect();
    std::fs::write(&file, &text).expect("write");
    let mut harness = harness();
    harness.relay.handle_op(
        &op_id(20),
        "read",
        json!({ "path": path_str(&file), "maxLines": 2000, "maxBytes": 131072, "lineNumbers": false }),
        None, FilePermission { mode: McpCommandMode::Unsupervised, read_grant: false });
    let (_, frames, current) = harness.settled();
    assert!(current);
    assert_eq!(frames.len(), 2, "{frames:?}");
    let result = json_of(&frames[0]);
    assert_eq!(result["type"], "file.result");
    assert_eq!(result["result"]["text"], "");
    assert_eq!(result["dataField"], "text");
    let FileFrame::Binary(RelayBinaryFrameMetadata::FileData { op_id: data_id }, body) = &frames[1]
    else {
        panic!("expected file.data");
    };
    assert_eq!(data_id, &op_id(20));
    assert_eq!(result["bodyBytes"], body.len());
    assert!(body.len() > INLINE_TEXT_MAX_BYTES);
    assert!(body.starts_with(b"line 000"));
}

#[test]
fn text_at_the_inline_limit_stays_inline() {
    let big = Value::String("x".repeat(INLINE_TEXT_MAX_BYTES));
    let (kept, data) = split_result("read", json!({ "text": big.clone() })).expect("split");
    assert!(data.is_none());
    assert_eq!(kept["text"], big);
    let over = Value::String("x".repeat(INLINE_TEXT_MAX_BYTES + 1));
    let (moved, data) = split_result("list", json!({ "entries": over })).expect("split");
    assert_eq!(moved["entries"], "");
    assert_eq!(data.expect("data").0, "entries");
    // Ops without a text field never spill.
    assert!(
        split_result("stat", json!({ "entries": [] }))
            .expect("split")
            .1
            .is_none()
    );
}

#[test]
fn a_committed_mutation_whose_result_is_too_big_is_never_a_definitive_refusal() {
    // 10,000 separated matches: the hunk list alone is over one control frame.
    let hunks: Vec<Value> = (0..10_000).map(|n| json!([n * 2, 1])).collect();
    let result = json!({
        "etag": "h:AAAAAAAAAAAAAAAAAAAAAA",
        "previousEtag": "h:BBBBBBBBBBBBBBBBBBBBBB",
        "added": 10_000,
        "removed": 10_000,
        "applied": true,
        "hunks": hunks,
    });
    let frames = settle(
        &op_id(22),
        &summarize("edit", &json!({ "path": "/a" })),
        Ok(result),
    );
    let message = only_control(&frames);
    assert_eq!(message["type"], "file.result");
    assert!(message["result"].get("hunks").is_none());
    assert_eq!(message["result"]["applied"], true);
    // A read that is too big is still a plain too_large (nothing was changed).
    let read = settle(
        &op_id(23),
        &summarize("stat", &json!({ "paths": ["/a"] })),
        Ok(
            json!({ "entries": (0..50).map(|n| json!({ "path": format!("/{}{n}", "p".repeat(3000)) })).collect::<Vec<_>>() }),
        ),
    );
    assert_eq!(only_control(&read)["reason"], "too_large");
}

#[test]
fn a_control_frame_over_64_kib_after_spilling_is_too_large() {
    let paths: Vec<Value> = (0..50)
        .map(|n| json!({ "path": format!("/{}{n}", "p".repeat(3000)) }))
        .collect();
    let frames = settle(
        &op_id(21),
        &summarize("stat", &json!({ "paths": ["/a"] })),
        Ok(json!({ "entries": paths })),
    );
    assert_eq!(only_control(&frames)["reason"], "too_large");
}

#[test]
fn cancelling_before_the_commit_point_leaves_the_file_alone_and_drops_the_result() {
    let dir = tempfile::tempdir().expect("dir");
    let file = dir.path().join("keep.txt");
    std::fs::write(&file, "original\n").expect("write");
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let reached = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let hook_gate = Arc::clone(&gate);
    let hook_reached = Arc::clone(&reached);
    // The real euid: the owner check of the replace must see the real file owner.
    let euid = nix::unistd::geteuid().as_raw();
    let policy = Policy::from_environment(Vec::new(), euid == 0).with_euid(euid);
    // Pause the atomic replace after its etag re-check, just before the
    // cancel check that guards `renameat`.
    let ops = FileOps::new(policy, EtagKey::random()).with_step_hook(Arc::new(move |step| {
        if step == Step::EtagRechecked {
            *hook_reached.0.lock().expect("reached") = true;
            hook_reached.1.notify_all();
            let mut open = hook_gate.0.lock().expect("gate");
            while !*open {
                open = hook_gate.1.wait(open).expect("gate wait");
            }
        }
        Ok(())
    }));
    let mut harness = harness_with(
        Arc::new(FileRuntime::new(ops)),
        McpCommandMode::Unsupervised,
    );
    // The etag key is per runtime: read through this one.
    harness.relay.handle_op(
        &op_id(30),
        "read",
        json!({ "path": path_str(&file) }),
        None,
        FilePermission {
            mode: McpCommandMode::Unsupervised,
            read_grant: false,
        },
    );
    let (_, frames, _) = harness.settled();
    let etag = only_control(&frames)["result"]["etag"]
        .as_str()
        .expect("etag")
        .to_string();

    harness.relay.handle_op(
        &op_id(32),
        "write",
        json!({ "path": path_str(&file), "ifExists": "replace", "expectedEtag": etag }),
        Some(3),
        FilePermission {
            mode: McpCommandMode::Unsupervised,
            read_grant: false,
        },
    );
    harness.relay.handle_body(&op_id(32), b"new".to_vec());
    {
        let (lock, cv) = &*reached;
        let guard = lock.lock().expect("reached");
        let (guard, timeout) = cv
            .wait_timeout_while(guard, WAIT, |fired| !*fired)
            .expect("wait");
        assert!(
            *guard && !timeout.timed_out(),
            "the replace never reached its commit check"
        );
    }
    harness.relay.handle_cancel(&op_id(32));
    *gate.0.lock().expect("gate") = true;
    gate.1.notify_all();
    let (_, frames, current) = harness.settled();
    assert!(!current, "a cancelled op's frames are dropped by the loop");
    assert_eq!(only_control(&frames)["reason"], "cancelled");
    assert_eq!(std::fs::read_to_string(&file).expect("read"), "original\n");
    // No temp file is left behind.
    let names: Vec<_> = std::fs::read_dir(dir.path())
        .expect("dir")
        .map(|entry| entry.expect("entry").file_name())
        .collect();
    assert_eq!(names.len(), 1, "{names:?}");
}

#[test]
fn dropping_the_session_cancels_every_pending_op() {
    let dir = tempfile::tempdir().expect("dir");
    let file = dir.path().join("p.txt");
    let mut harness = harness();
    harness.relay.handle_op(
        &op_id(40),
        "write",
        json!({ "path": path_str(&file) }),
        Some(2),
        FilePermission {
            mode: McpCommandMode::Unsupervised,
            read_grant: false,
        },
    );
    let cancel = harness
        .relay
        .pending
        .get(&op_id(40))
        .expect("pending")
        .cancel
        .clone();
    assert!(!cancel.is_cancelled());
    drop(harness);
    assert!(cancel.is_cancelled());
}

#[test]
fn every_op_is_logged_once_by_the_settle_point_without_content() {
    use std::io::Write;
    use std::sync::Mutex as StdMutex;

    #[derive(Clone)]
    struct Buf(Arc<StdMutex<Vec<u8>>>);
    impl Write for Buf {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("buf").extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let buf = Buf(Arc::new(StdMutex::new(Vec::new())));
    let writer = buf.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .finish();
    let secret = "TOP-SECRET-CONTENT";
    let args =
        json!({ "path": "~/a\u{202e}b", "reason": "why\nnow", "edits": [{"newText": secret}] });
    tracing::subscriber::with_default(subscriber, || {
        let frames = settle(
            &op_id(50),
            &summarize("edit", &args),
            Err(FileError::new(ErrorCode::NoMatch, secret)),
        );
        assert_eq!(only_control(&frames)["reason"], "no_match");
        let frames = settle(
            &op_id(51),
            &summarize("rename", &json!({ "from": "/a", "to": "/b" })),
            Ok(json!({ "etag": null })),
        );
        assert_eq!(only_control(&frames)["type"], "file.result");
    });
    let log = String::from_utf8(buf.0.lock().expect("buf").clone()).expect("utf8");
    assert!(!log.contains(secret), "{log}");
    assert_eq!(log.matches("file op").count(), 2, "{log}");
    assert!(log.contains("op=edit"), "{log}");
    assert!(log.contains("outcome=no_match"), "{log}");
    assert!(log.contains("target=/a -> /b"), "{log}");
    // Control characters in an agent-supplied path or reason are escaped.
    assert!(log.contains("\\u{202e}"), "{log}");
    assert!(
        log.contains("why\\\\nnow") || log.contains("why\\nnow"),
        "{log}"
    );
}

#[test]
fn summaries_show_paths_but_never_content() {
    let summary = summarize(
        "stat",
        &json!({ "paths": ["/a", "/b", "/c"], "hash": true }),
    );
    assert_eq!(summary.target, "/a (+2 more)");
    assert_eq!(
        summarize("search", &json!({ "root": "/r", "pattern": "SECRET" })).target,
        "/r"
    );
    let write = summarize("write", &json!({ "path": "/w", "reason": "r" }));
    assert_eq!((write.op.as_str(), write.target.as_str()), ("write", "/w"));
    assert_eq!(summarize("bogus", &json!({})).op, "unknown");
}

#[test]
fn shared_runtime_keeps_configured_roots() {
    let dir = tempfile::tempdir().expect("root");
    let runtime = shared_runtime(true, &[dir.path().to_path_buf()]);
    assert!(runtime.policy().roots_configured());
    assert_eq!(
        runtime
            .policy()
            .check_path(
                crate::file_ops::policy::Access::Read,
                std::path::Path::new("/outside/plain")
            )
            .expect_err("outside root")
            .code,
        ErrorCode::PathDenied
    );
}
