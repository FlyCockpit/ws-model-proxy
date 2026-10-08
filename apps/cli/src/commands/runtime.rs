//! `wsmp runtime list|test`: the runtimes and instances this node holds,
//! read from its own files (the frozen copy at Relay only), and a quick
//! request to one of them. Both are read only and work at either trust.
//! Runtimes are defined in the web app or through MCP.

use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::config::{Config, EndpointConfig};
use crate::display_escape::escape_single_line;
use crate::exit::{CodedError, ExitCode};
use crate::output;
use crate::protocol::runtime_spec::{RuntimeKind, RuntimeSpec};
use crate::runtimes::endpoints::endpoint_for;
use crate::runtimes::local::{self, InstanceRow, LocalView, RuntimeRow, word};

const TEST_TIMEOUT: Duration = Duration::from_secs(10);
/// A model list larger than this is not counted.
const MODELS_BODY_LIMIT: u64 = 1024 * 1024;

#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(subcommand)]
    command: Sub,
}

#[derive(Debug, clap::Subcommand)]
enum Sub {
    /// List the runtimes and instances this node holds, with phase, ports,
    /// units and, for stopping or stopped ranks, the stop proof.
    List {
        /// Emit JSON instead of human-readable text.
        #[arg(long)]
        json: bool,
    },
    /// Send one small request to a runtime on this node and report its
    /// status and latency: the readiness route of a running instance, else
    /// its model list (or a TCP connect for a service without readiness).
    Test {
        /// A runtime slug, an instance handle (`i-...`) or an instance id.
        target: String,
        /// Emit JSON instead of human-readable text.
        #[arg(long)]
        json: bool,
    },
}

pub fn run(args: &Args) -> Result<()> {
    match &args.command {
        Sub::List { json } => list(*json),
        Sub::Test { target, json } => test(target, *json),
    }
}

fn list(json: bool) -> Result<()> {
    let config = Config::load()?;
    let view = local::load(&config, true);
    if json {
        return output::json(&view);
    }
    for line in format_list(&view) {
        output::line(line)?;
    }
    Ok(())
}

fn format_list(view: &LocalView) -> Vec<String> {
    let mut lines = vec![format!(
        "trust: {} ({} definitions){}",
        crate::trust::word(view.trust),
        view.definitions,
        view.port_range
            .map(|[low, high]| format!(", ports {low}-{high}"))
            .unwrap_or_default()
    )];
    if view.runtimes.is_empty() {
        lines.push("runtimes: none".to_string());
    } else {
        lines.push("runtimes:".to_string());
        lines.extend(view.runtimes.iter().map(runtime_line));
    }
    if view.instances.is_empty() {
        lines.push("instances: none".to_string());
    } else {
        lines.push("instances:".to_string());
        lines.extend(view.instances.iter().map(instance_line));
    }
    for warning in &view.warnings {
        lines.push(format!("warning: {}", escape_single_line(warning)));
    }
    lines
}

fn runtime_line(row: &RuntimeRow) -> String {
    let mut parts = vec![
        format!("  {}", escape_single_line(&row.slug)),
        word(&row.kind),
    ];
    if row.unreadable {
        parts.push("(unreadable definition)".to_string());
    }
    let shape: Vec<String> = [
        row.engine.as_ref().map(word),
        row.api.as_ref().map(word),
        row.model_type.as_ref().map(word),
        row.management.as_ref().map(word),
    ]
    .into_iter()
    .flatten()
    .collect();
    if !shape.is_empty() {
        parts.push(shape.join("/"));
    }
    if let Some(base_url) = &row.base_url {
        parts.push(escape_single_line(base_url));
    }
    parts.push(format!(
        "version {}{}",
        escape_single_line(&row.version_id),
        if row.held_versions > 1 {
            format!(" ({} held)", row.held_versions)
        } else {
            String::new()
        }
    ));
    if !row.models.is_empty() {
        parts.push(format!("models: {}", models_text(&row.models)));
    }
    parts.join("  ")
}

fn instance_line(row: &InstanceRow) -> String {
    let mut parts = vec![
        format!("  {} r{}", escape_single_line(&row.handle), row.rank),
        row.runtime
            .as_deref()
            .map_or_else(|| "(runtime not held)".to_string(), escape_single_line),
        word(&row.phase),
    ];
    if let Some(pending) = &row.pending {
        parts.push(format!("pending {}", word(pending)));
    }
    parts.push(format!(
        "port {}{}",
        row.port,
        row.dist_port
            .map(|port| format!("+{port}"))
            .unwrap_or_default()
    ));
    parts.push(format!("unit {}", escape_single_line(&row.unit)));
    let extra: Vec<&String> = row.units.iter().filter(|unit| **unit != row.unit).collect();
    if !extra.is_empty() {
        parts.push(format!(
            "also {}",
            extra
                .iter()
                .map(|unit| escape_single_line(unit))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if let Some(proof) = &row.stop_proof {
        parts.push(format!("stop proof: {proof}"));
    }
    parts.join("  ")
}

/// At most three model ids, then a count.
pub(crate) fn models_text(models: &[String]) -> String {
    let shown: Vec<String> = models
        .iter()
        .take(3)
        .map(|model| escape_single_line(model))
        .collect();
    if models.len() > 3 {
        format!("{} (+{} more)", shown.join(", "), models.len() - 3)
    } else {
        shown.join(", ")
    }
}

// ── test ──

/// What one target is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Probe {
    /// `GET`, ok on exactly this status.
    Readiness { url: String, expected: u16 },
    /// `GET` the model list, ok on 2xx.
    Models { url: String },
    /// A TCP connect.
    Connect { host: String, port: u16 },
}

struct Target {
    /// The runtime slug or instance handle, as printed.
    name: String,
    endpoint: EndpointConfig,
    probe: Probe,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestResult {
    target: String,
    request: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_status: Option<u16>,
    latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    models: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn test(target: &str, json: bool) -> Result<()> {
    let config = Config::load()?;
    let view = local::load(&config, false);
    let store = crate::runtime_store::load_for(view.trust).unwrap_or_default();
    let targets = resolve(target, &view, &store)?;
    let results: Vec<TestResult> = targets.iter().map(run_probe).collect();
    if json {
        output::json(&results)?;
    } else {
        for result in &results {
            output::line(result_line(result))?;
        }
    }
    anyhow::ensure!(
        results.iter().all(|result| result.ok),
        "`{}` did not answer as expected",
        escape_single_line(target)
    );
    Ok(())
}

fn not_found(message: String) -> anyhow::Error {
    anyhow::Error::msg(message).context(CodedError::new(ExitCode::NotFound))
}

/// An instance handle or id (rank 0, the one that serves), else a runtime
/// slug: an always-on runtime's address, or every running rank 0 of a
/// startable one.
fn resolve(
    target: &str,
    view: &LocalView,
    store: &crate::runtime_store::Store,
) -> Result<Vec<Target>> {
    let executors = crate::runtimes::executor::instances_dir()
        .map(|dir| crate::runtimes::executor::read_all(&dir).0)
        .unwrap_or_default();
    let jobs: Vec<crate::runtimes::executor::Job> = executors
        .iter()
        .flat_map(|executor| executor.ranks())
        .filter(|rank| rank.job.rank == 0)
        .map(|rank| rank.job)
        .collect();
    let by_instance: Vec<_> = jobs
        .iter()
        .filter(|job| job.handle == target || job.instance_id == target)
        .collect();
    if let Some(job) = by_instance.first() {
        return Ok(vec![instance_target(job)?]);
    }
    let Some(runtime) = view.runtimes.iter().find(|row| row.slug == target) else {
        return Err(not_found(format!(
            "no runtime or instance `{}` on this node (see `wsmp runtime list`)",
            escape_single_line(target)
        )));
    };
    if runtime.kind == RuntimeKind::AlwaysOn {
        let held = store
            .held
            .iter()
            .rev()
            .find(|held| held.runtime_id == runtime.runtime_id)
            .context("the runtime is no longer held")?;
        let spec = held.parsed()?;
        let base_url = spec
            .address
            .as_ref()
            .map(|address| address.base_url.clone())
            .context("the always-on runtime has no address")?;
        let endpoint = endpoint_for(&held.slug, &spec, base_url.clone());
        return Ok(vec![Target {
            name: held.slug.clone(),
            endpoint,
            probe: Probe::Models {
                url: safe_models_url(&base_url)?,
            },
        }]);
    }
    let running: Vec<_> = view
        .instances
        .iter()
        .filter(|row| {
            row.runtime_id == runtime.runtime_id
                && row.rank == 0
                && matches!(
                    row.phase,
                    crate::protocol::frames::InstancePhase::Starting
                        | crate::protocol::frames::InstancePhase::Ready
                        | crate::protocol::frames::InstancePhase::Unhealthy
                )
        })
        .collect();
    if running.is_empty() {
        return Err(not_found(format!(
            "no instance of `{}` runs on this node",
            escape_single_line(target)
        )));
    }
    let targets: Vec<Target> = running
        .into_iter()
        .filter_map(|row| {
            jobs.iter()
                .find(|job| job.instance_id == row.instance_id)
                .map(instance_target)
        })
        .collect::<Result<_>>()?;
    if targets.is_empty() {
        return Err(not_found(format!(
            "no instance of `{}` runs on this node",
            escape_single_line(target)
        )));
    }
    Ok(targets)
}

/// The model-list URL, with an error that prints the (server-supplied) base
/// URL escaped.
fn safe_models_url(base_url: &str) -> Result<String> {
    crate::probe::models_url(base_url)
        .map(|url| url.to_string())
        .map_err(|_| {
            anyhow::anyhow!(
                "the runtime's address `{}` is not a usable URL",
                escape_single_line(base_url)
            )
        })
}

fn instance_target(job: &crate::runtimes::executor::Job) -> Result<Target> {
    let spec: RuntimeSpec = job
        .parsed_spec()
        .context("the instance's definition cannot be read")?;
    let base_url = job.base_url();
    let probe = probe_for(&spec, &base_url, &job.host, job.port)?;
    Ok(Target {
        name: job.handle.clone(),
        endpoint: endpoint_for(&job.handle, &spec, base_url),
        probe,
    })
}

fn probe_for(spec: &RuntimeSpec, base_url: &str, host: &str, port: u16) -> Result<Probe> {
    if let Some(readiness) = spec
        .launch
        .as_ref()
        .and_then(|launch| launch.readiness.as_ref())
    {
        return Ok(Probe::Readiness {
            url: format!("{base_url}{}", readiness.path),
            expected: readiness.expected_status,
        });
    }
    if spec.serves() {
        return Ok(Probe::Models {
            url: safe_models_url(base_url)?,
        });
    }
    Ok(Probe::Connect {
        host: host.to_string(),
        port,
    })
}

fn run_probe(target: &Target) -> TestResult {
    let started = Instant::now();
    let elapsed =
        |started: Instant| u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let mut result = TestResult {
        target: target.name.clone(),
        request: String::new(),
        ok: false,
        status: None,
        expected_status: None,
        latency_ms: 0,
        models: None,
        error: None,
    };
    match &target.probe {
        Probe::Connect { host, port } => {
            result.request = format!("connect {host}:{port}");
            let address = host
                .parse::<std::net::IpAddr>()
                .map(|ip| std::net::SocketAddr::new(ip, *port));
            match address {
                Ok(address) => match std::net::TcpStream::connect_timeout(&address, TEST_TIMEOUT) {
                    Ok(_) => result.ok = true,
                    Err(error) => result.error = Some(error.to_string()),
                },
                Err(error) => result.error = Some(format!("host `{host}`: {error}")),
            }
            result.latency_ms = elapsed(started);
        }
        Probe::Readiness { url, .. } | Probe::Models { url } => {
            result.request = format!("GET {url}");
            let agent: ureq::Agent = ureq::Agent::config_builder()
                .timeout_global(Some(TEST_TIMEOUT))
                .http_status_as_error(false)
                .max_redirects(0)
                .build()
                .into();
            let request = agent.get(url.as_str()).header("Accept", "application/json");
            let sent = crate::probe::with_endpoint_auth(request, &target.endpoint)
                .and_then(|request| request.call().context("sending the request"));
            result.latency_ms = elapsed(started);
            match sent {
                Ok(mut response) => {
                    let status = response.status().as_u16();
                    result.status = Some(status);
                    match &target.probe {
                        Probe::Readiness { expected, .. } => {
                            result.expected_status = Some(*expected);
                            result.ok = status == *expected;
                        }
                        _ => {
                            result.ok = (200..300).contains(&status);
                            if result.ok {
                                result.models = response
                                    .body_mut()
                                    .with_config()
                                    .limit(MODELS_BODY_LIMIT)
                                    .read_json::<serde_json::Value>()
                                    .ok()
                                    .and_then(|body| {
                                        body.get("data")
                                            .and_then(serde_json::Value::as_array)
                                            .map(Vec::len)
                                    });
                            }
                        }
                    }
                }
                Err(error) => result.error = Some(format!("{error:#}")),
            }
        }
    }
    result
}

fn result_line(result: &TestResult) -> String {
    let mut line = format!(
        "{}: {}  {}",
        escape_single_line(&result.target),
        escape_single_line(&result.request),
        if result.ok { "ok" } else { "FAILED" }
    );
    if let Some(status) = result.status {
        line.push_str(&format!("  status {status}"));
        if let Some(expected) = result.expected_status
            && expected != status
        {
            line.push_str(&format!(" (expected {expected})"));
        }
    }
    line.push_str(&format!("  {} ms", result.latency_ms));
    if let Some(models) = result.models {
        line.push_str(&format!(
            "  {models} model{}",
            if models == 1 { "" } else { "s" }
        ));
    }
    if let Some(error) = &result.error {
        line.push_str(&format!("  error: {}", escape_single_line(error)));
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(value: serde_json::Value) -> RuntimeSpec {
        serde_json::from_value(value).expect("spec")
    }

    #[test]
    fn the_probe_prefers_readiness_then_models_then_a_connect() {
        let served = spec(serde_json::json!({
            "api": "openai", "engine": "ollama", "modelType": "llm",
            "models": [{ "id": "m" }],
            "address": { "baseUrl": "http://127.0.0.1:11434" },
        }));
        assert_eq!(
            probe_for(&served, "http://127.0.0.1:11434", "127.0.0.1", 11434).unwrap(),
            Probe::Models {
                url: "http://127.0.0.1:11434/v1/models".into()
            }
        );
        let mut startable = served.clone();
        startable.address = None;
        startable.launch = Some(
            serde_json::from_value(serde_json::json!({
                "management": "process", "groupSize": 1, "resources": [], "labels": [],
                "commands": [],
                "readiness": { "path": "/health", "expectedStatus": 200, "timeoutMs": 1000 },
                "health": { "intervalMs": 1000, "failureThreshold": 3, "successThreshold": 1 },
            }))
            .expect("launch"),
        );
        assert_eq!(
            probe_for(&startable, "http://127.0.0.1:20001", "127.0.0.1", 20001).unwrap(),
            Probe::Readiness {
                url: "http://127.0.0.1:20001/health".into(),
                expected: 200
            }
        );
        let mut service = startable.clone();
        service.api = None;
        service.engine = None;
        service.model_type = None;
        service.models = None;
        if let Some(launch) = service.launch.as_mut() {
            launch.readiness = None;
        }
        assert_eq!(
            probe_for(&service, "http://127.0.0.1:20002", "127.0.0.1", 20002).unwrap(),
            Probe::Connect {
                host: "127.0.0.1".into(),
                port: 20002
            }
        );
    }

    #[test]
    fn a_test_line_says_what_was_asked_and_how_it_went() {
        let result = TestResult {
            target: "i-abc".into(),
            request: "GET http://127.0.0.1:20001/health".into(),
            ok: false,
            status: Some(503),
            expected_status: Some(200),
            latency_ms: 12,
            models: None,
            error: None,
        };
        assert_eq!(
            result_line(&result),
            "i-abc: GET http://127.0.0.1:20001/health  FAILED  status 503 (expected 200)  12 ms"
        );
    }

    #[test]
    fn long_model_lists_are_cut_to_three() {
        let models: Vec<String> = ["a", "b", "c", "d", "e"].map(String::from).to_vec();
        assert_eq!(models_text(&models), "a, b, c (+2 more)");
        assert_eq!(models_text(&models[..2]), "a, b");
    }
}
