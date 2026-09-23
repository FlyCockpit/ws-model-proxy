//! Regression test: exactly one rustls crypto provider may be compiled in.
//! With two (reqwest's `rustls` feature adds aws-lc-rs next to ureq's ring),
//! rustls cannot pick one from crate features and tungstenite panics on the
//! first `wss://` connect.
//!
//! This file runs as its own process and deliberately does not call
//! `wsmp::tls::install_crypto_provider`, so the connect below takes the
//! crate-feature fallback path that panicked.

use std::net::TcpListener;
use std::thread;
use std::time::Duration;

#[test]
fn wss_connect_selects_the_single_compiled_provider() {
    // A listener that never speaks TLS: the connect must fail with an error,
    // not panic while building the rustls client config.
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
    let port = listener.local_addr().expect("listener address").port();
    thread::spawn(move || {
        if let Ok((stream, _)) = listener.accept() {
            thread::sleep(Duration::from_millis(200));
            drop(stream);
        }
    });

    let result = tungstenite::connect(format!("wss://localhost:{port}/"));
    assert!(
        result.is_err(),
        "the fake server cannot complete a TLS handshake"
    );
}
