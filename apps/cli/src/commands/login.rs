//! `wsmp login` device-code login.

use std::io::{IsTerminal, Write};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::auth::{exchange_device_code, start_device_authorization};
use crate::config::Config;
use crate::output;
use crate::slug::validate_slug;
use crate::state::save_device_credential;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Human-readable name for the created device credential.
    #[arg(long, default_value = "CLI device")]
    name: String,
    /// CLI slug to register for this device.
    #[arg(long)]
    slug: Option<String>,
    /// Emit JSON instead of human-readable text.
    #[arg(long)]
    json: bool,
}

pub fn run(args: &Args) -> Result<()> {
    let mut cfg = Config::load_required()?;
    let server_url = cfg
        .server_url
        .clone()
        .context("server URL is not configured; run `wsmp config set-server <URL>`")?;
    let cli_slug = requested_cli_slug(args)?;
    let started = start_device_authorization(&server_url)?;
    let approval_url = approval_url(&started);
    if args.json {
        output::json(&LoginStarted {
            user_code: &started.user_code,
            verification_uri: started.verification_uri.as_deref(),
            verification_uri_complete: approval_url.as_deref(),
            expires_in: started.expires_in,
            interval: started.interval,
        })?;
    } else {
        output::line(format!("user code: {}", started.user_code))?;
        if let Some(url) = &approval_url {
            output::line(format!("open: {url}"))?;
        }
    }
    offer_browser_open(&started, approval_url.as_deref())?;

    let interval = Duration::from_secs(started.interval.unwrap_or(5).max(1));
    let expires_in = Duration::from_secs(started.expires_in.unwrap_or(600));
    let deadline = Instant::now() + expires_in;
    loop {
        if Instant::now() >= deadline {
            anyhow::bail!("device authorization expired");
        }
        thread::sleep(interval);
        match exchange_device_code(&server_url, &started.device_code, &args.name, &cli_slug) {
            Ok(credential) => {
                cfg.cli_slug = Some(cli_slug.clone());
                cfg.save()?;
                save_device_credential(&credential)?;
                if !args.json {
                    output::line("device login complete")?;
                }
                return Ok(());
            }
            Err(error) => {
                let message = error.to_string().to_lowercase();
                if message.contains("pending") || message.contains("polling too fast") {
                    tracing::debug!("device authorization pending");
                    continue;
                }
                if message.contains("denied") {
                    anyhow::bail!("device authorization denied");
                }
                if message.contains("expired") {
                    anyhow::bail!("device authorization expired");
                }
                return Err(error);
            }
        }
    }
}

fn requested_cli_slug(args: &Args) -> Result<String> {
    if let Some(slug) = &args.slug {
        validate_slug(slug).with_context(|| format!("validating CLI slug `{slug}`"))?;
        return Ok(slug.clone());
    }

    if !std::io::stdin().is_terminal() {
        anyhow::bail!("CLI slug is required in non-interactive mode; pass `--slug <slug>`");
    }

    loop {
        prompt("CLI slug: ")?;
        let mut value = String::new();
        let bytes = std::io::stdin()
            .read_line(&mut value)
            .context("reading CLI slug from stdin")?;
        if bytes == 0 {
            anyhow::bail!("CLI slug prompt reached end of input; pass `--slug <slug>`");
        }
        let slug = value.trim();
        match validate_slug(slug) {
            Ok(()) => return Ok(slug.to_string()),
            Err(error) => output::diagnostic(format!("invalid CLI slug: {error}"))?,
        }
    }
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
) -> Result<()> {
    let Some(url) = approval_url else {
        return Ok(());
    };
    if !interactive_terminal() {
        return Ok(());
    }

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

    match open_browser(url) {
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

#[cfg(target_os = "macos")]
fn open_browser(url: &str) -> Result<()> {
    run_opener(Command::new("open").arg(url))
}

#[cfg(target_os = "windows")]
fn open_browser(url: &str) -> Result<()> {
    run_opener(Command::new("cmd").args(["/C", "start", "", url]))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_browser(url: &str) -> Result<()> {
    run_opener(Command::new("xdg-open").arg(url))
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
    user_code: &'a str,
    verification_uri: Option<&'a str>,
    verification_uri_complete: Option<&'a str>,
    expires_in: Option<u64>,
    interval: Option<u64>,
}
