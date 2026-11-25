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

use crate::node::state::{NodeCredential, load_node_credential};

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

/// Preserve the startup enrollment/config pair, including released `set-server`
/// configurations whose credential still names an older address.
#[derive(Default)]
pub struct CredentialPairing {
    startup_server: Option<String>,
}

impl CredentialPairing {
    /// Read once per connection attempt. If startup storage is temporarily
    /// unavailable, the first successful read establishes the startup pair.
    pub fn resolve_credential(
        &mut self,
        server_url: Option<&str>,
        public_origin: Option<&str>,
    ) -> Result<String> {
        self.credential_for_server(resolve_node_credential()?, server_url, public_origin)
    }

    fn credential_for_server(
        &mut self,
        credential: NodeCredential,
        server_url: Option<&str>,
        public_origin: Option<&str>,
    ) -> Result<String> {
        let startup_server = self
            .startup_server
            .get_or_insert_with(|| credential.server.clone());
        anyhow::ensure!(
            credential.server == *startup_server
                || credential_matches_server(&credential, server_url, public_origin),
            "the enrollment changed while wsmp was running; restart wsmp with `wsmp service restart` or restart `wsmp run`"
        );
        Ok(credential.credential)
    }
}

/// Retain the enrollment server so callers can detect a change while running.
pub fn resolve_node_credential() -> Result<NodeCredential> {
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
    Ok(credential)
}

/// Match either the connect address or the explicitly pinned public origin.
pub(crate) fn credential_matches_server(
    credential: &NodeCredential,
    server_url: Option<&str>,
    public_origin: Option<&str>,
) -> bool {
    let origin = |value: &str| {
        Url::parse(value)
            .ok()
            .and_then(|url| matches!(url.scheme(), "http" | "https").then(|| url.origin()))
    };
    let stored = origin(&credential.server);
    stored.is_some()
        && (stored == server_url.and_then(origin) || stored == public_origin.and_then(origin))
}

/// `GET /.well-known/wsmp`. A field a later server adds is ignored.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WellKnown {
    pub server_version: String,
    pub protocol_version: String,
    pub origin: String,
    pub install_script: String,
    pub enroll_path: String,
}

pub fn fetch_well_known(server_url: &str) -> Result<WellKnown> {
    let known = fetch_well_known_document(server_url)?;
    anyhow::ensure!(
        known.protocol_version == crate::wire::protocol::RELAY_PROTOCOL_VERSION,
        "the server speaks relay protocol `{}`, this wsmp speaks `{}`; {}",
        crate::display_escape::escape_single_line(&known.protocol_version),
        crate::wire::protocol::RELAY_PROTOCOL_VERSION,
        if crate::wire::protocol::relay_protocol_major(&known.protocol_version)
            .zip(crate::wire::protocol::relay_protocol_major(
                crate::wire::protocol::RELAY_PROTOCOL_VERSION
            ))
            .is_some_and(|(server, cli)| server < cli)
        {
            "upgrade the server to WS Model Proxy 1.0 or later (or install the wsmp that server serves)"
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

/// Discovery without enrollment validation, also used to diagnose an unreadable HTTP 426.
pub(crate) fn fetch_well_known_document(server_url: &str) -> Result<WellKnown> {
    let url = join(server_url, WELL_KNOWN_PATH)?;
    let mut response = ureq::get(url.as_str())
        .header("Accept", "application/json")
        .config()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_global(Some(std::time::Duration::from_secs(15)))
        .build()
        .call()
        .with_context(|| format!("reaching `{}`", url.as_str()))?;
    let status = response.status().as_u16();
    anyhow::ensure!(
        response.status().is_success(),
        "`{}` answered HTTP status {status}; is this a WS Model Proxy 1.0 or later server?",
        url.as_str()
    );
    response
        .body_mut()
        .read_json()
        .with_context(|| format!("reading `{}`", url.as_str()))
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
#[serde(rename_all = "camelCase")]
pub struct ReplacedNode {
    pub slug: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrolled {
    pub ok: bool,
    pub node_id: String,
    pub slug: String,
    pub credential: String,
    pub replaced: Option<ReplacedNode>,
    pub trust_lower_pending: bool,
    /// Set when the node is temporary: the server deletes it after this long
    /// offline; null for a permanent node.
    #[serde(deserialize_with = "Option::deserialize")]
    pub remove_after_offline_ms: Option<u64>,
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
#[serde(rename_all = "camelCase")]
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

    fn enrollment(server: &str, token: &str) -> NodeCredential {
        NodeCredential {
            node_id: "node-1".into(),
            slug: "spark-1".into(),
            server: server.into(),
            credential: token.into(),
        }
    }

    #[test]
    fn credential_pairing_accepts_legacy_mismatched_startup_without_a_public_origin() {
        for server in ["https://old.invalid", "invalid"] {
            let mut pairing = CredentialPairing::default();
            let credential = enrollment(server, "test-only-token");
            assert_eq!(
                pairing
                    .credential_for_server(
                        credential.clone(),
                        Some("http://192.168.1.10:3000"),
                        None
                    )
                    .expect("legacy startup pair"),
                credential.credential
            );
            assert_eq!(pairing.startup_server.as_deref(), Some(server));
        }
    }

    #[test]
    fn credential_pairing_refuses_a_different_server_mid_run_with_restart_advice() {
        let mut pairing = CredentialPairing::default();
        let configured = Some("https://configured.invalid");
        pairing
            .credential_for_server(
                enrollment("https://legacy.invalid", "initial"),
                configured,
                None,
            )
            .expect("startup");
        for _ in 0..2 {
            let error = pairing
                .credential_for_server(
                    enrollment("https://other.invalid", "replacement"),
                    configured,
                    None,
                )
                .expect_err("cross-server replacement");
            let message = error.to_string();
            assert!(message.contains("enrollment changed while wsmp was running"));
            assert!(message.contains("wsmp service restart"));
            assert!(message.contains("restart `wsmp run`"));
            assert!(!message.contains("login"));
            assert!(!message.contains("replacement"));
        }
        assert_eq!(
            pairing.startup_server.as_deref(),
            Some("https://legacy.invalid")
        );
    }

    #[test]
    fn credential_pairing_accepts_same_server_refresh_mid_run() {
        let mut pairing = CredentialPairing::default();
        for token in ["initial", "refreshed"] {
            assert_eq!(
                pairing
                    .credential_for_server(
                        enrollment("https://legacy.invalid", token),
                        Some("https://configured.invalid"),
                        None
                    )
                    .expect("same legacy enrollment server"),
                token
            );
        }
    }

    #[test]
    fn credential_pairing_accepts_changed_server_matching_config_or_public_origin() {
        let mut pairing = CredentialPairing::default();
        let configured = Some("http://192.168.1.10:3000");
        let public = Some("https://public.invalid");
        for server in [
            "https://legacy.invalid",
            "http://192.168.1.10:3000/path",
            "https://public.invalid:443/path",
        ] {
            assert!(
                pairing
                    .credential_for_server(
                        enrollment(server, "test-only-token"),
                        configured,
                        public
                    )
                    .is_ok()
            );
        }
        assert_eq!(
            pairing.startup_server.as_deref(),
            Some("https://legacy.invalid")
        );
    }

    #[test]
    fn credential_pairing_requires_the_same_valid_server_origin() {
        let credential = NodeCredential {
            node_id: "node-1".into(),
            slug: "spark-1".into(),
            server: "https://example.invalid/enrolled".into(),
            credential: "test-only-token".into(),
        };
        for configured in [
            "https://example.invalid/other",
            "https://example.invalid:443",
        ] {
            assert!(credential_matches_server(
                &credential,
                Some(configured),
                None
            ));
        }
        for configured in [
            None,
            Some("https://other.invalid"),
            Some("http://example.invalid"),
            Some("https://example.invalid:444"),
            Some("invalid"),
        ] {
            assert!(!credential_matches_server(&credential, configured, None));
        }
        let invalid = NodeCredential {
            server: "invalid".into(),
            ..credential
        };
        assert!(!credential_matches_server(
            &invalid,
            Some("invalid"),
            Some("invalid")
        ));
    }

    #[test]
    fn credential_pairing_accepts_the_pinned_public_origin() {
        let credential = NodeCredential {
            node_id: "node-1".into(),
            slug: "spark-1".into(),
            server: "https://example.invalid/enrolled".into(),
            credential: "test-only-token".into(),
        };
        for public in ["https://example.invalid", "https://example.invalid:443"] {
            assert!(credential_matches_server(
                &credential,
                Some("http://192.168.1.10:3000"),
                Some(public)
            ));
        }
        for public in [
            "https://other.invalid",
            "http://example.invalid",
            "https://example.invalid:444",
            "invalid",
        ] {
            assert!(!credential_matches_server(
                &credential,
                Some("http://192.168.1.10:3000"),
                Some(public),
            ));
        }
        // An invalid optional pin does not invalidate a matching connect address.
        assert!(credential_matches_server(
            &credential,
            Some("https://example.invalid"),
            Some("invalid")
        ));
    }

    #[test]
    fn well_known_names_the_side_that_must_upgrade() {
        use std::io::{Read, Write};
        for (version, action) in [
            ("3.0", "upgrade the server"),
            ("5.0", "upgrade wsmp"),
            ("10.0", "upgrade wsmp"),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            let origin = format!("http://{}", listener.local_addr().expect("address"));
            let body = serde_json::json!({
                "serverVersion": "test", "protocolVersion": version, "origin": origin,
                "installScript": "/install.sh", "enrollPath": ENROLL_PATH
            })
            .to_string();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept");
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .expect("timeout");
                let mut request = [0; 4096];
                assert!(stream.read(&mut request).expect("request") > 0);
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).expect("reply");
            });
            let error = fetch_well_known(&origin).expect_err("different protocol");
            server.join().expect("server");
            assert!(error.to_string().contains(action), "{version}: {error}");
        }
    }

    #[test]
    fn enrollment_requires_the_offline_removal_field() {
        let body = serde_json::json!({
            "ok": true, "nodeId": "node-1", "slug": "spark-1",
            "credential": "c".repeat(40), "replaced": null, "trustLowerPending": false
        })
        .to_string();
        assert!(parse_enroll_answer(200, &body).is_err());
    }

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
    fn enroll_answers_parse_and_ignore_a_later_servers_fields() {
        let ok = parse_enroll_answer(
            200,
            &serde_json::json!({
                "ok": true, "nodeId": "node-1", "slug": "spark-1",
                "credential": "c".repeat(40), "replaced": null, "trustLowerPending": false,
                "removeAfterOfflineMs": null
            })
            .to_string(),
        )
        .expect("enrolled");
        assert!(matches!(ok, EnrollOutcome::Enrolled(ref e)
            if e.slug == "spark-1" && e.remove_after_offline_ms.is_none()));
        let temporary = parse_enroll_answer(
            200,
            &serde_json::json!({
                "ok": true, "nodeId": "node-1", "slug": "spark-1",
                "credential": "c".repeat(40), "replaced": null, "trustLowerPending": false,
                "removeAfterOfflineMs": 3_600_000
            })
            .to_string(),
        )
        .expect("enrolled");
        assert!(matches!(temporary, EnrollOutcome::Enrolled(ref e)
            if e.remove_after_offline_ms == Some(3_600_000)));
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
        // A short credential or a missing `ok` is refused; a field a later server adds is not.
        assert!(
            parse_enroll_answer(
                200,
                r#"{"ok":true,"nodeId":"n","slug":"a1","credential":"short","replaced":null,"trustLowerPending":false}"#
            )
            .is_err()
        );
        assert!(matches!(
            parse_enroll_answer(409, r#"{"ok":false,"error":"used","extra":1}"#),
            Ok(EnrollOutcome::Refused(_))
        ));
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
