//! Node enrollment (`wsmp login <url> --code`) and the stored node credential.
//!
//! A node enrolls once with a one-time (or multi-use) enrollment code the
//! browser minted: `GET /.well-known/wsmp` pins the server's public origin and
//! protocol, then `POST /api/node/enroll` exchanges the code, the identity
//! public key and a slug for a credential (`node-credential.json`, 0600). The
//! relay presents that credential as a bearer token and signs the hello
//! challenge with the identity key, so copying the credential alone cannot
//! take over another machine.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::state::load_node_credential;

/// The relay protocol `/.well-known/wsmp` must announce.
pub const WELL_KNOWN_PATH: &str = "/.well-known/wsmp";
pub const ENROLL_PATH: &str = "/api/node/enroll";

/// Definitely no credential: no node credential is saved in an existing
/// state directory. Waiting cannot fix it; the person must enroll. Every
/// other resolution failure (an I/O or parse error, a state directory that is
/// not there yet, such as an encrypted home before it is mounted) may clear
/// up and is retried.
#[derive(Debug)]
pub struct MissingCredential(String);

impl std::fmt::Display for MissingCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MissingCredential {}

/// Whether `error` (anywhere in its chain) is a [`MissingCredential`].
pub fn is_missing_credential(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<MissingCredential>().is_some())
}

/// The relay bearer credential from `node-credential.json`.
pub fn resolve_credential() -> Result<String> {
    let Some(credential) = load_node_credential()? else {
        let state_dir = crate::paths::state_dir()?;
        if !state_dir.is_dir() {
            anyhow::bail!(
                "state directory `{}` does not exist (not mounted yet?); no node credential can be read",
                state_dir.display()
            );
        }
        return Err(MissingCredential(
            "this node is not enrolled; run `wsmp login <url> --code <code>` (the code comes from the Nodes page)"
                .to_string(),
        )
        .into());
    };
    Ok(credential.credential)
}

/// `GET /.well-known/wsmp` (strict: an unknown field is refused).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WellKnown {
    pub server_version: String,
    pub protocol_version: String,
    pub origin: String,
    pub install_script: String,
    pub enroll_path: String,
}

pub fn fetch_well_known(server_url: &str) -> Result<WellKnown> {
    let url = join(server_url, WELL_KNOWN_PATH)?;
    let mut response = ureq::get(url.as_str())
        .header("Accept", "application/json")
        .config()
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .call()
        .with_context(|| format!("reaching `{}`", url.as_str()))?;
    let status = response.status().as_u16();
    anyhow::ensure!(
        response.status().is_success(),
        "`{}` answered HTTP status {status}; is this a WS Model Proxy 0.4 server?",
        url.as_str()
    );
    let known: WellKnown = response
        .body_mut()
        .read_json()
        .with_context(|| format!("reading `{}`", url.as_str()))?;
    anyhow::ensure!(
        known.protocol_version == crate::protocol::RELAY_PROTOCOL_VERSION,
        "the server speaks relay protocol `{}`, this wsmp speaks `{}`; {}",
        crate::display_escape::escape_single_line(&known.protocol_version),
        crate::protocol::RELAY_PROTOCOL_VERSION,
        if known.protocol_version.as_str() < crate::protocol::RELAY_PROTOCOL_VERSION {
            "upgrade the server"
        } else {
            "upgrade wsmp"
        }
    );
    anyhow::ensure!(
        known.enroll_path == ENROLL_PATH,
        "the server announces an unexpected enrollment path"
    );
    Ok(known)
}

/// `POST /api/node/enroll`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollRequest<'a> {
    pub code: &'a str,
    pub identity_public_key: &'a str,
    pub slug: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<&'a str>,
    pub replace_confirmed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacedNode {
    pub slug: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Enrolled {
    pub ok: bool,
    pub node_id: String,
    pub slug: String,
    pub credential: String,
    pub replaced: Option<ReplacedNode>,
    pub trust_lower_pending: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnrollError {
    InvalidCode,
    Expired,
    Used,
    Revoked,
    SlugTaken,
    ReplaceConfirmationRequired,
    RateLimited,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnrollRefusal {
    pub ok: bool,
    pub error: EnrollError,
    #[serde(default)]
    pub replaces: Option<ReplacedNode>,
    #[serde(default)]
    pub retry_after_sec: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnrollOutcome {
    Enrolled(Enrolled),
    Refused(EnrollRefusal),
}

/// The enrollment code shape (`wsmp_enr_` + 26 base32 characters, 130 bits).
pub fn is_enrollment_code(code: &str) -> bool {
    code.strip_prefix("wsmp_enr_").is_some_and(|rest| {
        rest.len() == 26
            && rest
                .bytes()
                .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b))
    })
}

pub fn enroll(server_url: &str, request: &EnrollRequest<'_>) -> Result<EnrollOutcome> {
    let url = join(server_url, ENROLL_PATH)?;
    let body = serde_json::to_vec(request).context("serializing the enrollment request")?;
    let mut response = ureq::post(url.as_str())
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .config()
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .send(body)
        .with_context(|| format!("enrolling at `{}`", url.as_str()))?;
    let status = response.status().as_u16();
    let text = response
        .body_mut()
        .with_config()
        .limit(64 * 1024)
        .read_to_string()
        .with_context(|| format!("reading the enrollment answer from `{}`", url.as_str()))?;
    parse_enroll_answer(status, &text)
}

fn parse_enroll_answer(status: u16, text: &str) -> Result<EnrollOutcome> {
    let value: serde_json::Value = serde_json::from_str(text).with_context(|| {
        format!("the server answered the enrollment with HTTP status {status} and no JSON body")
    })?;
    match value.get("ok").and_then(serde_json::Value::as_bool) {
        Some(true) => {
            let enrolled: Enrolled =
                serde_json::from_value(value).context("reading the enrollment answer")?;
            anyhow::ensure!(
                (32..=256).contains(&enrolled.credential.len()),
                "the server sent a malformed credential"
            );
            crate::slug::validate_slug(&enrolled.slug)
                .context("the server sent a malformed node slug")?;
            Ok(EnrollOutcome::Enrolled(enrolled))
        }
        Some(false) => Ok(EnrollOutcome::Refused(
            serde_json::from_value(value).context("reading the enrollment refusal")?,
        )),
        None => anyhow::bail!("the server answered the enrollment with HTTP status {status}"),
    }
}

/// What a person reads for a refused enrollment.
pub fn refusal_message(refusal: &EnrollRefusal) -> String {
    match refusal.error {
        EnrollError::InvalidCode => {
            "the enrollment code is not valid; copy it again from the Nodes page".to_string()
        }
        EnrollError::Expired => {
            "the enrollment code expired; mint a new one on the Nodes page".to_string()
        }
        EnrollError::Used => {
            "the enrollment code was already used; mint a new one on the Nodes page".to_string()
        }
        EnrollError::Revoked => "the enrollment code was revoked".to_string(),
        EnrollError::SlugTaken => {
            "another node already uses this name; choose another with `--slug`, or mint a Replace code"
                .to_string()
        }
        EnrollError::ReplaceConfirmationRequired => {
            "this code replaces another node; confirm with `--replace`".to_string()
        }
        EnrollError::RateLimited => match refusal.retry_after_sec {
            Some(secs) => format!("too many enrollment attempts; retry in {secs} s"),
            None => "too many enrollment attempts; retry later".to_string(),
        },
    }
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

    #[test]
    fn enrollment_codes_have_the_minted_shape() {
        assert!(is_enrollment_code("wsmp_enr_ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
        assert!(is_enrollment_code("wsmp_enr_234567ABCDEFGHIJKLMNOPQRST"));
        for bad in [
            "wsmp_enr_ABCDEFGHIJKLMNOPQRSTUVWXY",
            "wsmp_enr_abcdefghijklmnopqrstuvwxyz",
            "wsmp_enr_ABCDEFGHIJKLMNOPQRSTUVWXY1",
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            "",
        ] {
            assert!(!is_enrollment_code(bad), "{bad}");
        }
    }

    #[test]
    fn enroll_answers_parse_strictly() {
        let ok = parse_enroll_answer(
            200,
            &serde_json::json!({
                "ok": true, "nodeId": "nd1", "slug": "spark-1",
                "credential": "c".repeat(40), "replaced": null, "trustLowerPending": false
            })
            .to_string(),
        )
        .expect("enrolled");
        assert!(matches!(ok, EnrollOutcome::Enrolled(ref e) if e.slug == "spark-1"));
        let refused = parse_enroll_answer(
            409,
            r#"{"ok":false,"error":"replace_confirmation_required","replaces":{"slug":"old-1"}}"#,
        )
        .expect("refused");
        let EnrollOutcome::Refused(refusal) = refused else {
            panic!("refusal");
        };
        assert_eq!(refusal.error, EnrollError::ReplaceConfirmationRequired);
        assert_eq!(refusal.replaces.map(|r| r.slug).as_deref(), Some("old-1"));
        // A short credential, an unknown field or a missing `ok` is refused.
        assert!(
            parse_enroll_answer(
                200,
                r#"{"ok":true,"nodeId":"n","slug":"a1","credential":"short","replaced":null,"trustLowerPending":false}"#
            )
            .is_err()
        );
        assert!(parse_enroll_answer(200, r#"{"ok":false,"error":"used","extra":1}"#).is_err());
        assert!(parse_enroll_answer(500, "oops").is_err());
        assert!(parse_enroll_answer(500, "{}").is_err());
    }

    #[test]
    fn refusals_read_as_next_steps() {
        let refusal = EnrollRefusal {
            ok: false,
            error: EnrollError::RateLimited,
            replaces: None,
            retry_after_sec: Some(60),
        };
        assert!(refusal_message(&refusal).contains("60 s"));
    }
}
