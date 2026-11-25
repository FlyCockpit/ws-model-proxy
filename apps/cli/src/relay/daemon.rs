//! Foreground websocket relay daemon (relay protocol 4.0).
//!
//! Request bodies are streamed to the upstream endpoint as they arrive over the
//! websocket instead of being fully buffered first. Each relayed request runs on
//! its own worker thread so a slow upstream cannot stall sibling requests
//! multiplexed on the shared socket. The single websocket writer stays on the
//! main loop: workers hand outbound frames back through a channel that the main
//! loop drains, and the server paces request-body frames with credit-based flow
//! control (`relay.request.body.ack`).
//!
//! Runtime handles resolve only through held definitions
//! (`crate::node::runtime_store`) and the node's instance records. Trust is the
//! node's own (`crate::node::trust`): lowered by `trust.lower`, `wsmp trust relay`
//! or a hand edit (hot reload), raised only by `wsmp trust full`.
//!
//! `runtime.detect` scans loopback ports off this loop
//! (`crate::services::runtimes::detect`).

mod backoff;
mod connection;
mod dispatch;
mod handshake;
mod link;
mod local;
mod node_runtimes;
mod request_body;
mod requests;
mod runtime_jobs;
mod session;
mod upstream_worker;
mod usage;
mod wire;

use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tungstenite::http::HeaderValue;

use crate::node::auth::CredentialPairing;
use crate::node::config::Config;
use crate::process::control::ControlServer;
use crate::relay::startup::TerminalStartup;

use backoff::{AttemptEnd, ConnectProgress, ReconnectBackoff, retry_floor};
use connection::run_relay_session;
use handshake::{stop_on_unusable_credential, websocket_url};
use link::NodeLink;
use local::{ConfigWatch, local_changes, take_lowering};
use wire::RelaySessionError;

/// Stop the relay after a shutdown signal. `main` maps this to the signal's
/// exit status.
fn check_shutdown() -> Result<()> {
    match crate::process::shutdown::requested() {
        Some(signal) => Err(crate::process::shutdown::ShutdownRequested { signal }.into()),
        None => Ok(()),
    }
}

pub fn connect_foreground() -> Result<()> {
    // First, so a stop that lands during startup still unwinds cleanly.
    crate::process::shutdown::install()?;
    // Orphans of commands re-parent to the relay (Linux), so `trust` still
    // finds it above them; see `subreaper`.
    crate::process::subreaper::start();
    // Windows: before anything is started, so all of it is in the job that
    // `trust::started_by_wsmp` asks.
    crate::node::trust::join_relay_job();
    let mut config = Config::load_required()?;
    config.validate()?;
    let mut control = ControlServer::bind()?;
    let startup = TerminalStartup::capture(&config)?;
    #[cfg(unix)]
    crate::services::file_ops::report_abandoned_recovery();
    // A new build that keeps failing to confirm rolls itself back here (exit 75).
    let updates = crate::relay::update::agent::DaemonUpdate::start()?;
    let mut link = NodeLink::new(
        &crate::node::runtime_store::load_for(startup.trust_value()).unwrap_or_default(),
        updates,
        startup.trust_snapshot().lowerings,
    )?;
    let mut backoff = ReconnectBackoff::new();
    let mut credential_pairing = CredentialPairing::default();
    loop {
        check_shutdown()?;
        let node_slug = config.ensure_cli_slug()?;
        let mut progress = ConnectProgress::Connecting;
        let wait = match credential_pairing.resolve_credential(
            config.server_url.as_deref(),
            config.public_origin.as_deref(),
        ) {
            // Definitely no credential: stop only where nothing restarts us in
            // a loop (see `stop_on_unusable_credential`).
            Err(error)
                if crate::node::auth::is_missing_credential(&error)
                    && stop_on_unusable_credential() =>
            {
                return Err(error.context(crate::exit::CodedError::new(
                    crate::exit::ExitCode::CredentialRejected,
                )));
            }
            Err(error) => {
                let wait = backoff.next_wait(AttemptEnd::Retry, progress, Instant::now());
                tracing::warn!(
                    error = %format!("{error:#}"),
                    retry_delay_secs = wait.as_secs(),
                    "relay credential unavailable; retrying"
                );
                wait
            }
            Ok(secret) => {
                let server_url = config
                    .server_url
                    .clone()
                    .context("this node is not enrolled; run `wsmp login <url> --code <code>`")?;
                let ws_url = websocket_url(&server_url)?;
                let auth_value = HeaderValue::from_str(&format!("Bearer {secret}"))
                    .context("building websocket authorization header")?;

                tracing::info!(url = %ws_url, "connecting relay websocket");
                let result = run_relay_session(
                    &config,
                    &startup,
                    &node_slug,
                    &ws_url,
                    auth_value,
                    &mut control,
                    &mut link,
                    &mut progress,
                );
                let now = Instant::now();
                match result {
                    Ok(()) => {
                        let wait = backoff.next_wait(AttemptEnd::Retry, progress, now);
                        tracing::warn!(
                            retry_delay_secs = wait.as_secs(),
                            "relay websocket session ended; reconnecting after backoff"
                        );
                        wait
                    }
                    Err(RelaySessionError::Reconnectable { error }) => {
                        let floor = retry_floor(&error);
                        let wait =
                            backoff.next_wait(AttemptEnd::Reconnectable { floor }, progress, now);
                        tracing::warn!(
                            error = %format!("{error:#}"),
                            retry_delay_secs = wait.as_secs(),
                            "relay websocket disconnected; reconnecting after backoff"
                        );
                        wait
                    }
                    // Only a stop code (a rejected credential, a refused protocol)
                    // ends the process: the service does not restart it after those.
                    // Anything else fatal to the session (a frame it cannot read, a
                    // broken server) reconnects in this process, slower each time,
                    // instead of exiting into a tight service restart loop.
                    Err(RelaySessionError::Fatal(error))
                        if crate::exit::code_for(&error) != crate::exit::ExitCode::Failure =>
                    {
                        return Err(error);
                    }
                    Err(RelaySessionError::Fatal(error)) => {
                        let wait = backoff.next_wait(AttemptEnd::Fatal, progress, now);
                        tracing::error!(
                            error = %format!("{error:#}"),
                            retry_delay_secs = wait.as_secs(),
                            "relay session failed; reconnecting after backoff"
                        );
                        wait
                    }
                    Err(RelaySessionError::Shutdown(signal)) => {
                        tracing::info!(signal, "relay stopped cleanly after a shutdown signal");
                        return Err(crate::process::shutdown::ShutdownRequested { signal }.into());
                    }
                    Err(RelaySessionError::RestartForUpdate) => {
                        tracing::info!("restarting into the installed update");
                        return Err(anyhow::anyhow!("restarting into the installed update")
                            .context(crate::exit::CodedError::new(
                                crate::exit::ExitCode::RestartForUpdate,
                            )));
                    }
                }
            }
        };
        wait_for_reconnect(&mut control, &startup, &node_slug, wait, &mut link)?;
        // Every retry re-reads the config, a credential retry included: a
        // `wsmp login` meanwhile changes the server URL and node slug, and
        // endpoint edits apply on reconnect.
        match Config::load_required().and_then(|fresh| fresh.validate().map(|()| fresh)) {
            Ok(fresh) => config = fresh,
            Err(error) => tracing::warn!(
                error = %format!("{error:#}"),
                "re-reading the config failed; keeping the previous one"
            ),
        }
    }
}

fn wait_for_reconnect(
    control: &mut ControlServer,
    startup: &TerminalStartup,
    node_slug: &str,
    delay: Duration,
    link: &mut NodeLink,
) -> Result<()> {
    let deadline = Instant::now() + delay;
    let mut watch = ConfigWatch::new();
    while Instant::now() < deadline {
        check_shutdown()?;
        link.drain_offline();
        // An update that finished installing while disconnected restarts now,
        // not on the next connection: its rollback deadline is already running.
        // (Offline, its progress frames stay queued; the new build reports.)
        let (_, restart) = link.update.poll(startup.full_control());
        if restart {
            tracing::info!("restarting into the installed update");
            return Err(
                anyhow::anyhow!("restarting into the installed update").context(
                    crate::exit::CodedError::new(crate::exit::ExitCode::RestartForUpdate),
                ),
            );
        }
        // Trust and features changed while disconnected reach the next hello;
        // only the commands outlive the connection, so a lowering here ends
        // them (the next session starts with no terminal or file op).
        let _ = local_changes(control, startup, node_slug, "reconnecting", &mut watch)?;
        if take_lowering(&mut link.lowerings_applied, startup) {
            let interrupted = link.execs.interrupt_all();
            link.deferred.extend(interrupted);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        thread::sleep(remaining.min(Duration::from_millis(100)));
    }
    Ok(())
}
