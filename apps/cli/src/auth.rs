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
    message: Option<String>,
}

pub fn start_device_authorization(server_url: &str) -> Result<DeviceCodeStartResponse> {
    let url = join(server_url, "/api/auth/device/code")?;
    let body = serde_json::to_vec(&serde_json::json!({ "client_id": "ws-model-proxy" }))
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
    name: &str,
    cli_slug: &str,
) -> Result<DeviceCredential> {
    let url = join(server_url, "/rpc/cliCredentials/exchangeDeviceCode")?;
    let request = serde_json::json!({
        "json": {
            "deviceCode": device_code,
            "name": name,
            "cliSlug": cli_slug,
        }
    });
    let body = serde_json::to_vec(&request).context("serializing device credential request")?;
    let mut response = match ureq::post(url.as_str())
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .config()
        .http_status_as_error(false)
        .build()
        .send(body)
    {
        Ok(response) => response,
        Err(error) => {
            return Err(error)
                .with_context(|| format!("exchanging approved device code at `{}`", url.as_str()));
        }
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(rpc_status_error(status, response));
    }
    let parsed = response
        .body_mut()
        .read_json::<RpcResponse<DeviceCredentialExchangeResponse>>()
        .context("parsing device credential response")?;
    let parsed = parsed.into_inner();
    let credential = DeviceCredential {
        credential_id: parsed.credential_id,
        user_id: parsed.user_id,
        secret: parsed.secret,
    };
    Ok(credential)
}

fn rpc_status_error(status: u16, mut response: ureq::http::Response<ureq::Body>) -> anyhow::Error {
    let body = response.body_mut().read_to_string().unwrap_or_default();
    if let Ok(parsed) = serde_json::from_str::<RpcErrorEnvelope>(&body) {
        if let Some(message) = parsed.json.message {
            return anyhow::anyhow!("{message}");
        }
    }
    anyhow::anyhow!("device credential exchange failed with HTTP status {status}")
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
