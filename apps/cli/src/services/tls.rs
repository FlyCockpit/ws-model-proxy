//! Process-wide TLS setup.
//!
//! reqwest (`rustls-no-provider`) and tungstenite both take their rustls crypto
//! provider from the process default. Only `ring` is compiled in, but reqwest
//! reads the installed default without falling back to crate features and
//! panics when none is installed. `main` and every reqwest client builder call
//! `install_crypto_provider` first.
//!
//! The relay's TLS configuration is the one tungstenite builds by default for `wss`,
//! built once per process ([`native_roots_client_config`]).

use std::sync::{Arc, Mutex, PoisonError};

/// Install `ring` as the process-wide rustls crypto provider. Safe to call more
/// than once; a provider that is already installed is kept.
pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// The rustls client configuration tungstenite builds by default for `wss` (the installed
/// crypto provider, the system's root certificates), built once per process: loading the
/// roots is slow (macOS reads the keychain), and every relay reconnect would repeat it. A
/// change to the system's roots is picked up at the next start. A failed load is not kept;
/// the next call tries again.
pub fn native_roots_client_config() -> std::io::Result<Arc<rustls::ClientConfig>> {
    static CONFIG: Mutex<Option<Arc<rustls::ClientConfig>>> = Mutex::new(None);
    if let Some(config) = CONFIG
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
    {
        return Ok(Arc::clone(config));
    }
    // Loaded without the lock: a load that never returns (a stuck keychain) must not hold up
    // the next attempt. Callers at the same time may each load; the first one kept is shared.
    let loaded = load_native_roots_client_config()?;
    let mut config = CONFIG.lock().unwrap_or_else(PoisonError::into_inner);
    Ok(Arc::clone(config.get_or_insert(loaded)))
}

fn load_native_roots_client_config() -> std::io::Result<Arc<rustls::ClientConfig>> {
    #[cfg(test)]
    tests::ROOT_LOADS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let rustls_native_certs::CertificateResult { certs, errors, .. } =
        rustls_native_certs::load_native_certs();
    if !errors.is_empty() {
        tracing::warn!(errors = ?errors, "some native root certificates could not be loaded");
    }
    if certs.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("no native root CA certificates found (errors: {errors:?})"),
        ));
    }
    let mut roots = rustls::RootCertStore::empty();
    let (added, ignored) = roots.add_parsable_certificates(certs);
    tracing::debug!(added, ignored, "loaded the native root certificates");
    let mut config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    // A configuration per connection (tungstenite's default) never resumed a session. A shared
    // one would, and a resumed session is not checked against the server's certificate again.
    config.resumption = rustls::client::Resumption::disabled();
    Ok(Arc::new(config))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// How often this process has loaded the system's root certificates.
    pub(crate) static ROOT_LOADS: std::sync::atomic::AtomicUsize =
        std::sync::atomic::AtomicUsize::new(0);

    /// The number of loads is checked in a process of its own, where no other test loads at the
    /// same time (`wss_connects_reuse_the_loaded_root_certificates`).
    #[test]
    fn the_native_roots_configuration_is_loaded_once_and_shared() {
        install_crypto_provider();
        let first = native_roots_client_config().expect("native roots");
        let second = native_roots_client_config().expect("native roots");
        assert!(Arc::ptr_eq(&first, &second));
        // Shared across connections, it never resumes a session.
        assert_eq!(
            format!("{:?}", first.resumption),
            format!("{:?}", rustls::client::Resumption::disabled())
        );
    }

    #[test]
    fn reqwest_client_builds_after_install() {
        install_crypto_provider();
        install_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
        reqwest::Client::builder()
            .build()
            .expect("reqwest client builds with the installed provider");
    }
}
