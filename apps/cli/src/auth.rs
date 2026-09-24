//! Auth helpers for CLI-token and device-code credentials.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::config::{Config, validate_env_name};
use crate::state::{DeviceCredential, load_device_credential};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedCredential {
    CliToken { env: String, secret: String },
    Device { secret: String },
}

pub fn resolve_credential(config: &Config) -> Result<ResolvedCredential> {
    if let Some(env) = &config.cli_token_env {
        validate_env_name(env)?;
        let secret = std::env::var(env)
            .with_context(|| format!("reading CLI token from environment variable `{env}`"))?;
        if secret.trim().is_empty() {
            anyhow::bail!("CLI token environment variable `{env}` is empty");
        }
        return Ok(ResolvedCredential::CliToken {
            env: env.clone(),
            secret,
        });
    }
    let Some(credential) = load_device_credential()? else {
        anyhow::bail!(
            "no CLI token env var is configured and no device credential exists; run `wsmp login` or `wsmp token login <ENV_VAR>`"
        );
    };
    Ok(ResolvedCredential::Device {
        secret: credential.secret,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCodeStartResponse {
    #[serde(alias = "deviceCode")]
    pub device_code: String,
    #[serde(alias = "userCode")]
    pub user_code: String,
    #[serde(alias = "verificationUri")]
    pub verification_uri: Option<String>,
    #[serde(alias = "verificationUriComplete")]
    pub verification_uri_complete: Option<String>,
    #[serde(alias = "expiresIn")]
    pub expires_in: Option<u64>,
    pub interval: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceCredentialExchangeResponse {
    credential_id: Option<String>,
    user_id: Option<String>,
    secret: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RpcResponse<T> {
    Envelope { json: T },
    Plain(T),
}

impl<T> RpcResponse<T> {
    fn into_inner(self) -> T {
        match self {
            Self::Envelope { json } | Self::Plain(json) => json,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RpcErrorEnvelope {
    json: RpcErrorBody,
}

#[derive(Debug, Deserialize)]
struct RpcErrorBody {
    code: Option<String>,
    message: Option<String>,
    data: Option<RpcErrorData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcErrorData {
    device_flow_error: Option<String>,
}

/// A device-flow state the server tags on an exchange error
/// (`data.deviceFlowError`, RFC 8628 §3.5 names). Login classifies polling
/// results by this field only, never by message text, since a message can
/// echo the user's slug.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceFlowState {
    /// `authorization_pending`: the user has not approved yet; keep polling.
    Pending,
    /// `slow_down`: polled too soon; keep polling, more slowly.
    SlowDown,
    /// `access_denied`: the user denied the request.
    Denied,
    /// `expired_token`: the device code expired.
    Expired,
}

impl DeviceFlowState {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "authorization_pending" => Some(Self::Pending),
            "slow_down" => Some(Self::SlowDown),
            "access_denied" => Some(Self::Denied),
            "expired_token" => Some(Self::Expired),
            _ => None,
        }
    }
}

/// Why exchanging a device code did not produce a credential.
#[derive(Debug)]
pub enum ExchangeError {
    /// A tagged device-flow state (see `DeviceFlowState`).
    DeviceFlow(DeviceFlowState),
    /// Anything else (bad slug, slug mismatch, unknown or already used code,
    /// transport failure). Login stops with this error.
    Other(anyhow::Error),
}

impl From<anyhow::Error> for ExchangeError {
    fn from(error: anyhow::Error) -> Self {
        Self::Other(error)
    }
}

/// The device authorization `scope` naming the one CLI slug this login is
/// for. The server stores it, shows it on the approval page, and mints the
/// credential for this slug only. Mirrors `cliDeviceLoginScope` in
/// `packages/config/src/cli-device-login.ts`.
pub fn device_login_scope(cli_slug: &str) -> String {
    format!("cli-slug:{cli_slug}")
}

pub fn start_device_authorization(
    server_url: &str,
    cli_slug: &str,
) -> Result<DeviceCodeStartResponse> {
    let url = join(server_url, "/api/auth/device/code")?;
    let body = serde_json::to_vec(&serde_json::json!({
        "client_id": "ws-model-proxy",
        "scope": device_login_scope(cli_slug),
    }))
    .context("serializing device authorization request")?;
    let mut response = ureq::post(url.as_str())
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .send(body)
        .with_context(|| format!("starting device authorization at `{}`", url.as_str()))?;
    response
        .body_mut()
        .read_json()
        .context("parsing device authorization response")
}

pub fn exchange_device_code(
    server_url: &str,
    device_code: &str,
    cli_slug: &str,
) -> std::result::Result<DeviceCredential, ExchangeError> {
    let url = join(server_url, "/rpc/cliCredentials/exchangeDeviceCode")?;
    let request = serde_json::json!({
        "json": {
            "deviceCode": device_code,
            "cliSlug": cli_slug,
        }
    });
    let body = serde_json::to_vec(&request).context("serializing device credential request")?;
    let mut response = ureq::post(url.as_str())
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .config()
        .http_status_as_error(false)
        .build()
        .send(body)
        .with_context(|| format!("exchanging approved device code at `{}`", url.as_str()))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.body_mut().read_to_string().unwrap_or_default();
        return Err(classify_exchange_error(status, &body));
    }
    let parsed = response
        .body_mut()
        .read_json::<RpcResponse<DeviceCredentialExchangeResponse>>()
        .context("parsing device credential response")?;
    let parsed = parsed.into_inner();
    Ok(DeviceCredential {
        credential_id: parsed.credential_id,
        user_id: parsed.user_id,
        secret: parsed.secret,
    })
}

/// Classifies a failed exchange by the error body's structured fields.
fn classify_exchange_error(status: u16, body: &str) -> ExchangeError {
    let Ok(parsed) = serde_json::from_str::<RpcErrorEnvelope>(body) else {
        return ExchangeError::Other(anyhow::anyhow!(
            "device credential exchange failed with HTTP status {status}"
        ));
    };
    let error = parsed.json;
    if let Some(state) = error
        .data
        .and_then(|data| data.device_flow_error)
        .as_deref()
        .and_then(DeviceFlowState::parse)
    {
        return ExchangeError::DeviceFlow(state);
    }
    ExchangeError::Other(match (error.message, error.code) {
        (Some(message), _) => anyhow::anyhow!("{message}"),
        (None, Some(code)) => {
            anyhow::anyhow!("device credential exchange failed: {code} (HTTP status {status})")
        }
        (None, None) => {
            anyhow::anyhow!("device credential exchange failed with HTTP status {status}")
        }
    })
}

pub fn join(server_url: &str, path: &str) -> Result<Url> {
    let mut base =
        Url::parse(server_url).with_context(|| format!("parsing server URL `{server_url}`"))?;
    if !base.path().ends_with('/') {
        let path = format!("{}/", base.path());
        base.set_path(&path);
    }
    let path = path.trim_start_matches('/');
    base.join(path)
        .with_context(|| format!("joining server URL `{server_url}` with path `/{path}`"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error_body(code: &str, message: &str, device_flow_error: Option<&str>) -> String {
        let mut json = serde_json::json!({
            "defined": false,
            "code": code,
            "status": 400,
            "message": message,
        });
        if let Some(state) = device_flow_error {
            json["data"] = serde_json::json!({ "deviceFlowError": state });
        }
        serde_json::json!({ "json": json }).to_string()
    }

    #[test]
    fn classifies_tagged_device_flow_states() {
        for (tag, expected) in [
            ("authorization_pending", DeviceFlowState::Pending),
            ("slow_down", DeviceFlowState::SlowDown),
            ("access_denied", DeviceFlowState::Denied),
            ("expired_token", DeviceFlowState::Expired),
        ] {
            let body = error_body("BAD_REQUEST", "anything", Some(tag));
            assert!(matches!(
                classify_exchange_error(400, &body),
                ExchangeError::DeviceFlow(state) if state == expected
            ));
        }
    }

    #[test]
    fn untagged_errors_are_fatal_whatever_the_message_says() {
        // A message can say "pending", "denied", or "expired" (it can echo a
        // slug); only the structured tag counts.
        let body = error_body(
            "BAD_REQUEST",
            "Device authorization for `pending-denied-expired` is pending, denied, or expired.",
            None,
        );
        match classify_exchange_error(400, &body) {
            ExchangeError::Other(error) => {
                assert!(error.to_string().contains("pending-denied-expired"));
            }
            ExchangeError::DeviceFlow(state) => panic!("classified as {state:?}"),
        }
    }

    #[test]
    fn device_login_scope_names_the_slug() {
        assert_eq!(device_login_scope("desk-01"), "cli-slug:desk-01");
    }

    #[test]
    fn unknown_tags_and_unparseable_bodies_are_fatal() {
        let body = error_body("BAD_REQUEST", "odd", Some("something_new"));
        assert!(matches!(
            classify_exchange_error(400, &body),
            ExchangeError::Other(_)
        ));
        match classify_exchange_error(502, "<html>bad gateway</html>") {
            ExchangeError::Other(error) => assert!(error.to_string().contains("502")),
            ExchangeError::DeviceFlow(state) => panic!("classified as {state:?}"),
        }
    }
}
