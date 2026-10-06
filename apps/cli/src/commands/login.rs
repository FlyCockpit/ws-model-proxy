//! `wsmp login <url> --code CODE`: enroll this machine as a node.
//!
//! 1. Check `/.well-known/wsmp` (relay protocol 3.0, the server's public
//!    origin, pinned when it differs from the URL's).
//! 2. Exchange the enrollment code, this machine's identity public key and a
//!    slug for the node credential. A Replace code needs `--replace` or a
//!    typed `yes`.
//! 3. Choose trust (prompt on a terminal unless `--trust`; default Full
//!    control, with a warning when nobody was asked).
//! 4. Write `config.json` and `node-credential.json` (0600).
//! 5. Offer the per-user service (`--service`/`--no-service`).
//!
//! The code comes from `--code`, else `WSMP_ENROLL_CODE` (kept out of shell
//! history), else a prompt. It is never printed or logged.

use std::io::{IsTerminal, Write};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::auth::{
    EnrollError, EnrollOutcome, EnrollRequest, enroll, fetch_well_known, is_enrollment_code,
    refusal_message,
};
use crate::config::{Config, ConfigLock, is_loopback_host, server_url_http_warning};
use crate::display_escape::escape_single_line;
use crate::hostname::hostname_slug;
use crate::output;
use crate::protocol::frames::TrustValue;
use crate::slug::validate_slug;
use crate::state::{NodeCredential, save_node_credential};

const CODE_ENV: &str = "WSMP_ENROLL_CODE";

#[derive(Debug, clap::Args)]
pub struct Args {
    /// The server, for example `https://wsmp.example.com`.
    url: String,
    /// The enrollment code from the Nodes page (or `WSMP_ENROLL_CODE`).
    #[arg(long)]
    code: Option<String>,
    /// This node's name. Defaults to the saved one, else the hostname.
    #[arg(long)]
    slug: Option<String>,
    /// Confirm that a Replace code moves another node to this machine.
    #[arg(long)]
    replace: bool,
    /// What the server may do here. Prompted on a terminal; default `full`.
    #[arg(long, value_enum)]
    trust: Option<TrustArg>,
    /// Install and start the per-user service without asking.
    #[arg(long, conflicts_with = "no_service")]
    service: bool,
    /// Do not install the service (run `wsmp run` yourself).
    #[arg(long)]
    no_service: bool,
    /// Emit JSON instead of human-readable text.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
enum TrustArg {
    Full,
    Relay,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginOutput<'a> {
    node_id: &'a str,
    slug: &'a str,
    server: &'a str,
    trust: &'a str,
    replaced: Option<&'a str>,
    remove_after_offline_ms: Option<u64>,
    service_installed: bool,
}

pub fn run(args: &Args) -> Result<()> {
    if std::env::var_os(crate::trust::JOB_MARKER_ENV).is_some() {
        anyhow::bail!("`wsmp login` cannot run from a command, job or terminal wsmp started");
    }
    let server_url = normalize_server_url(&args.url)?;
    if let Some(warning) = server_url_http_warning(&server_url) {
        output::diagnostic(warning)?;
    }
    let known = fetch_well_known(&server_url)?;
    let public_origin = crate::config::normalize_public_origin(&known.origin)
        .context("the server announces an invalid public origin")?;
    let url_origin = url::Url::parse(&server_url)?.origin().ascii_serialization();
    let saved = Config::load()?;
    let slug = requested_slug(args, saved.cli_slug.as_deref())?;
    let code = enrollment_code(args)?;
    let state_dir = crate::paths::state_dir().context("determining the state directory")?;
    let identity = crate::terminal_identity::load_or_create(&state_dir)
        .context("loading the node identity key")?;
    let identity_public_key = identity.public_b64url();
    let hostname = crate::hostname::reported_hostname();
    let mut replace_confirmed = args.replace;
    let enrolled = loop {
        let request = EnrollRequest {
            code: &code,
            identity_public_key: &identity_public_key,
            slug: &slug,
            hostname: hostname.as_deref(),
            replace_confirmed,
        };
        match enroll(&server_url, &request)? {
            EnrollOutcome::Enrolled(enrolled) => break enrolled,
            EnrollOutcome::Refused(refusal)
                if refusal.error == EnrollError::ReplaceConfirmationRequired
                    && !replace_confirmed =>
            {
                let old = refusal
                    .replaces
                    .as_ref()
                    .map_or("another node".to_string(), |node| {
                        escape_single_line(&node.slug)
                    });
                output::diagnostic(format!(
                    "This replaces node {old}: its runtimes and traffic move to this machine."
                ))?;
                anyhow::ensure!(
                    interactive() && ask("Type yes to continue: ")?.trim() == "yes",
                    "not replaced; pass `--replace` to confirm"
                );
                replace_confirmed = true;
            }
            EnrollOutcome::Refused(refusal) => anyhow::bail!(refusal_message(&refusal)),
        }
    };
    let trust = choose_trust(args, &known.origin)?;
    // Trust from a Relay-only node this one replaces: the server lowers it on
    // the first hello; start lowered so nothing Full-only runs before that.
    let trust = if enrolled.trust_lower_pending {
        TrustValue::Relay
    } else {
        trust
    };
    {
        let _lock = ConfigLock::exclusive()?;
        let mut config = Config::load()?;
        // Never raise a node that is already Relay only (unset counts) or
        // was lowered (a frozen copy exists) through a re-login.
        let enrolled_before = config.server_url.is_some()
            || crate::state::load_node_credential()
                .ok()
                .flatten()
                .is_some();
        let keep_relay = crate::runtime_store::frozen_path()
            .map(|path| path.exists())
            .unwrap_or(true)
            || (enrolled_before && crate::trust::configured(&config) == TrustValue::Relay);
        let chosen = if keep_relay { TrustValue::Relay } else { trust };
        if chosen == TrustValue::Relay {
            // The marker first, then the config (as every lowering does).
            crate::runtime_store::freeze()?;
        }
        config.server_url = Some(server_url.clone());
        config.public_origin = (public_origin != url_origin).then(|| public_origin.clone());
        config.cli_slug = Some(enrolled.slug.clone());
        config.trust = Some(chosen);
        config.save()?;
    }
    save_node_credential(&NodeCredential {
        node_id: enrolled.node_id.clone(),
        slug: enrolled.slug.clone(),
        server: server_url.clone(),
        credential: enrolled.credential.clone(),
    })?;
    let config = Config::load_required()?;
    let trust = crate::trust::configured(&config);
    let service_installed = offer_service(args)?;
    if args.json {
        return output::json(&LoginOutput {
            node_id: &enrolled.node_id,
            slug: &enrolled.slug,
            server: &server_url,
            trust: crate::trust::word(trust),
            replaced: enrolled.replaced.as_ref().map(|node| node.slug.as_str()),
            remove_after_offline_ms: enrolled.remove_after_offline_ms,
            service_installed,
        });
    }
    output::line(format!(
        "enrolled as node `{}` ({})",
        enrolled.slug,
        match trust {
            TrustValue::Full => "full control",
            TrustValue::Relay => "relay only",
        }
    ))?;
    if let Some(node) = &enrolled.replaced {
        output::line(format!(
            "replaced node `{}`",
            escape_single_line(&node.slug)
        ))?;
    }
    if let Some(ms) = enrolled.remove_after_offline_ms {
        output::line(format!(
            "temporary node: the server removes it after {} offline",
            offline_window(ms)
        ))?;
    }
    if !service_installed {
        output::line("start the relay with `wsmp run` (or `wsmp service install`)")?;
    }
    Ok(())
}

/// A temporary node's offline window, in the largest whole unit.
fn offline_window(ms: u64) -> String {
    let minutes = ms / 60_000;
    let (count, unit) = if minutes >= 1_440 && minutes.is_multiple_of(1_440) {
        (minutes / 1_440, "day")
    } else if minutes >= 60 && minutes.is_multiple_of(60) {
        (minutes / 60, "hour")
    } else {
        (minutes.max(1), "minute")
    };
    format!("{count} {unit}{}", if count == 1 { "" } else { "s" })
}

/// `https://` unless loopback; trailing slash and path dropped.
fn normalize_server_url(raw: &str) -> Result<String> {
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let url = url::Url::parse(&with_scheme).with_context(|| format!("parsing `{raw}`"))?;
    anyhow::ensure!(
        matches!(url.scheme(), "http" | "https"),
        "the server URL must be http(s)"
    );
    anyhow::ensure!(
        url.username().is_empty() && url.password().is_none() && url.host_str().is_some(),
        "the server URL must be plain `https://host[:port]`"
    );
    if url.scheme() == "http" && !is_loopback_host(&url) {
        output::diagnostic(
            "warning: plain http sends the enrollment code and node credential unencrypted",
        )?;
    }
    Ok(url.origin().ascii_serialization())
}

fn interactive() -> bool {
    std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
}

fn ask(text: &str) -> Result<String> {
    let mut err = std::io::stderr().lock();
    write!(err, "{text}").context("writing the prompt")?;
    err.flush().context("flushing the prompt")?;
    let mut answer = String::new();
    std::io::stdin()
        .read_line(&mut answer)
        .context("reading the answer")?;
    Ok(answer)
}

fn enrollment_code(args: &Args) -> Result<String> {
    let code = match &args.code {
        Some(code) => code.clone(),
        None => match std::env::var(CODE_ENV) {
            Ok(code) if !code.is_empty() => code,
            _ if interactive() => ask("Enrollment code: ")?.trim().to_string(),
            _ => {
                anyhow::bail!("pass `--code` (or set `{CODE_ENV}`); mint a code on the Nodes page")
            }
        },
    };
    anyhow::ensure!(
        is_enrollment_code(code.trim()),
        "that is not an enrollment code (`wsmp_enr_` and 26 letters/digits)"
    );
    Ok(code.trim().to_string())
}

fn requested_slug(args: &Args, saved: Option<&str>) -> Result<String> {
    if let Some(slug) = &args.slug {
        validate_slug(slug).with_context(|| format!("validating node slug `{slug}`"))?;
        return Ok(slug.clone());
    }
    let default = saved
        .filter(|slug| validate_slug(slug).is_ok())
        .map(str::to_string)
        .or_else(hostname_slug);
    if !interactive() {
        return default.context(
            "no node slug can be derived from this machine's hostname; pass `--slug <slug>`",
        );
    }
    let text = match &default {
        Some(slug) => format!("Node name [{slug}]: "),
        None => "Node name: ".to_string(),
    };
    loop {
        let answer = ask(&text)?;
        let slug = match (answer.trim(), default.as_deref()) {
            ("", Some(default)) => default.to_string(),
            (typed, _) => typed.to_string(),
        };
        match validate_slug(&slug) {
            Ok(()) => return Ok(slug),
            Err(error) => output::diagnostic(format!("invalid node name: {error}"))?,
        }
    }
}

fn choose_trust(args: &Args, origin: &str) -> Result<TrustValue> {
    if let Some(trust) = args.trust {
        return Ok(match trust {
            TrustArg::Full => TrustValue::Full,
            TrustArg::Relay => TrustValue::Relay,
        });
    }
    if !interactive() {
        output::diagnostic(
            "warning: no terminal to ask, so this node gives the server full control; lower it any time with `wsmp trust relay`",
        )?;
        return Ok(TrustValue::Full);
    }
    let host = url::Url::parse(origin)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| origin.to_string());
    let host = escape_single_line(&host);
    output::diagnostic(format!(
        "What may {host} do on this machine?\n  1) Full control (recommended for your own machines)\n     It can define and start model servers, run commands, read and write files in folders\n     you allow, and open terminals. Anyone who controls that server or your account can do\n     the same.\n  2) Relay only\n     It can only send requests to model servers on this machine, and start or stop the ones\n     already defined. Change later with `wsmp trust`."
    ))?;
    loop {
        match ask("Choice [1]: ")?.trim() {
            "" | "1" => return Ok(TrustValue::Full),
            "2" => return Ok(TrustValue::Relay),
            _ => output::diagnostic("type 1 or 2")?,
        }
    }
}

fn offer_service(args: &Args) -> Result<bool> {
    if args.no_service {
        return Ok(false);
    }
    let install = args.service
        || (interactive()
            && matches!(
                ask("Install as a service so it starts at boot? [Y/n]: ")?
                    .trim()
                    .to_ascii_lowercase()
                    .as_str(),
                "" | "y" | "yes"
            ));
    if !install {
        return Ok(false);
    }
    crate::commands::service::install()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    #[test]
    fn offline_windows_read_in_whole_units() {
        assert_eq!(super::offline_window(3_600_000), "1 hour");
        assert_eq!(super::offline_window(7_200_000), "2 hours");
        assert_eq!(super::offline_window(172_800_000), "2 days");
        assert_eq!(super::offline_window(5_400_000), "90 minutes");
        assert_eq!(super::offline_window(60_000), "1 minute");
    }

    use super::*;

    #[test]
    fn server_urls_normalize_to_their_origin() {
        assert_eq!(
            normalize_server_url("wsmp.example.com").expect("bare host"),
            "https://wsmp.example.com"
        );
        assert_eq!(
            normalize_server_url("https://wsmp.example.com/nodes/").expect("path dropped"),
            "https://wsmp.example.com"
        );
        assert_eq!(
            normalize_server_url("http://127.0.0.1:3000").expect("loopback http"),
            "http://127.0.0.1:3000"
        );
        assert!(normalize_server_url("ftp://x").is_err());
        assert!(normalize_server_url("https://user:pw@x").is_err());
    }
}
