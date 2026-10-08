//! `wsmp login <url> --code CODE`: enroll this machine as a node.
//!
//! 1. Check `/.well-known/wsmp` (relay protocol 3.0, the server's public
//!    origin, pinned when it differs from the URL's).
//! 2. Exchange the enrollment code, this machine's identity public key and a
//!    slug for the node credential. A Replace code needs `--replace` or a
//!    typed `yes`.
//! 3. Choose trust (prompt on a terminal unless `--trust`; default Full
//!    control, with a warning when nobody was asked), then browser
//!    terminals (prompt on a terminal unless `--human-terminal`; default
//!    yes; without a terminal the saved value, off unless set, is kept).
//! 4. Write `config.json` and `node-credential.json` (0600).
//! 5. Offer the per-user service (`--service`/`--no-service`).
//!
//! `--yes` takes every default without asking (the node name, installing the
//! service) except the security choices: it needs `--trust`, browser
//! terminals stay as saved unless `--human-terminal` says otherwise, and a
//! Replace code still needs `--replace`.
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
use crate::commands::config::Switch;
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
    /// Allow browser terminals on this node. Prompted on a terminal
    /// (default `on`); without one, the saved setting (default `off`) stays.
    #[arg(long, value_enum, value_name = "on|off")]
    human_terminal: Option<Switch>,
    /// Install and start the per-user service without asking.
    #[arg(long, conflicts_with = "no_service")]
    service: bool,
    /// Do not install the service (run `wsmp run` yourself).
    #[arg(long)]
    no_service: bool,
    /// Take the defaults without asking: the saved or hostname node name,
    /// and installing the service (unless `--no-service`). Never a security
    /// choice: it needs `--trust`, leaves browser terminals as saved (off
    /// unless set) unless `--human-terminal` is given, and a Replace code
    /// still needs `--replace`.
    #[arg(long, short = 'y', requires = "trust")]
    yes: bool,
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
    allow_human_terminal: bool,
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
    let prior = prior_enrollment(
        saved.server_url.as_deref(),
        saved.trust,
        crate::state::load_node_credential(),
        &[server_url.as_str(), public_origin.as_str()],
    );
    // An earlier enrollment elsewhere (another server, or a 0.3 credential)
    // does not hand its node name to this one: that would leave its node
    // behind as a ghost under a reused name.
    let saved_slug = match prior {
        Prior::SameServer | Prior::None => saved.cli_slug.as_deref(),
        Prior::Stale => None,
    };
    let slug = requested_slug(args, saved_slug)?;
    if prior == Prior::Stale
        && args.slug.is_none()
        && let Some(old) = saved.cli_slug.as_deref()
        && old != slug
    {
        output::diagnostic(format!(
            "not reusing the earlier node name `{}` from an older enrollment; this node is `{}`",
            escape_single_line(old),
            escape_single_line(&slug)
        ))?;
    }
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
                    asks(args) && ask("Type yes to continue: ")?.trim() == "yes",
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
    // Not asked when the node will stay Relay only (rechecked under the lock).
    let human_terminal = if keeps_relay(&Config::load()?, prior) {
        choose_human_terminal(args, TrustValue::Relay)?
    } else {
        choose_human_terminal(args, trust)?
    };
    // Set only when this re-login changed it: a running relay needs a restart.
    let human_terminal_changed;
    let kept_relay;
    {
        let _lock = ConfigLock::exclusive()?;
        let mut config = Config::load()?;
        human_terminal_changed = config.server_url.is_some()
            && human_terminal.is_some_and(|allow| allow != config.allow_human_terminal);
        let chosen = if keeps_relay(&config, prior) {
            TrustValue::Relay
        } else {
            trust
        };
        kept_relay = chosen != trust;
        if chosen == TrustValue::Relay {
            // The marker first, then the config (as every lowering does).
            crate::runtime_store::freeze()?;
        }
        config.server_url = Some(server_url.clone());
        config.public_origin = (public_origin != url_origin).then(|| public_origin.clone());
        config.cli_slug = Some(enrolled.slug.clone());
        config.trust = Some(chosen);
        if let Some(allow) = human_terminal {
            config.allow_human_terminal = allow;
        }
        config.save()?;
    }
    save_node_credential(&NodeCredential {
        node_id: enrolled.node_id.clone(),
        slug: enrolled.slug.clone(),
        server: server_url.clone(),
        credential: enrolled.credential.clone(),
    })?;
    if kept_relay {
        output::diagnostic(
            "this node stays Relay only: it was lowered on this machine before; raise it with `wsmp trust full` on a terminal",
        )?;
    }
    let config = Config::load_required()?;
    let trust = crate::trust::configured(&config);
    let allow_human_terminal = config.allow_human_terminal;
    if human_terminal.is_none() && trust == TrustValue::Full {
        output::diagnostic(format!(
            "warning: {}, so browser terminals stay {}; set them with `--human-terminal on|off` or `wsmp config set-human-terminal on|off`",
            if args.yes {
                "not asked (`--yes`)"
            } else {
                "no terminal to ask"
            },
            on_off(allow_human_terminal)
        ))?;
    }
    let service_installed = offer_service(args)?;
    // A relay already running reads the setting only when it starts.
    if human_terminal_changed && !service_installed {
        output::diagnostic(
            "restart wsmp if it is already running to apply the browser terminal setting",
        )?;
    }
    if args.json {
        return output::json(&LoginOutput {
            node_id: &enrolled.node_id,
            slug: &enrolled.slug,
            server: &server_url,
            trust: crate::trust::word(trust),
            allow_human_terminal,
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
    output::line(format!(
        "browser terminals: {}{}",
        on_off(allow_human_terminal),
        if allow_human_terminal && trust == TrustValue::Relay {
            " (they need full control)"
        } else {
            ""
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

/// Whether login may prompt: on a terminal, and not told `--yes`.
fn asks(args: &Args) -> bool {
    !args.yes && interactive()
}

fn ask(text: &str) -> Result<String> {
    let mut err = std::io::stderr().lock();
    write!(err, "{text}").context("writing the prompt")?;
    err.flush().context("flushing the prompt")?;
    let mut answer = String::new();
    let read = std::io::stdin()
        .read_line(&mut answer)
        .context("reading the answer")?;
    // End of input is not an answer: never loop on it or take it as a default.
    anyhow::ensure!(
        read > 0,
        "the prompt reached end of input; pass the value as an option instead"
    );
    Ok(answer)
}

fn enrollment_code(args: &Args) -> Result<String> {
    let code = match &args.code {
        Some(code) => code.clone(),
        None => match std::env::var(CODE_ENV) {
            Ok(code) if !code.is_empty() => code,
            _ if asks(args) => ask("Enrollment code: ")?.trim().to_string(),
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
    if !asks(args) {
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

/// What this machine was enrolled with before this login.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Prior {
    /// Never enrolled.
    None,
    /// A 0.4 credential for this same server: a re-login.
    SameServer,
    /// Leftovers of another enrollment: a credential for another server, a
    /// 0.3 credential this version cannot read, or a 0.3 config (no `trust`)
    /// without one. This login is a fresh enrollment.
    Stale,
}

/// `url` as an origin (`scheme://host[:port]`), so spellings of one server compare equal.
fn origin_of(url: &str) -> Option<String> {
    let with_scheme = if url.contains("://") {
        url.to_string()
    } else {
        format!("https://{url}")
    };
    url::Url::parse(&with_scheme)
        .ok()
        .map(|url| url.origin().ascii_serialization())
}

/// `this_server` holds every name of the server being logged into (the URL
/// given and its announced public origin).
fn prior_enrollment(
    saved_server: Option<&str>,
    saved_trust: Option<TrustValue>,
    credential: Result<Option<crate::state::NodeCredential>>,
    this_server: &[&str],
) -> Prior {
    let here = |url: &str| {
        origin_of(url).is_some_and(|origin| {
            this_server
                .iter()
                .any(|name| origin_of(name).as_deref() == Some(origin.as_str()))
        })
    };
    match credential {
        Ok(Some(credential)) if here(&credential.server) => Prior::SameServer,
        Ok(Some(_)) | Err(_) => Prior::Stale,
        // `wsmp logout` keeps the 0.4 config (it has `trust`): logging back
        // in to the same server is a re-login, not a fresh enrollment.
        Ok(None) => match saved_server {
            None => Prior::None,
            Some(server) if saved_trust.is_some() && here(server) => Prior::SameServer,
            Some(_) => Prior::Stale,
        },
    }
}

/// Whether a login must keep this node Relay only. A person's explicit
/// lowering always holds: a frozen copy exists (every lowering writes one),
/// or this same server's node was saved as `relay`. An absent trust (a 0.3
/// config) is not a lowering, and a fresh enrollment takes the chosen trust.
fn keeps_relay(config: &Config, prior: Prior) -> bool {
    let frozen = crate::runtime_store::frozen_path()
        .map(|path| path.exists())
        .unwrap_or(true);
    keeps_relay_with(frozen, prior, config.trust)
}

fn keeps_relay_with(frozen: bool, prior: Prior, saved: Option<TrustValue>) -> bool {
    frozen || (prior == Prior::SameServer && saved == Some(TrustValue::Relay))
}

/// The browser terminal setting to write: `Some` sets it, `None` keeps the
/// saved one. Never asked at Relay only, where terminals cannot open.
fn choose_human_terminal(args: &Args, trust: TrustValue) -> Result<Option<bool>> {
    if let Some(state) = args.human_terminal {
        return Ok(Some(state.enabled()));
    }
    if trust == TrustValue::Relay || !asks(args) {
        return Ok(None);
    }
    output::diagnostic(
        "Browser terminals open a shell on this machine from the server's Terminals page.\n  Change later with `wsmp config set-human-terminal on|off`.",
    )?;
    loop {
        match yes_no(&ask("Allow browser terminals on this node? [Y/n]: ")?, true) {
            Some(allow) => return Ok(Some(allow)),
            None => output::diagnostic("type y or n")?,
        }
    }
}

/// A `[Y/n]` answer: empty takes `default`; anything else unclear is `None`.
fn yes_no(answer: &str, default: bool) -> Option<bool> {
    match answer.trim().to_ascii_lowercase().as_str() {
        "" => Some(default),
        "y" | "yes" => Some(true),
        "n" | "no" => Some(false),
        _ => None,
    }
}

fn on_off(value: bool) -> &'static str {
    if value { "on" } else { "off" }
}

fn offer_service(args: &Args) -> Result<bool> {
    if args.no_service {
        return Ok(false);
    }
    // `--yes` takes the default only where a per-user service exists.
    let install = args.service
        || (args.yes && cfg!(any(target_os = "linux", target_os = "macos")))
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
    crate::commands::service::install(args.json)?;
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
    fn browser_terminal_answers_default_to_yes() {
        assert_eq!(yes_no("\n", true), Some(true));
        assert_eq!(yes_no(" Y\n", true), Some(true));
        assert_eq!(yes_no("yes", true), Some(true));
        assert_eq!(yes_no("n\n", true), Some(false));
        assert_eq!(yes_no("NO", true), Some(false));
        assert_eq!(yes_no("maybe", true), None);
        assert_eq!(yes_no("", false), Some(false));
    }

    fn login_args(extra: &[&str]) -> Args {
        use clap::Parser;
        #[derive(clap::Parser)]
        struct Wrapper {
            #[command(flatten)]
            args: Args,
        }
        let mut argv = vec!["wsmp", "https://wsmp.example.com"];
        argv.extend_from_slice(extra);
        Wrapper::try_parse_from(argv).expect("login args").args
    }

    #[test]
    fn yes_needs_an_explicit_trust_and_never_turns_terminals_on() {
        use clap::Parser;
        #[derive(clap::Parser)]
        struct Wrapper {
            #[command(flatten)]
            args: Args,
        }
        assert!(Wrapper::try_parse_from(["wsmp", "https://x.example", "--yes"]).is_err());
        let args = login_args(&["--yes", "--trust", "full"]);
        assert!(!asks(&args));
        // Not asked: the saved setting stays.
        assert_eq!(
            choose_human_terminal(&args, TrustValue::Full).unwrap(),
            None
        );
        let on = login_args(&["--yes", "--trust", "full", "--human-terminal", "on"]);
        assert_eq!(
            choose_human_terminal(&on, TrustValue::Full).unwrap(),
            Some(true)
        );
    }

    #[test]
    fn the_human_terminal_flag_wins_at_either_trust() {
        let on = login_args(&["--human-terminal", "on"]);
        let off = login_args(&["--human-terminal", "off"]);
        for trust in [TrustValue::Full, TrustValue::Relay] {
            assert_eq!(choose_human_terminal(&on, trust).unwrap(), Some(true));
            assert_eq!(choose_human_terminal(&off, trust).unwrap(), Some(false));
        }
        // Relay only never asks and keeps the saved value.
        assert_eq!(
            choose_human_terminal(&login_args(&[]), TrustValue::Relay).unwrap(),
            None
        );
    }

    fn credential(server: &str) -> crate::state::NodeCredential {
        crate::state::NodeCredential {
            node_id: "node-1".into(),
            slug: "old-box".into(),
            server: server.into(),
            credential: "c".repeat(48),
        }
    }

    #[test]
    fn leftovers_of_another_enrollment_make_a_fresh_one() {
        let here = "https://models.example.com";
        let names = [here, "https://public.example.com"];
        let full = Some(TrustValue::Full);
        assert_eq!(prior_enrollment(None, None, Ok(None), &names), Prior::None);
        assert_eq!(
            prior_enrollment(Some(here), full, Ok(Some(credential(here))), &names),
            Prior::SameServer
        );
        // Another spelling of this server (as typed, or its public origin).
        assert_eq!(
            prior_enrollment(
                Some(here),
                full,
                Ok(Some(credential("https://public.example.com/"))),
                &names
            ),
            Prior::SameServer
        );
        // After `wsmp logout`: the 0.4 config (with trust) stays, the credential goes.
        assert_eq!(
            prior_enrollment(Some(here), full, Ok(None), &names),
            Prior::SameServer
        );
        // Another server, a 0.3 credential (unreadable here), a 0.3 config
        // without a 0.4 credential, or a 0.4 config for another server.
        assert_eq!(
            prior_enrollment(
                Some(here),
                full,
                Ok(Some(credential("https://old.example"))),
                &names
            ),
            Prior::Stale
        );
        assert_eq!(
            prior_enrollment(Some(here), None, Err(anyhow::anyhow!("0.3 format")), &names),
            Prior::Stale
        );
        assert_eq!(
            prior_enrollment(Some(here), None, Ok(None), &names),
            Prior::Stale
        );
        assert_eq!(
            prior_enrollment(Some("https://old.example"), full, Ok(None), &names),
            Prior::Stale
        );
    }

    #[test]
    fn only_an_explicit_lowering_keeps_a_login_relay_only() {
        // A 0.3 config has no trust: not a lowering.
        assert!(!keeps_relay_with(false, Prior::SameServer, None));
        assert!(!keeps_relay_with(false, Prior::Stale, None));
        // This server's node saved as relay stays relay; a fresh enrollment
        // takes the chosen trust.
        assert!(keeps_relay_with(
            false,
            Prior::SameServer,
            Some(TrustValue::Relay)
        ));
        assert!(!keeps_relay_with(
            false,
            Prior::Stale,
            Some(TrustValue::Relay)
        ));
        // A frozen copy is a person's lowering, whatever the server.
        for prior in [Prior::None, Prior::SameServer, Prior::Stale] {
            assert!(keeps_relay_with(true, prior, None));
        }
    }

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
