//! Protocol 2.5: several viewers on one terminal.

use super::*;

#[test]
fn opener_gets_the_key_and_size_and_is_the_first_writer() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(false);
    let mut a = TestViewer::new(1);
    let frames = open_viewer(&mut terminals, &startup, &mut a);
    assert!(matches!(
        controls(&frames)[0],
        NodeFrame::TermOpened { viewer_id: Some(id), .. } if id == &a.id
    ));
    assert_eq!(
        a.receive(MULTI_TERMINAL, &frames),
        vec![Seen::Key(1), Seen::Size(80, 24)]
    );
    assert_eq!(writer_changes(&frames), vec![Some(a.id.clone())]);
    assert_eq!(writer(&terminals), Some(a.id.clone()));
}

#[test]
fn retired_review_and_unknown_tags_drop_only_the_sender() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(false);
    let mut a = TestViewer::new(1);
    open_viewer(&mut terminals, &startup, &mut a);
    // A 0.3 review toggle, capture and state, then a tag never assigned.
    let retired_capture = [0x05, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
    for (tag, plaintext) in [
        (11, &[0x04, 1][..]),
        (12, &retired_capture[..]),
        (13, &[0x06, 0][..]),
        (14, &[0x07, 1][..]),
    ] {
        let mut sender = TestViewer::new(tag);
        attach_viewer(&mut terminals, &startup, &mut sender);
        let (seq, body) = sender.seal_bytes(MULTI_TERMINAL, plaintext);
        let sender_id = sender.id.clone();
        let frames = terminals.handle_sealed(MULTI_TERMINAL, Some(&sender_id), seq, &body);
        assert_eq!(
            rejection(&frames),
            Some((Some(sender_id), REASON_BAD_FRAME.to_string())),
            "{plaintext:?}"
        );
        let session = terminals.sessions.get(MULTI_TERMINAL).expect("session");
        assert_eq!(
            session.viewers.keys().cloned().collect::<Vec<_>>(),
            vec![a.id.clone()],
            "{plaintext:?}"
        );
    }
}

#[test]
fn two_viewers_decrypt_the_same_broadcast() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(false);
    let mut a = TestViewer::new(1);
    let mut b = TestViewer::new(2);
    let opened = open_viewer(&mut terminals, &startup, &mut a);
    a.receive(MULTI_TERMINAL, &opened);
    // Output before B joins is scrollback for B.
    let early = terminals.on_bytes(MULTI_TERMINAL, b"early");
    assert_eq!(
        a.receive(MULTI_TERMINAL, &early),
        vec![Seen::Data(b"early".to_vec())]
    );

    let attached = attach_viewer(&mut terminals, &startup, &mut b);
    assert!(matches!(
        controls(&attached)[0],
        NodeFrame::TermAttached { viewer_id: Some(id), .. } if id == &b.id
    ));
    // Join order: key, PTY size, scrollback. The epoch does not change,
    // and nothing in the join is visible to A.
    assert_eq!(
        b.receive(MULTI_TERMINAL, &attached),
        vec![
            Seen::Key(1),
            Seen::Size(80, 24),
            Seen::Data(b"early".to_vec())
        ]
    );
    assert!(a.receive(MULTI_TERMINAL, &attached).is_empty());
    assert!(writer_changes(&attached).is_empty());

    let live = terminals.on_bytes(MULTI_TERMINAL, b"hello");
    assert_eq!(live.len(), 1, "live output is sealed once");
    assert_eq!(
        a.receive(MULTI_TERMINAL, &live),
        vec![Seen::Data(b"hello".to_vec())]
    );
    assert_eq!(
        b.receive(MULTI_TERMINAL, &live),
        vec![Seen::Data(b"hello".to_vec())]
    );
}

#[test]
fn input_from_b_makes_b_the_writer_and_applies_b_size_first() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(false);
    let mut a = TestViewer::new(1);
    let mut b = TestViewer::new(2);
    let opened = open_viewer(&mut terminals, &startup, &mut a);
    a.receive(MULTI_TERMINAL, &opened);
    let attached = attach_viewer(&mut terminals, &startup, &mut b);
    b.receive(MULTI_TERMINAL, &attached);
    assert_eq!(pty_size(&terminals), (80, 24));

    // A resize from a non-writer is only recorded.
    let b_id = b.id.clone();
    let frames = send(
        &mut terminals,
        &mut b,
        &b_id,
        &TermPlaintextV2::Resize {
            cols: 100,
            rows: 40,
        },
    );
    assert!(frames.is_empty());
    assert_eq!(pty_size(&terminals), (80, 24));
    assert_eq!(writer(&terminals), Some(a.id.clone()));

    // B types: B becomes the writer, then B's size is applied and
    // broadcast, before the write.
    let frames = send(
        &mut terminals,
        &mut b,
        &b_id,
        &TermPlaintextV2::Data(b"x".to_vec()),
    );
    assert_eq!(writer_changes(&frames), vec![Some(b.id.clone())]);
    assert!(matches!(
        &frames[0],
        OutboundFrame::Control(NodeFrame::TermWriter { .. })
    ));
    assert_eq!(
        a.receive(MULTI_TERMINAL, &frames),
        vec![Seen::Size(100, 40)]
    );
    assert_eq!(
        b.receive(MULTI_TERMINAL, &frames),
        vec![Seen::Size(100, 40)]
    );
    assert_eq!(pty_size(&terminals), (100, 40));
    assert_eq!(writer(&terminals), Some(b.id.clone()));

    // The writer's own resize applies at once.
    let frames = send(
        &mut terminals,
        &mut b,
        &b_id,
        &TermPlaintextV2::Resize {
            cols: 120,
            rows: 50,
        },
    );
    assert_eq!(
        a.receive(MULTI_TERMINAL, &frames),
        vec![Seen::Size(120, 50)]
    );
    assert_eq!(pty_size(&terminals), (120, 50));

    // A types again: A's opening size comes back.
    let a_id = a.id.clone();
    let frames = send(
        &mut terminals,
        &mut a,
        &a_id,
        &TermPlaintextV2::Data(b"y".to_vec()),
    );
    assert_eq!(writer_changes(&frames), vec![Some(a.id.clone())]);
    assert_eq!(b.receive(MULTI_TERMINAL, &frames), vec![Seen::Size(80, 24)]);
    assert_eq!(pty_size(&terminals), (80, 24));

    // Typing again as the writer changes nothing.
    let frames = send(
        &mut terminals,
        &mut a,
        &a_id,
        &TermPlaintextV2::Data(b"z".to_vec()),
    );
    assert!(frames.is_empty());
}

#[test]
fn a_frame_from_a_labelled_b_is_ignored() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(false);
    let mut a = TestViewer::new(1);
    let mut b = TestViewer::new(2);
    open_viewer(&mut terminals, &startup, &mut a);
    attach_viewer(&mut terminals, &startup, &mut b);
    let b_id = b.id.clone();

    // A's frame, stamped with B's viewer id by a hostile relay.
    let frames = send(
        &mut terminals,
        &mut a,
        &b_id,
        &TermPlaintextV2::Data(b"forged".to_vec()),
    );
    assert!(frames.is_empty());
    assert_eq!(writer(&terminals), Some(a.id.clone()));
    // Unknown viewer ids are ignored too.
    let frames = send(
        &mut terminals,
        &mut a,
        "no-such-viewer",
        &TermPlaintextV2::Data(b"x".to_vec()),
    );
    assert!(frames.is_empty());
    assert!(terminals.sessions.contains_key(MULTI_TERMINAL));
    // 2.5 frames without a viewer id are dropped.
    let (seq, body) = a.seal(MULTI_TERMINAL, &TermPlaintextV2::Data(b"x".to_vec()));
    assert!(
        terminals
            .handle_sealed(MULTI_TERMINAL, None, seq, &body)
            .is_empty()
    );
    assert_eq!(writer(&terminals), Some(a.id.clone()));

    // B's replay cursor did not move: B's own first frame still counts.
    let frames = send(
        &mut terminals,
        &mut b,
        &b_id,
        &TermPlaintextV2::Data(b"real".to_vec()),
    );
    assert_eq!(writer_changes(&frames), vec![Some(b.id.clone())]);
    assert_eq!(writer(&terminals), Some(b.id.clone()));
}

#[test]
fn a_leave_rotates_the_epoch_and_the_leaver_cannot_open_new_frames() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(false);
    let mut a = TestViewer::new(1);
    let mut b = TestViewer::new(2);
    let mut c = TestViewer::new(3);
    let opened = open_viewer(&mut terminals, &startup, &mut a);
    a.receive(MULTI_TERMINAL, &opened);
    let attached = attach_viewer(&mut terminals, &startup, &mut b);
    b.receive(MULTI_TERMINAL, &attached);
    let attached = attach_viewer(&mut terminals, &startup, &mut c);
    c.receive(MULTI_TERMINAL, &attached);
    let (_, b_old_key) = b.out.expect("b key");

    // B takes the writer, then stops viewing.
    let b_id = b.id.clone();
    send(
        &mut terminals,
        &mut b,
        &b_id,
        &TermPlaintextV2::Data(b"b".to_vec()),
    );
    let frames = terminals.detach(MULTI_TERMINAL, Some(&b_id));
    assert_eq!(writer_changes(&frames), vec![None]);
    assert_eq!(writer(&terminals), None);
    assert!(rejection(&frames).is_none(), "a detach is not a rejection");
    assert_eq!(a.receive(MULTI_TERMINAL, &frames), vec![Seen::Key(2)]);
    assert_eq!(c.receive(MULTI_TERMINAL, &frames), vec![Seen::Key(2)]);
    assert!(b.receive(MULTI_TERMINAL, &frames).is_empty());
    assert_ne!(a.out.expect("a key").1, b_old_key);
    assert_eq!(a.out, c.out);

    let live = terminals.on_bytes(MULTI_TERMINAL, b"after");
    assert_eq!(
        a.receive(MULTI_TERMINAL, &live),
        vec![Seen::Data(b"after".to_vec())]
    );
    assert_eq!(
        c.receive(MULTI_TERMINAL, &live),
        vec![Seen::Data(b"after".to_vec())]
    );
    let OutboundFrame::Binary(
        NodeBinaryMetadata::TermSealed {
            seq,
            epoch: Some(epoch),
            ..
        },
        body,
    ) = &live[0]
    else {
        panic!("expected a broadcast frame");
    };
    assert_eq!((*epoch, *seq), (2, 1), "a new epoch restarts seq at 1");
    for try_epoch in [1, 2] {
        assert!(
            terminal_crypto::open_broadcast(&b_old_key, MULTI_TERMINAL, try_epoch, *seq, body)
                .is_err()
        );
    }
    assert_eq!(b.receive(MULTI_TERMINAL, &live), vec![Seen::Opaque]);
    // The leaver's input is no longer accepted.
    let frames = send(
        &mut terminals,
        &mut b,
        &b_id,
        &TermPlaintextV2::Data(b"late".to_vec()),
    );
    assert!(frames.is_empty());
    // With no writer, any viewer's resize applies.
    let c_id = c.id.clone();
    let frames = send(
        &mut terminals,
        &mut c,
        &c_id,
        &TermPlaintextV2::Resize { cols: 70, rows: 20 },
    );
    assert_eq!(a.receive(MULTI_TERMINAL, &frames), vec![Seen::Size(70, 20)]);
    assert_eq!(pty_size(&terminals), (70, 20));
    assert_eq!(writer(&terminals), None, "a resize never claims the writer");

    // A per-viewer fault removes only C, and rotates again.
    let frames = send(
        &mut terminals,
        &mut c,
        &c_id,
        &TermPlaintextV2::OutputKey {
            epoch: 9,
            key: [0_u8; 32],
        },
    );
    assert_eq!(
        rejection(&frames),
        Some((Some(c.id.clone()), REASON_BAD_FRAME.to_string()))
    );
    assert_eq!(a.receive(MULTI_TERMINAL, &frames), vec![Seen::Key(3)]);
    assert!(terminals.sessions.contains_key(MULTI_TERMINAL));
    let session = terminals.sessions.get(MULTI_TERMINAL).expect("session");
    assert_eq!(
        session.viewers.keys().cloned().collect::<Vec<_>>(),
        vec![a.id.clone()]
    );

    // A malformed relay frame naming A removes A as well.
    let a_id = a.id.clone();
    let frames = terminals.drop_viewer(MULTI_TERMINAL, &a_id);
    assert_eq!(
        rejection(&frames),
        Some((Some(a.id.clone()), REASON_BAD_FRAME.to_string()))
    );
    let session = terminals.sessions.get(MULTI_TERMINAL).expect("session");
    assert!(session.viewers.is_empty());
    assert!(matches!(session.attachment, Attachment::Detached { .. }));
    // With no viewers, output is only recorded.
    assert!(terminals.on_bytes(MULTI_TERMINAL, b"quiet").is_empty());
}

#[test]
fn viewer_cap_duplicates_and_idle_close() {
    const IDLE_LIMIT: Duration = Duration::from_secs(60);
    let (tx, _rx) = channel();
    let mut terminals = sleeping_registry(tx, IDLE_LIMIT, 30);
    let startup = enabled_startup(false);
    let mut viewers = (1..=MAX_VIEWERS as u8)
        .map(TestViewer::new)
        .collect::<Vec<_>>();
    open_viewer(&mut terminals, &startup, &mut viewers[0]);
    for viewer in viewers.iter_mut().skip(1) {
        attach_viewer(&mut terminals, &startup, viewer);
    }
    let extra = TestViewer::new(50);
    let frames = terminals.attach(&startup, None, extra.handshake(MULTI_TERMINAL, 0, 0));
    assert_eq!(
        rejection(&frames),
        Some((Some(extra.id.clone()), REASON_VIEWER_LIMIT.to_string()))
    );
    let duplicate = terminals.attach(&startup, None, viewers[1].handshake(MULTI_TERMINAL, 0, 0));
    assert_eq!(
        rejection(&duplicate),
        Some((
            Some(viewers[1].id.clone()),
            REASON_BAD_HANDSHAKE.to_string()
        ))
    );
    let missing = terminals.attach(
        &startup,
        None,
        TermHandshake {
            viewer_id: None,
            ..extra.handshake(MULTI_TERMINAL, 0, 0)
        },
    );
    assert_eq!(
        rejection(&missing),
        Some((None, REASON_BAD_HANDSHAKE.to_string()))
    );

    // One viewer left keeps the terminal alive past the idle limit.
    for viewer in viewers.iter().skip(1) {
        terminals.detach(MULTI_TERMINAL, Some(&viewer.id));
    }
    let past_idle = || Instant::now() + IDLE_LIMIT * 2;
    assert!(terminals.poll(past_idle()).is_empty());
    terminals.detach(MULTI_TERMINAL, Some(&viewers[0].id));
    // The poll clock is passed in, so no real waiting is needed.
    let frames = terminals.poll(past_idle());
    assert!(matches!(
        controls(&frames)[0],
        NodeFrame::TermExit { terminal_id, .. } if terminal_id == MULTI_TERMINAL
    ));
}

#[test]
fn a_reattached_terminal_is_not_idle() {
    const IDLE_LIMIT: Duration = Duration::from_secs(60);
    let (tx, _rx) = channel();
    let mut terminals = sleeping_registry(tx, IDLE_LIMIT, 30);
    let startup = enabled_startup(false);
    let mut a = TestViewer::new(1);
    let mut b = TestViewer::new(2);
    open_viewer(&mut terminals, &startup, &mut a);
    terminals.detach(MULTI_TERMINAL, Some(&a.id));
    assert!(matches!(
        terminals.sessions[MULTI_TERMINAL].attachment,
        Attachment::Detached { .. }
    ));
    attach_viewer(&mut terminals, &startup, &mut b);
    assert_eq!(
        terminals.sessions[MULTI_TERMINAL].attachment,
        Attachment::Attached
    );
    assert!(terminals.poll(Instant::now() + IDLE_LIMIT * 2).is_empty());
    assert!(terminals.sessions.contains_key(MULTI_TERMINAL));
}

#[test]
fn no_terminal_opens_after_kill_all() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(false);
    assert!(terminals.kill_all().is_empty());
    let viewer = TestViewer::new(1);
    let frames = terminals.open(&startup, None, viewer.handshake(MULTI_TERMINAL, 80, 24));
    assert_eq!(
        rejection(&frames),
        Some((Some(viewer.id.clone()), REASON_SPAWN_FAILED.to_string()))
    );
    assert!(terminals.sessions.is_empty(), "nothing spawned");
    assert!(
        terminals.kill_all().is_empty(),
        "a second shutdown does nothing"
    );
}

#[test]
fn two_pending_approvals_both_complete() {
    use p256::elliptic_curve::Generate;
    let dir = tempfile::tempdir().expect("tempdir");
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(true);
    let identity = p256::ecdsa::SigningKey::try_generate().expect("identity");
    let identity_raw = {
        let encoded = identity.verifying_key().to_sec1_point(false);
        let mut raw = [0_u8; 65];
        raw.copy_from_slice(encoded.as_bytes());
        raw
    };
    let identity_message = TerminalIdentity {
        public_key: terminal_crypto::encode_b64url(&identity_raw),
        signature: None,
    };
    crate::node::approvals::record_pending(dir.path(), &identity_raw).expect("pending");
    crate::node::approvals::approve(dir.path(), &terminal_crypto::approval_code(&identity_raw))
        .expect("approve");
    let sign = |viewer: &TestViewer, cli_nonce: &str| {
        let signature = terminal_crypto::sign_approval_v2(
            &identity,
            MULTI_TERMINAL,
            &viewer.id,
            viewer.browser.public_raw(),
            &viewer.nonce,
            startup.terminal_public_key(),
            &terminal_crypto::decode_nonce(cli_nonce).expect("nonce"),
        )
        .expect("sign");
        terminal_crypto::encode_b64url(&signature)
    };

    let mut a = TestViewer::new(1);
    let pending = terminals.open(
        &startup,
        Some(dir.path()),
        TermHandshake {
            identity: Some(&identity_message),
            shell: None,
            ..a.handshake(MULTI_TERMINAL, 80, 24)
        },
    );
    assert!(matches!(
        controls(&pending)[0],
        NodeFrame::TermPending { viewer_id: Some(id), .. } if id == &a.id
    ));
    let a_nonce = cli_nonce_of(&pending);
    let a_id = a.id.clone();
    let opened = terminals.auth(
        &startup,
        Some(dir.path()),
        MULTI_TERMINAL,
        Some(&a_id),
        &sign(&a, &a_nonce),
    );
    assert!(matches!(
        controls(&opened)[0],
        NodeFrame::TermOpened { viewer_id: Some(id), .. } if id == &a.id
    ));
    a.bind(&startup, MULTI_TERMINAL, &a_nonce);
    assert_eq!(
        a.receive(MULTI_TERMINAL, &opened),
        vec![Seen::Key(1), Seen::Size(80, 24)]
    );

    let mut b = TestViewer::new(2);
    let mut c = TestViewer::new(3);
    let mut nonces = Vec::new();
    for viewer in [&b, &c] {
        let pending = terminals.attach(
            &startup,
            Some(dir.path()),
            TermHandshake {
                identity: Some(&identity_message),
                shell: None,
                ..viewer.handshake(MULTI_TERMINAL, 0, 0)
            },
        );
        assert!(matches!(
            controls(&pending)[0],
            NodeFrame::TermPending { viewer_id: Some(id), .. } if id == &viewer.id
        ));
        nonces.push(cli_nonce_of(&pending));
    }
    assert_eq!(terminals.pending.len(), 2);
    // B's signature does not verify for C: the transcript binds the viewer.
    let c_id = c.id.clone();
    let wrong = terminals.auth(
        &startup,
        Some(dir.path()),
        MULTI_TERMINAL,
        Some(&c_id),
        &sign(&b, &nonces[0]),
    );
    assert_eq!(
        rejection(&wrong),
        Some((Some(c.id.clone()), REASON_BAD_SIGNATURE.to_string()))
    );
    // Re-queue C, then complete C before B.
    let pending = terminals.attach(
        &startup,
        Some(dir.path()),
        TermHandshake {
            identity: Some(&identity_message),
            shell: None,
            ..c.handshake(MULTI_TERMINAL, 0, 0)
        },
    );
    nonces[1] = cli_nonce_of(&pending);
    let attached_c = terminals.auth(
        &startup,
        Some(dir.path()),
        MULTI_TERMINAL,
        Some(&c_id),
        &sign(&c, &nonces[1]),
    );
    let b_id = b.id.clone();
    let attached_b = terminals.auth(
        &startup,
        Some(dir.path()),
        MULTI_TERMINAL,
        Some(&b_id),
        &sign(&b, &nonces[0]),
    );
    for (viewer, frames, nonce) in [
        (&mut c, &attached_c, &nonces[1]),
        (&mut b, &attached_b, &nonces[0]),
    ] {
        assert!(matches!(
            controls(frames)[0],
            NodeFrame::TermAttached { viewer_id: Some(id), .. } if id == &viewer.id
        ));
        viewer.bind(&startup, MULTI_TERMINAL, nonce);
        assert_eq!(
            viewer.receive(MULTI_TERMINAL, frames),
            vec![Seen::Key(1), Seen::Size(80, 24)]
        );
    }
    assert!(terminals.pending.is_empty());
    let live = terminals.on_bytes(MULTI_TERMINAL, b"all");
    for viewer in [&mut a, &mut b, &mut c] {
        assert_eq!(
            viewer.receive(MULTI_TERMINAL, &live),
            vec![Seen::Data(b"all".to_vec())]
        );
    }

    // Revoking the identity removes every viewer it approved.
    crate::node::approvals::revoke(dir.path(), &terminal_crypto::approval_code(&identity_raw))
        .expect("revoke");
    let frames = terminals.poll(Instant::now());
    let rejected = controls(&frames)
        .into_iter()
        .filter(|message| {
            matches!(
                message,
                NodeFrame::TermRejected { reason, .. }
                    if reason == REASON_APPROVAL_REQUIRED
            )
        })
        .count();
    assert_eq!(rejected, 3);
    assert!(
        terminals
            .sessions
            .get(MULTI_TERMINAL)
            .expect("session")
            .viewers
            .is_empty()
    );
}
