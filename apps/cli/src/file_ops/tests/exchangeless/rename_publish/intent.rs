//! The rename INTENT: kept when a capture fails, kept with the commit after a
//! link-first publish, and versioned on the exchange-first path.

use super::*;

#[test]
fn rename_intent_remains_when_destination_capture_fails_before_publish() {
    let fx = Fx::new();
    let etag = setup(&fx, Object::File, true);
    let mut faults = Shape::Link.faults(true);
    faults.retain(|(primitive, _, _)| *primitive != Primitive::Capture);
    let _scope = FaultScope::with_after_effects(&faults, &[(Primitive::Capture, 1, Errno::EIO)]);
    let error = rename_run(&fx, true, etag.as_deref()).unwrap_err();
    assert_eq!(error.code, ErrorCode::UncertainOutcome);
    assert_eq!(count(&FaultScope::calls(), Primitive::PublishLink), 0);
    assert_eq!(fx.get("src"), SOURCE);
    let dir = recovery_dirs(&fx.root)
        .into_iter()
        .next()
        .expect("recovery");
    let intent: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("INTENT")).unwrap()).unwrap();
    assert_eq!(intent["order"], "link-first");
    assert_eq!(intent["version"], 3);
    assert_eq!(intent["phase"], "capturing");
    assert_eq!(intent["op"], "rename");
    assert_eq!(intent["source"]["display"], fx.p("src"));
    assert_eq!(intent["destination"]["display"], fx.p("dst"));
    assert_eq!(intent["slots"]["slot-1"]["origin"]["display"], fx.p("dst"));
    assert_eq!(intent["slots"]["slot-2"]["origin"]["display"], fx.p("src"));
    assert!(intent["slots"]["slot-1"]["dev"].is_number());
    assert!(intent["slots"]["slot-1"]["ino"].is_number());
    assert!(intent["pid"].is_number());
    assert!(intent["host"].is_string());
    assert!(intent["createdAt"].is_string());
    assert!(intent["cliVersion"].is_string());
    assert_eq!(
        std::fs::read_to_string(dir.join("slot-1")).unwrap(),
        DESTINATION
    );
    assert!(!dir.join("slot-2").exists());
    assert!(dir.join("INTENT").is_file());
    let mut departed = intent;
    departed["pid"] = json!(0);
    std::fs::write(dir.join("INTENT"), serde_json::to_vec(&departed).unwrap()).unwrap();
    // Recovery runs in a later process: no injected faults remain.
    drop(_scope);
    // An interrupted `capturing` rename rolls back through the pinned restore.
    assert!(matches!(
        crate::file_ops::journal::recover::recover_dir(&dir, true, None).action,
        crate::file_ops::journal::recover::RecoverAction::Cleaned
            | crate::file_ops::journal::recover::RecoverAction::RolledBack
    ));
    assert_eq!(fx.get("dst"), DESTINATION);
    assert_eq!(fx.get("src"), SOURCE);
    assert!(!dir.exists());
}

#[test]
fn rename_link_first_source_capture_failure_after_publish_keeps_commit() {
    for overwrite in [false, true] {
        let fx = Fx::new();
        let etag = setup(&fx, Object::File, overwrite);
        let mut faults = Shape::Link.faults(overwrite);
        let capture_nth = if overwrite { 2 } else { 1 };
        faults.retain(|(primitive, nth, _)| {
            !(*primitive == Primitive::Capture && *nth == capture_nth)
        });
        faults.push((Primitive::Capture, capture_nth, Errno::EIO));
        let _scope = FaultScope::new(&faults);
        let error = rename_run(&fx, overwrite, etag.as_deref()).unwrap_err();
        assert_eq!(
            error.code,
            ErrorCode::UncertainOutcome,
            "{overwrite} {error:?}"
        );
        assert_eq!(fx.get("dst"), SOURCE);
        assert_eq!(fx.get("src"), SOURCE);
        let dir = recovery_dirs(&fx.root)
            .into_iter()
            .next()
            .expect("recovery");
        let intent: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("INTENT")).unwrap()).unwrap();
        assert_eq!(
            intent["phase"], "committed",
            "a post-commit capture never demotes the durable commit"
        );
        assert_eq!(intent["order"], "link-first");
        assert!(fx.steps.lock().unwrap().contains(&Step::Linked));
        if overwrite {
            assert_eq!(
                std::fs::read_to_string(dir.join("slot-1")).unwrap(),
                DESTINATION
            );
        }
        let mut departed = intent;
        departed["pid"] = json!(0);
        std::fs::write(dir.join("INTENT"), serde_json::to_vec(&departed).unwrap()).unwrap();
        // Committed only rolls forward: the overwritten destination is disposed
        // and nothing is ever restored over the published source.
        assert!(matches!(
            crate::file_ops::journal::recover::recover_dir(&dir, true, None).action,
            crate::file_ops::journal::recover::RecoverAction::RolledForward
                | crate::file_ops::journal::recover::RecoverAction::Cleaned
        ));
        assert!(!dir.exists());
        assert_eq!(fx.get("dst"), SOURCE);
        assert_eq!(fx.get("src"), SOURCE);
    }
}

#[test]
fn rename_exchange_first_writes_versioned_intent() {
    let fx = Fx::new();
    let etag = setup(&fx, Object::File, true);
    let root = fx.root.clone();
    let seen = Arc::new(Mutex::new(None));
    let record = Arc::clone(&seen);
    let fx = fx.with_hook(move |step| {
        if step == Step::Exchanged {
            let dir = recovery_dirs(&root).into_iter().next().expect("recovery");
            let intent: Value =
                serde_json::from_str(&std::fs::read_to_string(dir.join("INTENT")).unwrap())
                    .unwrap();
            *record.lock().unwrap() = Some(intent);
        }
        Ok(())
    });
    let value = rename_run(&fx, true, etag.as_deref()).unwrap();
    assert!(value.get("recovered").is_none(), "{value}");
    let intent = seen.lock().unwrap().clone().expect("INTENT at exchange");
    assert_eq!(intent["version"], 3);
    assert_eq!(intent["op"], "rename");
    assert_eq!(intent["order"], "exchange-first");
    assert_eq!(
        intent["phase"], "publishing",
        "exchange is fenced until post-effect validation and barriers"
    );
    assert_eq!(intent["source"]["display"], fx.p("src"));
    assert_eq!(intent["destination"]["display"], fx.p("dst"));
    assert_eq!(intent["slots"]["slot-1"]["origin"]["display"], fx.p("dst"));
    assert!(intent["slots"].get("slot-2").is_none());
    clean(&fx);
}
