//! The relay's upstream HTTP: one process-long runtime and connection pool
//! for every request to a runtime endpoint (relayed requests, STT), and the
//! rule that joins a request path onto an endpoint's base URL.

use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context, Result};
use url::Url;

// Request workers are synchronous threads, but their HTTP work is async. Keep
// one process-long runtime and connection pool instead of constructing a Tokio
// reactor and reqwest client for every relayed request.
static UPSTREAM_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static UPSTREAM_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) fn runtime() -> Result<&'static tokio::runtime::Runtime> {
    if let Some(runtime) = UPSTREAM_RUNTIME.get() {
        return Ok(runtime);
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("creating shared cancellable upstream runtime")?;
    let _ = UPSTREAM_RUNTIME.set(runtime);
    UPSTREAM_RUNTIME
        .get()
        .context("initializing shared cancellable upstream runtime")
}

pub(crate) fn http_client() -> Result<&'static reqwest::Client> {
    if let Some(client) = UPSTREAM_HTTP_CLIENT.get() {
        return Ok(client);
    }
    crate::services::tls::install_crypto_provider();
    let client = reqwest::Client::builder()
        .connect_timeout(UPSTREAM_CONNECT_TIMEOUT)
        // Redirects are an execution boundary: replaying configured credentials
        // to a Location target (even same-origin) is not safe without validating
        // every hop. Native relay therefore exposes 3xx to the caller unchanged.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("building shared cancellable upstream client")?;
    let _ = UPSTREAM_HTTP_CLIENT.set(client);
    UPSTREAM_HTTP_CLIENT
        .get()
        .context("initializing shared cancellable upstream client")
}

/// The upstream URL for `request_path` on a runtime at `base_url` (§4.8):
/// API paths (`/v1/...`) join onto the base URL, whose API prefix replaces the
/// leading `/v1`; engine routes (readiness, metrics reader, count route) join
/// onto the origin. The result must stay on the base URL's origin.
pub(crate) fn endpoint_url(base_url: &str, request_path: &str) -> Result<Url> {
    let base =
        Url::parse(base_url).with_context(|| format!("parsing endpoint URL `{base_url}`"))?;
    anyhow::ensure!(
        crate::services::runtimes::allowlist::path_is_plain(request_path),
        "the request path is not a plain path"
    );
    let prefix = base.path().trim_end_matches('/');
    let path = match request_path.strip_prefix("/v1") {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            // No prefix: keep `/v1`. A prefix replaces it.
            if prefix.is_empty() {
                request_path.to_string()
            } else {
                format!("{prefix}{rest}")
            }
        }
        _ => request_path.to_string(),
    };
    let mut url = base.clone();
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    anyhow::ensure!(
        url.origin() == base.origin() && url.path() == path,
        "the request path leaves the runtime's address"
    );
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_paths_take_the_prefix_and_engine_routes_the_origin() {
        let join = |base: &str, path: &str| endpoint_url(base, path).map(|url| url.to_string());
        for (base, path, want) in [
            (
                "http://127.0.0.1:8080/v1",
                "/v1/chat/completions",
                "http://127.0.0.1:8080/v1/chat/completions",
            ),
            (
                "http://127.0.0.1:8080",
                "/v1/chat/completions",
                "http://127.0.0.1:8080/v1/chat/completions",
            ),
            (
                "http://127.0.0.1:8080/openai",
                "/v1/chat/completions",
                "http://127.0.0.1:8080/openai/chat/completions",
            ),
            (
                "http://127.0.0.1:8080/api/v1",
                "/v1/models",
                "http://127.0.0.1:8080/api/v1/models",
            ),
            (
                "http://127.0.0.1:8080/v1",
                "/slots",
                "http://127.0.0.1:8080/slots",
            ),
            (
                "http://[::1]:8080/v1",
                "/v1/models",
                "http://[::1]:8080/v1/models",
            ),
            (
                "http://127.0.0.1:8080/v1",
                "/v1x/models",
                "http://127.0.0.1:8080/v1x/models",
            ),
        ] {
            assert_eq!(join(base, path).expect(path), want, "{base} {path}");
        }
    }

    #[test]
    fn a_request_path_never_leaves_the_runtime_address() {
        for path in [
            "http://evil.example/x",
            "/https://evil.example/x",
            "https:evil.example",
            "/https:evil.example/x",
            "/ws:evil.example/x",
            "/file:etc/passwd",
            "\\\\evil.example/x",
            "/v1/../../admin",
            "//evil.example/x",
            "/v1/%2e%2e/admin",
            "/v1/models?x=1",
        ] {
            assert!(
                endpoint_url("http://127.0.0.1:8000/v1", path).is_err(),
                "{path}"
            );
        }
    }
}
