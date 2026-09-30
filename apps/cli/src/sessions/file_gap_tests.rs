// Issue #106 acceptance gaps. These drive the registry's real prepare/apply
// workers; the scripted child supplies keys/markers but never mutates disk.
use crate::protocol::{ServerControlMessage, parse_server_control};

#[test]
fn supervised_registry_guard_matrix() {
    use crate::file_ops::{EtagKey, FileOps, Policy, Step};
    for case in [
        "phase",
        "generation",
        "starting-marker",
        "blocked-marker",
        "replay",
        "duplicate",
        "callback-before-apply",
        "callback-settled",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("new");
        if case == "blocked-marker" {
            std::fs::write(&target, b"blocked file").unwrap();
        }
        let before = gap_disk_tree(dir.path());
        let (reached_tx, reached_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let release_rx = Mutex::new(release_rx);
        let ops = FileOps::new(Policy::from_environment(vec![], true), EtagKey::random())
            .with_step_hook(Arc::new(move |step| {
                if step == Step::EtagRechecked {
                    reached_tx.send(()).unwrap();
                    let _ = release_rx
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(10));
                }
                Ok(())
            }));
        let runtime = Arc::new(crate::file_relay::FileRuntime::new(ops));
        let (tx, rx) = channel();
        let mut terminals = supervised_registry(tx, &fake_file_confirm(None));
        terminals.set_file_runtime(Arc::clone(&runtime));
        let startup = supervised_startup(McpCommandMode::Supervised, false);
        let request = file_spawn_request("mkdir", serde_json::json!({"path":target}), None);
        let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &request);
        pump_file_until(&mut terminals, &rx, &startup, &mut frames, |t, _| {
            phase(t) == Some(SupervisedPhase::Confirm)
        });
        frames.clear();
        let supervised = terminals
            .sessions
            .get_mut(MULTI_TERMINAL)
            .unwrap()
            .supervised
            .as_mut()
            .unwrap();
        let generation = supervised.file.as_ref().unwrap().generation;
        let marker = "00112233445566778899aabbccddeeff";
        supervised.child.scanner = supervised_pty::MarkerScanner::new(marker);
        supervised
            .child
            .scanner
            .feed(&supervised_marker("ready", marker));
        let accepted = supervised_marker("accepted", marker);
        let after_send = || FileApplyAfterSend {
            terminal_id: MULTI_TERMINAL.to_owned(),
            command_id: request.command_id.clone(),
            generation,
        };
        match case {
            "phase" => {
                frames.extend(terminals.queue_file_apply(after_send()));
            }
            "generation" => {
                // A stale continuation finds the same command id on a NEW generation.
                supervised.phase = SupervisedPhase::Running;
                supervised.file.as_mut().unwrap().generation = generation.wrapping_add(1);
                frames.extend(terminals.queue_file_apply(after_send()));
            }
            "starting-marker" | "blocked-marker" => {
                if case == "starting-marker" {
                    supervised.phase = SupervisedPhase::Starting;
                } else {
                    assert!(supervised.file.as_ref().unwrap().blocked.is_some());
                }
                terminals
                    .on_bytes_with_startup(&startup, MULTI_TERMINAL, &accepted)
                    .transmit(&mut terminals, |out| {
                        frames.extend(out);
                        Ok::<_, ()>(())
                    })
                    .unwrap();
            }
            "callback-before-apply" | "callback-settled" => {
                let file = supervised.file.as_mut().unwrap();
                file.applied = case == "callback-settled";
                file.settled = case == "callback-settled";
                frames.extend(terminals.on_file_applied(
                    &request.command_id,
                    generation,
                    Ok(serde_json::json!({"created":true})),
                ));
            }
            _ => {
                terminals
                    .on_bytes_with_startup(&startup, MULTI_TERMINAL, &accepted)
                    .transmit(&mut terminals, |out| {
                        frames.extend(out);
                        Ok::<_, ()>(())
                    })
                    .unwrap();
                reached_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                assert_eq!(runtime.apply_submissions(), 1, "{case}");
                assert!(!target.exists());
                frames.clear();
                if case == "replay" {
                    let child = &mut terminals
                        .sessions
                        .get_mut(MULTI_TERMINAL)
                        .unwrap()
                        .supervised
                        .as_mut()
                        .unwrap()
                        .child;
                    child.scanner = supervised_pty::MarkerScanner::new(marker);
                    child.scanner.feed(&supervised_marker("ready", marker));
                    terminals
                        .on_bytes_with_startup(&startup, MULTI_TERMINAL, &accepted)
                        .transmit(&mut terminals, |out| {
                            frames.extend(out);
                            Ok::<_, ()>(())
                        })
                        .unwrap();
                } else {
                    frames.extend(terminals.queue_file_apply(after_send()));
                }
            }
        }
        let submissions = runtime.apply_submissions();
        let after = gap_disk_tree(dir.path());
        // Release even a mutant's worker before an assertion can unwind.
        terminals.close(MULTI_TERMINAL);
        let _ = release_tx.send(());
        assert!(
            !outcome_kinds(&frames).contains(&"accepted"),
            "invalid/replayed accepted: {case}"
        );
        assert!(
            !outcome_kinds(&frames).contains(&"done"),
            "premature/duplicate fileResult: {case}"
        );
        assert_eq!(
            submissions,
            usize::from(matches!(case, "replay" | "duplicate")),
            "{case}"
        );
        assert_eq!(after, before, "{case}");
    }
}

#[test]
fn supervised_confirm_exit_waits_for_apply_and_only_a_person_declines() {
    use crate::file_ops::{ErrorCode, EtagKey, FileError, FileOps, Policy, Step};
    for case in ["success", "error", "decline", "invalid", "failed-go"] {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("new");
        let (reached_tx, reached_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let release_rx = Mutex::new(release_rx);
        let ops = FileOps::new(Policy::from_environment(vec![], true), EtagKey::random())
            .with_step_hook(Arc::new(move |step| {
                if step == Step::EtagRechecked {
                    reached_tx.send(()).unwrap();
                    let _ = release_rx
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(10));
                    if case == "error" {
                        return Err(FileError::new(ErrorCode::IoError, "injected"));
                    }
                }
                Ok(())
            }));
        let runtime = Arc::new(crate::file_relay::FileRuntime::new(ops));
        let (tx, rx) = channel();
        let script = if case == "invalid" {
            "printf '\\033]7717;wsmp-supervised;ready;%s\\007' \"$WSMP_SUPERVISED_MARKER\"\nIFS= read -r line\nprintf '\\033]7717;wsmp-supervised;garbage;%s\\007' \"$WSMP_SUPERVISED_MARKER\"\nexit 0\n".to_owned()
        } else if case == "failed-go" {
            r#"printf '\033]7717;wsmp-supervised;ready;%s\007' "$WSMP_SUPERVISED_MARKER"
IFS= read -r line
printf '\033]7717;wsmp-supervised;accepted;%s\007' "$WSMP_SUPERVISED_MARKER"
exit 0
"#
            .to_owned()
        } else {
            fake_file_confirm(None)
        };
        let mut terminals = supervised_registry(tx, &script);
        terminals.set_file_runtime(Arc::clone(&runtime));
        let startup = supervised_startup(McpCommandMode::Supervised, false);
        let request = file_spawn_request("mkdir", serde_json::json!({"path":target}), None);
        let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &request);
        pump_file_until(&mut terminals, &rx, &startup, &mut frames, |t, _| {
            phase(t) == Some(SupervisedPhase::Confirm)
        });
        let mut viewer = TestViewer::new(91);
        frames.extend(attach_viewer(&mut terminals, &startup, &mut viewer));
        let label = viewer.id.clone();
        frames.extend(send(
            &mut terminals,
            &mut viewer,
            &label,
            &TermPlaintextV2::Data(if case == "decline" {
                b"q\r".to_vec()
            } else {
                b"\r".to_vec()
            }),
        ));
        if case == "failed-go" {
            // Hold the child's genuine accepted bytes until the writer fails.
            // EOF stays behind those bytes in the worker channel.
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut marker_bytes = Vec::new();
            loop {
                assert!(Instant::now() < deadline);
                if let Ok(FromWorker::TerminalBytes { terminal_id, bytes }) =
                    rx.recv_timeout(Duration::from_millis(20))
                {
                    marker_bytes.extend_from_slice(&bytes);
                    let accepted = marker_bytes
                        .windows(b";accepted;".len())
                        .any(|w| w == b";accepted;");
                    if accepted {
                        terminals.sessions[MULTI_TERMINAL]
                            .pty
                            .as_ref()
                            .unwrap()
                            .input
                            .fail();
                    }
                    terminals
                        .on_bytes_with_startup(&startup, &terminal_id, &bytes)
                        .transmit(&mut terminals, |out| {
                            frames.extend(out);
                            Ok::<_, ()>(())
                        })
                        .unwrap();
                    if accepted {
                        break;
                    }
                }
            }
        }
        if matches!(case, "decline" | "invalid" | "failed-go") {
            pump_file_until(&mut terminals, &rx, &startup, &mut frames, has_exit);
            assert_eq!(
                outcome_kinds(&frames)
                    .iter()
                    .filter(|k| **k == "declined")
                    .count(),
                usize::from(case == "decline"),
                "{case}"
            );
            assert!(!outcome_kinds(&frames).contains(&"done"));
            assert_eq!(runtime.apply_submissions(), 0);
        } else {
            // The real child reads go and exits, while the real worker is held.
            pump_file_until(&mut terminals, &rx, &startup, &mut frames, |t, _| {
                t.sessions
                    .get(MULTI_TERMINAL)
                    .is_none_or(|s| s.pty.is_none())
            });
            reached_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(phase(&terminals), Some(SupervisedPhase::Running));
            assert!(!outcome_kinds(&frames).contains(&"done"));
            assert!(!outcome_kinds(&frames).contains(&"declined"));
            assert_eq!(runtime.apply_submissions(), 1);
            assert!(!target.exists());
            release_tx.send(()).unwrap();
            pump_file_until(&mut terminals, &rx, &startup, &mut frames, has_exit);
            let done = gap_done(&frames);
            if case == "success" {
                assert_eq!(done["fileResult"]["op"], "mkdir");
                assert!(done.get("fileError").is_none());
            } else {
                assert_eq!(done["fileError"]["code"], "io_error");
                assert!(done.get("fileResult").is_none());
            }
            assert_eq!(
                outcome_kinds(&frames)
                    .iter()
                    .filter(|k| **k == "accepted")
                    .count(),
                1
            );
        }
        assert_eq!(target.exists(), case == "success");
    }
}

#[test]
fn supervised_private_body_exclusive_open_exit_cleanup_and_drop() {
    let collided = Arc::new(Mutex::new(None));
    let recorded = Arc::clone(&collided);
    let result = PrivateBody::create_with(b"approved", move |path| {
        *recorded.lock().unwrap() = Some(path.to_owned());
        std::fs::write(path, b"existing")
    });
    assert!(matches!(result, Err(ref error) if error.kind() == std::io::ErrorKind::AlreadyExists));
    let path = collided.lock().unwrap().clone().unwrap();
    assert!(!path.exists());
    assert!(!path.parent().unwrap().exists());
    for end in ["drop", "forced-exit"] {
        let body = PrivateBody::create(b"approved").unwrap();
        let path = body.path.clone();
        let directory = body.directory.clone();
        if end == "forced-exit" {
            body._exit_cleanup.run_registered();
        } else {
            drop(body);
        }
        assert!(!path.exists(), "{end}");
        assert!(!directory.exists(), "{end}");
    }
}

#[test]
fn supervised_body_wait_exact_deadline() {
    let (tx, _rx) = channel();
    let mut terminals = supervised_file_registry(tx, &fake_file_confirm(None));
    let startup = supervised_startup(McpCommandMode::Supervised, false);
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("new");
    let request = file_spawn_request("write", serde_json::json!({"path":target}), Some(1));
    assert!(
        terminals
            .spawn_supervised(&startup, &Config::default(), &request)
            .is_empty()
    );
    let created = terminals.pending_files[&request.command_id].created;
    assert!(
        terminals
            .poll_with_startup(
                &startup,
                created + SUPERVISED_BODY_WAIT - Duration::from_nanos(1)
            )
            .is_empty()
    );
    assert!(terminals.pending_files.contains_key(&request.command_id));
    let frames = terminals.poll_with_startup(&startup, created + SUPERVISED_BODY_WAIT);
    assert_eq!(controls(&frames).len(), 1);
    assert_eq!(
        serde_json::to_value(controls(&frames)[0]).unwrap()["reason"],
        "bad_frame"
    );
    assert!(!terminals.pending_files.contains_key(&request.command_id));
    assert!(!target.exists());
}

fn gap_disk_tree(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    fn visit(root: &Path, path: &Path, entries: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
        for entry in std::fs::read_dir(path).expect("directory") {
            let path = entry.expect("entry").path();
            let relative = path.strip_prefix(root).unwrap().to_owned();
            if path.is_dir() {
                entries.insert(relative, None);
                visit(root, &path, entries);
            } else {
                entries.insert(relative, Some(std::fs::read(path).expect("file")));
            }
        }
    }
    let mut entries = BTreeMap::new();
    visit(root, root, &mut entries);
    entries
}

fn gap_done(frames: &[OutboundFrame]) -> serde_json::Value {
    let done = controls(frames)
        .into_iter()
        .filter(|frame| matches!(frame, ClientControlMessage::SupervisedDone { .. }))
        .collect::<Vec<_>>();
    assert_eq!(done.len(), 1, "exactly one done");
    let encoded = serde_json::to_value(done[0]).unwrap();
    assert_eq!(encoded["review"], false);
    assert!(encoded.get("outcome").is_none());
    assert!(!outcome_kinds(frames).contains(&"declined"));
    encoded
}

fn gap_private_body(terminals: &TerminalRegistry) -> Option<(PathBuf, PathBuf)> {
    terminals.sessions[MULTI_TERMINAL]
        .supervised
        .as_ref()
        .unwrap()
        .file
        .as_ref()
        .unwrap()
        ._body
        .as_ref()
        .map(|body| (body.path.clone(), body.directory.clone()))
}

fn gap_assert_body_removed(body: Option<(PathBuf, PathBuf)>) {
    if let Some((path, directory)) = body {
        assert!(!path.exists(), "private body leaked");
        assert!(!directory.exists(), "private body directory leaked");
    }
}

#[test]
fn gap_supervised_cancel_after_go_obeys_the_commit_point() {
    use crate::file_ops::{EtagKey, FileOps, Policy, Step};

    for step_to_cancel in [Step::TempSynced, Step::Renamed, Step::BeforeDirSync] {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("file");
        std::fs::write(&target, b"old").unwrap();
        let before = gap_disk_tree(dir.path());
        let (reached_tx, reached_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let release_rx = Mutex::new(release_rx);
        let key = EtagKey::random();
        let stat =
            crate::file_ops::resolve::Stat::from_metadata(&std::fs::metadata(&target).unwrap());
        let etag = key.strong(&stat, b"old");
        let ops = FileOps::new(Policy::from_environment(vec![], true), key).with_step_hook(
            Arc::new(move |step| {
                if step == step_to_cancel {
                    reached_tx.send(()).unwrap();
                    release_rx
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(10))
                        .unwrap();
                }
                if step_to_cancel == Step::BeforeDirSync && step == Step::BeforeDirSync {
                    // A failed completion after commit must not become a
                    // definitive cancelled result, even with cancellation set.
                    return Err(crate::file_ops::FileError::cancelled());
                }
                Ok(())
            }),
        );
        let (tx, rx) = channel();
        let mut terminals = supervised_registry(tx, &fake_file_confirm(None));
        terminals.set_file_runtime(Arc::new(crate::file_relay::FileRuntime::new(ops)));
        let startup = supervised_startup(McpCommandMode::Supervised, false);
        let request = file_spawn_request(
            "write",
            serde_json::json!({
                "path":target, "ifExists":"replace", "expectedEtag":etag
            }),
            Some(3),
        );
        let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &request);
        frames.extend(
            terminals
                .handle_supervised_body(&startup, &request.command_id, b"new".to_vec())
                .unwrap(),
        );
        pump_file_until(
            &mut terminals,
            &rx,
            &startup,
            &mut frames,
            |terminals, _| phase(terminals) == Some(SupervisedPhase::Confirm),
        );
        let body = gap_private_body(&terminals);
        let mut viewer = TestViewer::new(90);
        frames.extend(attach_viewer(&mut terminals, &startup, &mut viewer));
        let label = viewer.id.clone();
        frames.extend(send(
            &mut terminals,
            &mut viewer,
            &label,
            &TermPlaintextV2::Data(b"\r".to_vec()),
        ));
        pump_file_until(&mut terminals, &rx, &startup, &mut frames, |_, frames| {
            outcome_kinds(frames).contains(&"accepted")
        });
        reached_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("apply reached hook");
        // Parsed protocol cancel, deliberately WITHOUT if_waiting.
        let wire = serde_json::json!({"type":"supervised.cancel", "commandId":request.command_id, "reason":"deadline"});
        let ServerControlMessage::SupervisedCancel {
            command_id,
            if_waiting,
        } = parse_server_control(&wire.to_string()).unwrap()
        else {
            panic!("cancel frame");
        };
        assert!(!if_waiting);
        assert!(
            terminals
                .cancel_supervised(&command_id, if_waiting)
                .is_empty()
        );
        release_tx.send(()).unwrap();
        pump_file_until(&mut terminals, &rx, &startup, &mut frames, has_exit);
        let done = gap_done(&frames);
        assert_eq!(
            outcome_kinds(&frames)
                .iter()
                .filter(|kind| **kind == "accepted")
                .count(),
            1
        );
        if step_to_cancel == Step::TempSynced {
            assert_eq!(done["fileError"], serde_json::json!({"code":"cancelled"}));
            assert!(done.get("fileResult").is_none());
            assert_eq!(gap_disk_tree(dir.path()), before);
        } else if step_to_cancel == Step::BeforeDirSync {
            assert_eq!(done["fileError"], serde_json::json!({"code":"io_error"}));
            assert!(done.get("fileResult").is_none());
            assert_eq!(std::fs::read(&target).unwrap(), b"new");
            assert_eq!(gap_disk_tree(dir.path()).len(), 1);
        } else {
            assert!(done.get("fileError").is_none());
            assert_eq!(done["fileResult"]["op"], "write");
            assert_eq!(std::fs::read(&target).unwrap(), b"new");
            assert_eq!(gap_disk_tree(dir.path()).len(), 1);
        }
        gap_assert_body_removed(body);
        assert!(terminals.sessions.is_empty());
    }
}

#[test]
fn gap_registry_reports_stale_etag_conflict_without_changing_disk() {
    use crate::file_ops::{EtagKey, FileOps, Policy};
    for op in ["edit", "write", "delete", "rename"] {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let destination = dir.path().join("destination");
        std::fs::write(&source, b"old\n").unwrap();
        std::fs::write(&destination, b"destination\n").unwrap();
        let key = EtagKey::random();
        let (args, body) = match op {
            "edit" => (
                serde_json::json!({"path":source,"edits":[{"oldText":"old","newText":"new"}]}),
                None,
            ),
            "write" => (
                serde_json::json!({"path":source,"ifExists":"replace","expectedEtag":key.strong(&crate::file_ops::resolve::Stat::from_metadata(&std::fs::metadata(&source).unwrap()), b"old\n")}),
                Some(b"new\n".to_vec()),
            ),
            "delete" => (serde_json::json!({"path":source}), None),
            _ => (
                serde_json::json!({"from":source,"to":destination,"overwrite":true,"expectedEtag":key.strong(&crate::file_ops::resolve::Stat::from_metadata(&std::fs::metadata(&destination).unwrap()), b"destination\n")}),
                None,
            ),
        };
        let (tx, rx) = channel();
        let mut terminals = supervised_registry(tx, &fake_file_confirm(None));
        terminals.set_file_runtime(Arc::new(crate::file_relay::FileRuntime::new(FileOps::new(
            Policy::from_environment(vec![], true),
            key,
        ))));
        let startup = supervised_startup(McpCommandMode::Supervised, false);
        let request = file_spawn_request(op, args, body.as_ref().map(Vec::len));
        let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &request);
        if let Some(body) = body {
            frames.extend(
                terminals
                    .handle_supervised_body(&startup, &request.command_id, body)
                    .unwrap(),
            );
        }
        pump_file_until(
            &mut terminals,
            &rx,
            &startup,
            &mut frames,
            |terminals, _| phase(terminals) == Some(SupervisedPhase::Confirm),
        );
        let private = gap_private_body(&terminals);
        let affected = if op == "rename" {
            &destination
        } else {
            &source
        };
        std::fs::write(affected, b"old\nraced context\n").unwrap();
        let before_go = gap_disk_tree(dir.path());
        let mut viewer = TestViewer::new(91);
        frames.extend(attach_viewer(&mut terminals, &startup, &mut viewer));
        let label = viewer.id.clone();
        frames.extend(send(
            &mut terminals,
            &mut viewer,
            &label,
            &TermPlaintextV2::Data(b"\r".to_vec()),
        ));
        pump_file_until(&mut terminals, &rx, &startup, &mut frames, has_exit);
        let done = gap_done(&frames);
        assert_eq!(
            done["fileError"],
            serde_json::json!({"code":"conflict"}),
            "{op}"
        );
        assert!(done.get("fileResult").is_none());
        assert_eq!(
            gap_disk_tree(dir.path()),
            before_go,
            "{op}: disk/temp files changed"
        );
        gap_assert_body_removed(private);
    }
}

#[test]
fn gap_agent_etag_mismatch_draws_blocked_screen_before_reporting_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file");
    std::fs::write(&path, b"old\n").unwrap();
    let before = gap_disk_tree(dir.path());
    let (tx, rx) = channel();
    let mut terminals = supervised_file_registry(tx, &fake_file_confirm(Some("conflict")));
    let startup = supervised_startup(McpCommandMode::Supervised, false);
    let request = file_spawn_request(
        "edit",
        serde_json::json!({"path":path,"expectedEtag":"h:wrong","edits":[{"oldText":"old","newText":"new"}]}),
        None,
    );
    let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &request);
    pump_file_until(
        &mut terminals,
        &rx,
        &startup,
        &mut frames,
        |terminals, _| phase(terminals) == Some(SupervisedPhase::Confirm),
    );
    assert_eq!(outcome_kinds(&frames), vec!["spawned"]);
    let screen =
        crate::supervised_file::screen_from_registry_env(&terminals.file_child_env).unwrap();
    assert!(screen.contains("cannot be applied"));
    assert!(screen.contains("conflict"));
    assert!(!screen.contains("Masked unified diff:"));
    let mut viewer = TestViewer::new(92);
    frames.extend(attach_viewer(&mut terminals, &startup, &mut viewer));
    let label = viewer.id.clone();
    frames.extend(send(
        &mut terminals,
        &mut viewer,
        &label,
        &TermPlaintextV2::Data(b"q\r".to_vec()),
    ));
    pump_file_until(&mut terminals, &rx, &startup, &mut frames, has_exit);
    assert!(!outcome_kinds(&frames).contains(&"accepted"));
    assert_eq!(
        gap_done(&frames)["fileError"],
        serde_json::json!({"code":"conflict"})
    );
    assert_eq!(gap_disk_tree(dir.path()), before);
}

#[test]
fn gap_registry_child_screen_ignores_spawn_summary_and_masks_nonsecret_content() {
    let fixture = include_str!("../../tests/fixtures/masking/supervised-file.txt");
    let secret = fixture.lines().next().unwrap().split_once('=').unwrap().1;
    for op in ["edit", "write"] {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("plain.conf");
        std::fs::write(&target, fixture).unwrap();
        let before = gap_disk_tree(dir.path());
        let (tx, rx) = channel();
        let mut terminals = supervised_file_registry(tx, &fake_file_confirm(None));
        let startup = supervised_startup(McpCommandMode::Supervised, false);
        let (args, body) = if op == "edit" {
            (
                serde_json::json!({"path":target,"reason":"REAL FILE REASON","edits":[{"oldText":"visible=old","newText":"visible=new"}]}),
                None,
            )
        } else {
            let path = dir.path().join("new.conf");
            (
                serde_json::json!({"path":path,"reason":"REAL FILE REASON"}),
                Some(fixture.as_bytes().to_vec()),
            )
        };
        let mut request = file_spawn_request(op, args, body.as_ref().map(Vec::len));
        request.command = "FORGED SPAWN COMMAND".to_owned();
        request.reason = Some("FORGED SPAWN REASON".to_owned());
        let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &request);
        if let Some(body) = body {
            frames.extend(
                terminals
                    .handle_supervised_body(&startup, &request.command_id, body)
                    .unwrap(),
            );
        }
        pump_file_until(
            &mut terminals,
            &rx,
            &startup,
            &mut frames,
            |terminals, _| phase(terminals) == Some(SupervisedPhase::Confirm),
        );
        let private = gap_private_body(&terminals);
        let screen =
            crate::supervised_file::screen_from_registry_env(&terminals.file_child_env).unwrap();
        assert!(screen.contains("REAL FILE REASON"), "{op}: {screen}");
        assert!(screen.contains("Masked unified diff:"), "{op}: {screen}");
        assert!(screen.contains("⟦redacted line⟧"), "{op}: {screen}");
        assert!(
            !screen.contains("masked-adjacent=old"),
            "{op}: exposed following line"
        );
        assert!(!screen.contains(secret), "{op}: exposed fixture value");
        assert!(!screen.contains(&request.command));
        assert!(!screen.contains(request.reason.as_ref().unwrap()));
        assert!(
            terminals
                .file_child_env
                .iter()
                .all(|(name, _)| name != SUPERVISED_ENV_COMMAND && name != SUPERVISED_ENV_REASON)
        );
        frames.extend(terminals.cancel_supervised(&request.command_id, true));
        assert_eq!(gap_disk_tree(dir.path()), before);
        gap_assert_body_removed(private);
        assert!(!outcome_kinds(&frames).contains(&"accepted"));
    }
}

#[test]
fn gap_mask_token_write_body_is_rejected_before_any_screen() {
    for body in ["⟦redacted:1⟧", "prefix ⟦redacted:99⟧ suffix"] {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("new.conf");
        let (tx, rx) = channel();
        let mut terminals = supervised_file_registry(tx, &fake_file_confirm(None));
        let startup = supervised_startup(McpCommandMode::Supervised, false);
        let request = file_spawn_request(
            "write",
            serde_json::json!({"path":target}),
            Some(body.len()),
        );
        let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &request);
        frames.extend(
            terminals
                .handle_supervised_body(&startup, &request.command_id, body.as_bytes().to_vec())
                .unwrap(),
        );
        pump_file_until(&mut terminals, &rx, &startup, &mut frames, |_, frames| {
            supervised_rejection_reason(frames).is_some()
        });
        assert_eq!(supervised_rejection_reason(&frames), Some("redacted_span"));
        assert!(outcome_kinds(&frames).is_empty(), "spawned a screen");
        assert!(terminals.file_child_env.is_empty());
        assert!(terminals.sessions.is_empty());
        assert!(terminals.pending_files.is_empty());
        assert!(gap_disk_tree(dir.path()).is_empty());
    }
}

#[test]
fn gap_nested_file_display_fields_are_rejected_by_typed_spawn_parsing() {
    for field in ["diff", "preview", "etag"] {
        for op in ["edit", "edit-entry", "write", "rename", "mkdir", "delete"] {
            let dir = tempfile::tempdir().unwrap();
            let target = dir.path().join("file");
            let destination = dir.path().join("destination");
            std::fs::write(&target, b"old\n").unwrap();
            let before = gap_disk_tree(dir.path());
            let (tx, rx) = channel();
            let mut terminals = supervised_file_registry(tx, &fake_file_confirm(None));
            let startup = supervised_startup(McpCommandMode::Supervised, false);
            let (operation, mut args, body) = match op {
                "edit" | "edit-entry" => (
                    "edit",
                    serde_json::json!({"path":target,"edits":[{"oldText":"old","newText":"new"}]}),
                    None,
                ),
                "write" => (
                    "write",
                    serde_json::json!({"path":destination}),
                    Some(b"new\n".to_vec()),
                ),
                "rename" => (
                    "rename",
                    serde_json::json!({"from":target,"to":destination}),
                    None,
                ),
                "mkdir" => (
                    "mkdir",
                    serde_json::json!({"path":destination,"parents":false}),
                    None,
                ),
                _ => ("delete", serde_json::json!({"path":target}), None),
            };
            let location = if op == "edit-entry" {
                &mut args["edits"][0]
            } else {
                &mut args
            };
            location[field] = serde_json::json!("FORGED DISPLAY");
            let request = file_spawn_request(operation, args, body.as_ref().map(Vec::len));
            let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &request);
            if let Some(body) = body {
                frames.extend(
                    terminals
                        .handle_supervised_body(&startup, &request.command_id, body)
                        .unwrap(),
                );
            }
            pump_file_until(&mut terminals, &rx, &startup, &mut frames, |_, frames| {
                supervised_rejection_reason(frames).is_some()
            });
            assert_eq!(
                supervised_rejection_reason(&frames),
                Some("invalid_input"),
                "{op}.{field}"
            );
            assert!(outcome_kinds(&frames).is_empty());
            assert!(terminals.file_child_env.is_empty());
            assert_eq!(gap_disk_tree(dir.path()), before);
        }
    }
}

#[test]
fn gap_decline_and_if_waiting_cancel_leave_every_operation_untouched() {
    // A raw key reader for the stand-in: all three decline keys exit before
    // accepted. The real child has the same matrix in the PTY integration test.
    let script = r#"stty -echo -icanon -isig min 1 time 0
printf '\033]7717;wsmp-supervised;ready;%s\007' "$WSMP_SUPERVISED_MARKER"
key=$(dd bs=1 count=1 2>/dev/null | od -An -tu1)
case "$key" in *113*|*3*|*4*) exit 0;; *) exit 99;; esac
"#;
    for op in ["edit", "write", "rename", "mkdir", "delete"] {
        for decline in [Some(b'q'), Some(3), Some(4), None] {
            let dir = tempfile::tempdir().unwrap();
            let source = dir.path().join("source");
            let destination = dir.path().join("destination");
            std::fs::write(&source, b"old\n").unwrap();
            let before = gap_disk_tree(dir.path());
            let (args, body) = match op {
                "edit" => (
                    serde_json::json!({"path":source,"edits":[{"oldText":"old","newText":"new"}]}),
                    None,
                ),
                "write" => (
                    serde_json::json!({"path":destination}),
                    Some(b"new\n".to_vec()),
                ),
                "rename" => (serde_json::json!({"from":source,"to":destination}), None),
                "mkdir" => (
                    serde_json::json!({"path":destination,"parents":false}),
                    None,
                ),
                _ => (serde_json::json!({"path":source}), None),
            };
            let (tx, rx) = channel();
            let mut terminals = supervised_file_registry(tx, script);
            let startup = supervised_startup(McpCommandMode::Supervised, false);
            let request = file_spawn_request(op, args, body.as_ref().map(Vec::len));
            let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &request);
            if let Some(body) = body {
                frames.extend(
                    terminals
                        .handle_supervised_body(&startup, &request.command_id, body)
                        .unwrap(),
                );
            }
            pump_file_until(
                &mut terminals,
                &rx,
                &startup,
                &mut frames,
                |terminals, _| phase(terminals) == Some(SupervisedPhase::Confirm),
            );
            let private = gap_private_body(&terminals);
            if let Some(key) = decline {
                let mut viewer = TestViewer::new(93);
                frames.extend(attach_viewer(&mut terminals, &startup, &mut viewer));
                let label = viewer.id.clone();
                frames.extend(send(
                    &mut terminals,
                    &mut viewer,
                    &label,
                    &TermPlaintextV2::Data(vec![key]),
                ));
                pump_file_until(&mut terminals, &rx, &startup, &mut frames, has_exit);
            } else {
                frames.extend(terminals.cancel_supervised(&request.command_id, true));
            }
            assert_eq!(
                outcome_kinds(&frames),
                vec!["spawned", "declined", "exit"],
                "{op} {decline:?}"
            );
            assert_eq!(
                gap_disk_tree(dir.path()),
                before,
                "{op} {decline:?}: disk or temp files changed"
            );
            gap_assert_body_removed(private);
            assert!(terminals.sessions.is_empty());
            assert!(terminals.pending_files.is_empty());
        }
    }
}

#[test]
fn supervised_file_drop_cancels_without_a_registry_close() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = channel();
    let mut terminals = supervised_file_registry(tx, &fake_file_confirm(None));
    let startup = supervised_startup(McpCommandMode::Supervised, false);
    let request = file_spawn_request(
        "mkdir",
        serde_json::json!({"path":dir.path().join("new")}),
        None,
    );
    let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &request);
    pump_file_until(&mut terminals, &rx, &startup, &mut frames, |t, _| {
        phase(t) == Some(SupervisedPhase::Confirm)
    });
    let file = terminals
        .sessions
        .get_mut(MULTI_TERMINAL)
        .unwrap()
        .supervised
        .as_mut()
        .unwrap()
        .file
        .take()
        .unwrap();
    let cancel = file.cancel.clone();
    assert!(!cancel.is_cancelled());
    drop(file);
    assert!(cancel.is_cancelled());
    assert!(!dir.path().join("new").exists());
}

#[test]
fn supervised_committed_result_encoding_failure_is_io_error() {
    use crate::file_ops::{EtagKey, FileOps, Policy};
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("new");
    let (tx, rx) = channel();
    let mut terminals = supervised_registry(tx, &fake_file_confirm(None));
    terminals.set_file_runtime(Arc::new(crate::file_relay::FileRuntime::new(FileOps::new(
        Policy::from_environment(vec![], true),
        EtagKey::random(),
    ))));
    let startup = supervised_startup(McpCommandMode::Supervised, false);
    let request = file_spawn_request("mkdir", serde_json::json!({"path":target}), None);
    let mut frames = terminals.spawn_supervised(&startup, &Config::default(), &request);
    pump_file_until(&mut terminals, &rx, &startup, &mut frames, |t, _| {
        phase(t) == Some(SupervisedPhase::Confirm)
    });
    let supervised = terminals
        .sessions
        .get_mut(MULTI_TERMINAL)
        .unwrap()
        .supervised
        .as_mut()
        .unwrap();
    supervised.phase = SupervisedPhase::Running;
    let file = supervised.file.as_mut().unwrap();
    file.applied = true;
    let generation = file.generation;
    // Represent a committed worker whose result no longer fits a control frame.
    std::fs::create_dir(&target).unwrap();
    let frames = terminals.on_file_applied(&request.command_id, generation,
        Ok(serde_json::json!({"created":true,"resolvedPath":"x".repeat(crate::protocol::RELAY_JSON_CONTROL_MAX_BYTES)})));
    let done = gap_done(&frames);
    assert_eq!(done["fileError"], serde_json::json!({"code":"io_error"}));
    assert!(done.get("fileResult").is_none());
    for message in controls(&frames) {
        crate::protocol::encode_control(message).unwrap();
    }
    assert!(target.is_dir());
    assert!(terminals.sessions.is_empty());
}
