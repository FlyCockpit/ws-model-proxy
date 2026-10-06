//! `wsmp login` device-code login.

use std::io::{IsTerminal, Write};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::auth::{
    DeviceFlowState, ExchangeError, exchange_device_code, start_device_authorization,
};
use crate::config::Config;
use crate::hostname::hostname_slug;
use crate::output;
use crate::slug::validate_slug;
use crate::state::save_device_credential;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// CLI slug to register for this device. Defaults to the slug already in
    /// this config, else one derived from this machine's hostname. Name the
    /// device in the dashboard.
    #[arg(long)]
    slug: Option<String>,
    /// Emit JSON instead of human-readable text.
    #[arg(long)]
    json: bool,
}

pub fn run(args: &Args) -> Result<()> {
    let cfg = Config::load_required()?;
    let server_url = cfg
        .server_url
        .clone()
        .context("server URL is not configured; run `wsmp config set-server <URL>`")?;
    let cli_slug = requested_cli_slug(args, cfg.cli_slug.as_deref())?;
    // Captured once, before the device code exists, and sent on every poll.
    // Hello later presents the same identity public key and signs a server
    // nonce. Copying only `device-auth.json` cannot take over another machine.
    let state_dir = crate::paths::state_dir().context("determining the state directory")?;
    let identity = crate::terminal_identity::load_or_create(&state_dir)
        .context("loading the CLI identity key")?;
    let identity_public_key = identity.public_b64url();
    let started = start_device_authorization(&server_url, &cli_slug)?;
    let approval_url = approval_url(&started);
    if args.json {
        output::json(&LoginStarted {
            cli_slug: &cli_slug,
            user_code: &started.user_code,
            verification_uri: started.verification_uri.as_deref(),
            verification_uri_complete: approval_url.as_deref(),
            expires_in: started.expires_in,
            interval: started.interval,
        })?;
    } else {
        // The approval page shows this slug; they must match.
        output::line(format!("cli slug: {cli_slug}"))?;
        output::line(format!("user code: {}", started.user_code))?;
        if let Some(url) = &approval_url {
            output::line(format!("open: {url}"))?;
        }
    }
    offer_browser_open(&started, approval_url.as_deref(), &server_url)?;

    let mut interval = Duration::from_secs(started.interval.unwrap_or(5).max(1));
    let expires_in = Duration::from_secs(started.expires_in.unwrap_or(600));
    let deadline = Instant::now() + expires_in;
    loop {
        if Instant::now() >= deadline {
            anyhow::bail!("device authorization expired");
        }
        thread::sleep(interval);
        match exchange_device_code(
            &server_url,
            &started.device_code,
            &cli_slug,
            &identity_public_key,
        ) {
            Ok(credential) => {
                Config::update(true, |candidate| {
                    candidate.cli_slug = Some(cli_slug.clone());
                    Ok(())
                })?;
                save_device_credential(&credential)?;
                if !args.json {
                    output::line("device login complete")?;
                }
                return Ok(());
            }
            Err(ExchangeError::DeviceFlow(DeviceFlowState::Pending)) => {
                tracing::debug!("device authorization pending");
            }
            Err(ExchangeError::DeviceFlow(DeviceFlowState::SlowDown)) => {
                interval = slowed_down_interval(interval);
                tracing::debug!(?interval, "device authorization polling too fast");
            }
            Err(ExchangeError::DeviceFlow(DeviceFlowState::Denied)) => {
                anyhow::bail!("device authorization denied");
            }
            Err(ExchangeError::DeviceFlow(DeviceFlowState::Expired)) => {
                anyhow::bail!("device authorization expired");
            }
            Err(ExchangeError::Other(error)) => return Err(error),
        }
    }
}

/// Longest wait between polls. `slow_down` keeps adding to the interval, so an
/// unbounded interval could leave an approved login unnoticed for minutes.
const MAX_POLL_INTERVAL: Duration = Duration::from_secs(30);

/// RFC 8628 §3.5: add 5 seconds to the interval on `slow_down`, capped.
fn slowed_down_interval(interval: Duration) -> Duration {
    (interval + Duration::from_secs(5)).min(MAX_POLL_INTERVAL.max(interval))
}

fn requested_cli_slug(args: &Args, saved: Option<&str>) -> Result<String> {
    if let Some(slug) = &args.slug {
        validate_slug(slug).with_context(|| format!("validating CLI slug `{slug}`"))?;
        return Ok(slug.clone());
    }

    let default = default_slug(saved, hostname_slug);
    if !std::io::stdin().is_terminal() {
        return default.context(
            "no valid CLI slug is configured or can be derived from this machine's hostname; pass `--slug <slug>`",
        );
    }

    let text = match &default {
        Some(slug) => format!("CLI slug [{slug}]: "),
        None => "CLI slug: ".to_string(),
    };
    loop {
        prompt(&text)?;
        let mut value = String::new();
        let bytes = std::io::stdin()
            .read_line(&mut value)
            .context("reading CLI slug from stdin")?;
        if bytes == 0 {
            anyhow::bail!("CLI slug prompt reached end of input; pass `--slug <slug>`");
        }
        match chosen_slug(&value, default.as_deref()) {
            Ok(slug) => return Ok(slug),
            Err(error) => output::diagnostic(format!("invalid CLI slug: {error}"))?,
        }
    }
}

/// The slug offered when `--slug` is not given: the slug already saved in this
/// config (a re-login keeps the device's slug), else one derived from the
/// hostname. An invalid saved slug is skipped rather than offered.
fn default_slug(
    saved: Option<&str>,
    hostname_slug: impl FnOnce() -> Option<String>,
) -> Option<String> {
    saved
        .filter(|slug| validate_slug(slug).is_ok())
        .map(str::to_string)
        .or_else(hostname_slug)
}

/// A prompt answer: blank accepts the hostname default when there is one.
fn chosen_slug(answer: &str, default: Option<&str>) -> Result<String> {
    let slug = match (answer.trim(), default) {
        ("", Some(default)) => default,
        (typed, _) => typed,
    };
    validate_slug(slug)?;
    Ok(slug.to_string())
}

fn approval_url(started: &crate::auth::DeviceCodeStartResponse) -> Option<String> {
    started.verification_uri_complete.clone().or_else(|| {
        started.verification_uri.as_ref().map(|uri| {
            format!(
                "{}{}user_code={}",
                uri,
                if uri.contains('?') { "&" } else { "?" },
                started.user_code
            )
        })
    })
}

fn offer_browser_open(
    started: &crate::auth::DeviceCodeStartResponse,
    approval_url: Option<&str>,
    server_url: &str,
) -> Result<()> {
    let Some(url) = approval_url else {
        return Ok(());
    };
    if !interactive_terminal() {
        return Ok(());
    }
    // The approval URL comes from the server. Only a URL on the configured
    // server's origin reaches the OS opener; anything else is printed for the
    // person to judge.
    let checked = match browser_url(url, server_url) {
        Ok(checked) => checked,
        Err(error) => {
            output::diagnostic(format!(
                "not opening the browser: {error:#}; open {url} yourself and enter code {} to continue",
                started.user_code
            ))?;
            return Ok(());
        }
    };

    output::diagnostic("press Enter to open the verification URL in your browser")?;
    let mut ignored = String::new();
    let bytes = std::io::stdin()
        .read_line(&mut ignored)
        .context("reading browser-open confirmation from stdin")?;
    if bytes == 0 {
        output::diagnostic(format!(
            "open {url} and enter code {} to continue",
            started.user_code
        ))?;
        return Ok(());
    }

    match open_browser(&checked) {
        Ok(()) => Ok(()),
        Err(error) => {
            output::diagnostic(format!(
                "could not open browser: {error}; open {url} and enter code {} to continue",
                started.user_code
            ))?;
            Ok(())
        }
    }
}

fn interactive_terminal() -> bool {
    std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
}

fn prompt(text: &str) -> Result<()> {
    let mut err = std::io::stderr().lock();
    write!(err, "{text}").context("writing prompt to stderr")?;
    err.flush().context("flushing prompt to stderr")
}

/// Checks a server-supplied approval URL before any OS opener sees it.
///
/// It must be https (http only on a loopback host, for local development) and
/// on the configured server's origin, with no embedded credentials. The
/// returned URL is the parser's normalized form, so it holds no whitespace,
/// quotes or control characters.
fn browser_url(candidate: &str, server_url: &str) -> Result<url::Url> {
    let url = url::Url::parse(candidate).context("the approval URL is not a valid URL")?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback_host(&url) => {}
        "http" => anyhow::bail!("the approval URL uses http on a non-loopback host"),
        scheme => anyhow::bail!("the approval URL uses the unsupported scheme {scheme:?}"),
    }
    if !url.username().is_empty() || url.password().is_some() {
        anyhow::bail!("the approval URL carries credentials");
    }
    let server = url::Url::parse(server_url).context("the configured server URL is not valid")?;
    if url.origin() != server.origin() {
        anyhow::bail!(
            "the approval URL is not on the configured server {}",
            server.origin().ascii_serialization()
        );
    }
    // The parser percent-encodes these; refuse rather than rely on that.
    if url
        .as_str()
        .chars()
        .any(|ch| ch.is_whitespace() || ch.is_control() || ch == '"')
    {
        anyhow::bail!("the approval URL contains characters that cannot be passed safely");
    }
    Ok(url)
}

fn is_loopback_host(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

#[cfg(target_os = "macos")]
fn open_browser(url: &url::Url) -> Result<()> {
    run_opener(Command::new("open").arg(url.as_str()))
}

/// Windows opener arguments. `rundll32` hands the URL to the shell's URL
/// protocol handler without `cmd.exe`, so `&`, `|`, `^` and `%` in the URL
/// are never interpreted as shell syntax.
#[cfg(any(target_os = "windows", test))]
fn windows_opener_args(url: &url::Url) -> [&str; 2] {
    ["url.dll,FileProtocolHandler", url.as_str()]
}

#[cfg(target_os = "windows")]
fn open_browser(url: &url::Url) -> Result<()> {
    run_opener(Command::new("rundll32.exe").args(windows_opener_args(url)))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_browser(url: &url::Url) -> Result<()> {
    run_opener(Command::new("xdg-open").arg(url.as_str()))
}

fn run_opener(command: &mut Command) -> Result<()> {
    let status = command.status().context("starting browser opener")?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("browser opener exited with status {status}");
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginStarted<'a> {
    cli_slug: &'a str,
    user_code: &'a str,
    verification_uri: Option<&'a str>,
    verification_uri_complete: Option<&'a str>,
    expires_in: Option<u64>,
    interval: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_down_adds_five_seconds_up_to_the_cap() {
        assert_eq!(
            slowed_down_interval(Duration::from_secs(5)),
            Duration::from_secs(10)
        );
        let mut interval = Duration::from_secs(5);
        for _ in 0..20 {
            interval = slowed_down_interval(interval);
        }
        assert_eq!(interval, MAX_POLL_INTERVAL);
        // A server-requested interval above the cap is never shortened.
        assert_eq!(
            slowed_down_interval(Duration::from_secs(45)),
            Duration::from_secs(45)
        );
    }

    #[test]
    fn blank_answer_accepts_the_hostname_default() {
        assert_eq!(chosen_slug("\n", Some("desk-01")).unwrap(), "desk-01");
    }

    #[test]
    fn typed_answer_wins_and_is_validated() {
        assert_eq!(
            chosen_slug(" laptop \n", Some("desk-01")).unwrap(),
            "laptop"
        );
        assert!(chosen_slug("Not A Slug\n", Some("desk-01")).is_err());
    }

    #[test]
    fn saved_slug_wins_over_the_hostname_slug() {
        assert_eq!(
            default_slug(Some("saved-cli"), || Some("desk-01".into())).as_deref(),
            Some("saved-cli")
        );
    }

    #[test]
    fn hostname_slug_is_the_default_without_a_valid_saved_slug() {
        assert_eq!(
            default_slug(None, || Some("desk-01".into())).as_deref(),
            Some("desk-01")
        );
        assert_eq!(
            default_slug(Some("Not A Slug"), || Some("desk-01".into())).as_deref(),
            Some("desk-01")
        );
        assert_eq!(default_slug(None, || None), None);
    }

    #[test]
    fn blank_answer_without_a_default_is_invalid() {
        assert!(chosen_slug("\n", None).is_err());
    }

    const SERVER: &str = "https://wsmp.example.com";

    #[test]
    fn approval_url_on_the_configured_https_origin_opens() {
        let url = browser_url(
            "https://wsmp.example.com/device?user_code=ABCD-EFGH&x=1",
            "https://wsmp.example.com/",
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://wsmp.example.com/device?user_code=ABCD-EFGH&x=1"
        );
    }

    #[test]
    fn http_approval_url_opens_only_on_loopback() {
        for (candidate, server) in [
            ("http://localhost:3000/device", "http://localhost:3000"),
            ("http://127.0.0.1:3000/device", "http://127.0.0.1:3000"),
            ("http://[::1]:3000/device", "http://[::1]:3000"),
        ] {
            assert!(browser_url(candidate, server).is_ok(), "{candidate}");
        }
        let error = browser_url("http://wsmp.lan:3000/device", "http://wsmp.lan:3000")
            .unwrap_err()
            .to_string();
        assert!(error.contains("non-loopback"), "{error}");
    }

    #[test]
    fn approval_url_with_another_scheme_is_refused() {
        for candidate in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-settings:",
            "ftp://wsmp.example.com/device",
            r"\\evil\share\x.exe",
            "calc.exe",
            "",
        ] {
            assert!(browser_url(candidate, SERVER).is_err(), "{candidate:?}");
        }
    }

    #[test]
    fn approval_url_off_the_configured_origin_is_refused() {
        for candidate in [
            "https://evil.example.com/device",
            "https://wsmp.example.com:8443/device",
            "https://wsmp.example.com.evil.example/device",
            format!("https://{}:{}@wsmp.example.com/device", "user", "pass").as_str(),
            "https://wsmp.example.com@evil.example/device",
        ] {
            assert!(browser_url(candidate, SERVER).is_err(), "{candidate}");
        }
        // Same host, but the configured server is plain http.
        assert!(browser_url("https://localhost/device", "http://localhost").is_err());
    }

    #[test]
    fn shell_metacharacters_reach_the_windows_opener_as_one_plain_argument() {
        // Under the old `cmd /C start`, `&` ended the command and ran the rest.
        let url = browser_url(
            "https://wsmp.example.com/device?user_code=AB&calc.exe|whoami^%PATH%\"\t x",
            SERVER,
        )
        .unwrap();
        let [handler, arg] = windows_opener_args(&url);
        assert_eq!(handler, "url.dll,FileProtocolHandler");
        assert!(arg.starts_with("https://wsmp.example.com/device?user_code=AB&calc.exe"));
        assert!(!arg.chars().any(|ch| ch.is_whitespace() || ch == '"'));
    }
}
