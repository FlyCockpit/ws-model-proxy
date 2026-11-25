//! Process-wide TLS setup.
//!
//! reqwest (`rustls-no-provider`) and tungstenite both take their rustls crypto
//! provider from the process default. Only `ring` is compiled in, but reqwest
//! reads the installed default without falling back to crate features and
//! panics when none is installed. `main` and every reqwest client builder call
//! `install_crypto_provider` first.

/// Install `ring` as the process-wide rustls crypto provider. Safe to call more
/// than once; a provider that is already installed is kept.
pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[cfg(test)]
mod tests {
    use super::*;

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
