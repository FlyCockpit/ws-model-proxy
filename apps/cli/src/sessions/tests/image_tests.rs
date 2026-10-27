//! Exercise encrypted image delivery at the terminal admission/lifecycle boundary.

use super::*;
use crate::terminal_images::{ImageChunk, ImageReply};

fn image(total: u32) -> TermPlaintextV2 {
    TermPlaintextV2::ImageChunk(ImageChunk {
        id: [1; 16],
        total,
        offset: 0,
        format: 0,
        data: b"\x89PNG\r\n\x1a\n".to_vec(),
    })
}

fn reply(viewer: &TestViewer, frames: &[OutboundFrame]) -> Option<ImageReply> {
    viewer
        .unicast_messages(MULTI_TERMINAL, frames)
        .into_iter()
        .find_map(|message| match message {
            TermPlaintextV2::ImageReply(reply) => Some(reply),
            _ => None,
        })
}

#[test]
fn human_shell_advertises_images_and_returns_the_saved_path_only_to_the_uploader() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(false);
    let mut a = TestViewer::new(1);
    let opened = open_viewer(&mut terminals, &startup, &mut a);
    assert!(
        a.unicast_messages(MULTI_TERMINAL, &opened)
            .contains(&TermPlaintextV2::ImageCapabilities)
    );
    let mut b = TestViewer::new(2);
    attach_viewer(&mut terminals, &startup, &mut b);
    let label = b.id.clone();
    assert!(send(&mut terminals, &mut b, &label, &image(8)).is_empty());
    let deadline = Instant::now() + Duration::from_secs(5);
    let frames = loop {
        let frames = terminals.poll_image_replies(Instant::now());
        if !frames.is_empty() {
            break frames;
        }
        assert!(Instant::now() < deadline, "image worker did not reply");
        std::thread::sleep(Duration::from_millis(5));
    };
    let saved = reply(&b, &frames).expect("reply");
    assert!(saved.error.is_none());
    assert_eq!(
        std::fs::read(saved.path.expect("path")).expect("image"),
        b"\x89PNG\r\n\x1a\n"
    );
    assert!(a.unicast_messages(MULTI_TERMINAL, &frames).is_empty());
    assert_eq!(
        writer(&terminals),
        Some(a.id.clone()),
        "upload does not claim the writer"
    );
    let path = terminals
        .image_pending
        .get(&(MULTI_TERMINAL.to_string(), label.clone()))
        .expect("offered upload");
    assert!(path.matches(&[1; 16]));
    let offered = reply(&b, &frames).expect("offered reply");
    // Windows quotes the path for the terminal's shell itself; the browser quotes POSIX paths.
    let text = offered.paste.clone().unwrap_or_else(|| {
        crate::terminal_images::paste_text(offered.path.as_deref().expect("path"))
    });
    assert_eq!(offered.paste.is_some(), cfg!(windows));
    let offered = offered.path.expect("path");
    let paste = TermPlaintextV2::ImagePaste(crate::terminal_images::ImagePaste {
        id: [1; 16],
        data: text.into_bytes(),
    });
    let pasted = send(&mut terminals, &mut b, &label, &paste);
    assert_eq!(writer_changes(&pasted), vec![Some(label)]);
    assert!(terminals.image_pending.is_empty());
    assert!(std::path::Path::new(&offered).exists());
}

#[test]
fn image_paste_to_a_removed_terminal_emits_no_drop_notice() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(false);
    let mut viewer = TestViewer::new(1);
    open_viewer(&mut terminals, &startup, &mut viewer);
    let paste = TermPlaintextV2::ImagePaste(crate::terminal_images::ImagePaste {
        id: [1; 16],
        data: b"/tmp/expired.png ".to_vec(),
    });
    let bytes = terminal_crypto::encode_plaintext_v2(&paste).expect("paste");
    let (seq, body) = viewer.seal_bytes(MULTI_TERMINAL, &bytes);
    terminals.close(MULTI_TERMINAL);
    assert!(
        terminals
            .handle_sealed(MULTI_TERMINAL, Some(&viewer.id), seq, &body)
            .is_empty()
    );
}

#[test]
fn late_or_unoffered_image_paste_never_queues_a_dangling_path() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(false);
    let mut viewer = TestViewer::new(1);
    open_viewer(&mut terminals, &startup, &mut viewer);
    let label = viewer.id.clone();
    // A rejected offer must be reported even during an overflow notification
    // run, and must neither start nor reset that run.
    for already_notified in [false, true] {
        terminals
            .sessions
            .get_mut(MULTI_TERMINAL)
            .expect("session")
            .viewers
            .get_mut(&label)
            .expect("viewer")
            .input_drop_notified = already_notified;
        let frames = send(
            &mut terminals,
            &mut viewer,
            &label,
            &TermPlaintextV2::ImagePaste(crate::terminal_images::ImagePaste {
                id: [1; 16],
                data: b"/tmp/expired.png ".to_vec(),
            }),
        );
        assert!(controls(&frames).iter().any(|frame| matches!(
            frame,
            NodeFrame::TermInputDropped { terminal_id, viewer_id }
                if terminal_id == MULTI_TERMINAL && viewer_id.as_deref() == Some(label.as_str())
        )));
        assert_eq!(
            terminals.sessions[MULTI_TERMINAL].viewers[&label].input_drop_notified,
            already_notified
        );
        assert!(writer_changes(&frames).is_empty());
    }
}

#[test]
fn browser_cancellation_only_retires_the_matching_unclaimed_upload() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(false);
    let mut viewer = TestViewer::new(1);
    open_viewer(&mut terminals, &startup, &mut viewer);
    let label = viewer.id.clone();
    send(&mut terminals, &mut viewer, &label, &image(12));
    send(
        &mut terminals,
        &mut viewer,
        &label,
        &TermPlaintextV2::ImageCancel([2; 16]),
    );
    assert_eq!(terminals.image_pending.len(), 1);
    send(
        &mut terminals,
        &mut viewer,
        &label,
        &TermPlaintextV2::ImageCancel([1; 16]),
    );
    assert!(terminals.image_pending.is_empty());
}

#[test]
fn image_after_shell_exit_is_rejected_without_starting_file_work() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(false);
    let mut viewer = TestViewer::new(1);
    open_viewer(&mut terminals, &startup, &mut viewer);
    terminals
        .sessions
        .get_mut(MULTI_TERMINAL)
        .expect("session")
        .pty
        .as_mut()
        .expect("pty")
        .exited = Some((Some(0), None, Instant::now()));
    let label = viewer.id.clone();
    let frames = send(&mut terminals, &mut viewer, &label, &image(8));
    assert_eq!(
        reply(&viewer, &frames).expect("refusal").error.as_deref(),
        Some("unavailable")
    );
    assert!(terminals.image_pending.is_empty());
}

#[test]
fn detaching_a_viewer_cancels_its_pending_worker_reply() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(false);
    let mut viewer = TestViewer::new(1);
    open_viewer(&mut terminals, &startup, &mut viewer);
    let label = viewer.id.clone();
    let alive = Arc::clone(&terminals.sessions[MULTI_TERMINAL].viewers[&label].image_alive);
    send(&mut terminals, &mut viewer, &label, &image(12));
    assert_eq!(terminals.image_pending.len(), 1);
    terminals.detach(MULTI_TERMINAL, Some(&label));
    assert!(!alive.load(Ordering::Acquire));
    assert!(terminals.image_pending.is_empty());
    assert!(terminals.poll_image_replies(Instant::now()).is_empty());
}

#[test]
fn malformed_chunk_removes_only_its_viewer_without_an_image_reply() {
    let (tx, _rx) = channel();
    let mut terminals = multi_registry(tx);
    let startup = enabled_startup(false);
    let mut a = TestViewer::new(1);
    open_viewer(&mut terminals, &startup, &mut a);
    let mut b = TestViewer::new(2);
    attach_viewer(&mut terminals, &startup, &mut b);
    let mut bytes = terminal_crypto::encode_plaintext_v2(&image(8)).expect("chunk");
    bytes[25] = 255;
    let (seq, body) = a.seal_bytes(MULTI_TERMINAL, &bytes);
    let frames = terminals.handle_sealed(MULTI_TERMINAL, Some(&a.id), seq, &body);
    assert!(reply(&a, &frames).is_none());
    assert!(
        !terminals.sessions[MULTI_TERMINAL]
            .viewers
            .contains_key(&a.id)
    );
    assert!(
        terminals.sessions[MULTI_TERMINAL]
            .viewers
            .contains_key(&b.id)
    );
}
