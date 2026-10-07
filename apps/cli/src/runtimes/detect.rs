//! `runtime.detect`: find OpenAI-compatible model servers already running on
//! this node (vLLM, SGLang, llama.cpp, Ollama, LM Studio, TGI, OpenAI-style
//! speech servers) so a person can add them as always-on runtimes.
//!
//! Safety: only loopback addresses (`127.0.0.1`, `[::1]`) are probed, by
//! literal IP (no DNS), with a dedicated HTTP agent that has no proxy, no
//! redirects, strict timeouts and no credentials or configured headers. At
//! most [`CANDIDATE_PORTS_MAX`] ports are tried, every body is read under
//! [`crate::engine::JSON_BODY_LIMIT`] (or the metrics limit), and the whole
//! scan stops at [`SCAN_BUDGET`]. Nothing but model ids, the engine kind and
//! its version leaves the node, each held to the frame contract's bounds.
//!
//! Candidates are a fixed list of well-known engine ports plus (Linux) the
//! TCP ports this machine listens on at loopback or a wildcard address, read
//! from `/proc/net/tcp{,6}`. Ports held by this node's managed instances are
//! skipped: those are runtimes already, not discoveries.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::engine::{self, EngineKind, JSON_BODY_LIMIT};
use crate::protocol::frames::{DetectedServer, NodeFrame};
use crate::protocol::runtime_spec::{Engine, RuntimeApi};
use crate::relay_bus::FromWorker;

/// Most servers one `runtime.detected` carries (frame contract).
pub const DETECTED_SERVERS_MAX: usize = 16;
/// Most model ids per server (frame contract).
pub const DETECTED_MODELS_MAX: usize = 64;
/// Longest model id (frame contract: 256 UTF-16 units; bytes bound it).
const MODEL_ID_MAX_BYTES: usize = 256;
/// Longest version text (frame contract: 80 after trimming).
const VERSION_MAX_BYTES: usize = 80;
/// Most ports one scan probes.
pub const CANDIDATE_PORTS_MAX: usize = 64;
/// Loopback connect check per port and address.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Each HTTP request, end to end.
const REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);
/// No port starts probing after this much of a scan has passed.
pub const SCAN_BUDGET: Duration = Duration::from_secs(10);
/// Ports probed at once.
const SCAN_WORKERS: usize = 8;

/// Engine defaults and common alternates, most likely first.
pub const WELL_KNOWN_PORTS: &[u16] = &[
    8000,  // vLLM, speaches / faster-whisper-server
    30000, // SGLang
    8080,  // llama.cpp server, TGI (container), LocalAI
    11434, // Ollama
    1234,  // LM Studio
    3000,  // TGI (launcher default)
    8001, 8002, 8003, 8081, 8082, 5000, 5001, 8008, 8010, 8888, 9000, 30001,
];

/// Ports that are never an HTTP model server (databases, brokers, the
/// common dev servers that answer anything): not probed even when listening.
const NEVER_PROBED: &[u16] = &[
    1433, 1521, 2375, 2376, 2379, 2380, 3306, 4369, 5432, 5672, 5900, 6379, 6443, 9042, 9092, 9200,
    9300, 11211, 15672, 25672, 27017, 27018, 27019, 50051,
];

/// The address family a port listens on at loopback (or a wildcard).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Listening {
    pub v4: bool,
    pub v6: bool,
}

/// One scan's answer for one port.
#[derive(Debug, Clone, PartialEq)]
pub struct Probed {
    pub engine: Engine,
    pub models: Vec<String>,
    pub version: Option<String>,
}

static SCANNING: AtomicBool = AtomicBool::new(false);

/// Answer `runtime.detect` off the relay loop. A request that arrives while a
/// scan runs is folded into it: that scan's answer is the fresh one.
pub(crate) fn spawn(tx: SyncSender<FromWorker>, id: String, skip_ports: BTreeSet<u16>) {
    if SCANNING.swap(true, Ordering::AcqRel) {
        tracing::debug!(id, "a detection scan is already running");
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("wsmp-detect".into())
        .spawn(move || {
            let servers = scan(&skip_ports);
            SCANNING.store(false, Ordering::Release);
            let frame = NodeFrame::RuntimeDetected {
                id: Some(id),
                scanned_at: crate::telemetry::now_rfc3339(),
                servers,
            };
            match crate::protocol::encode_control(&frame) {
                Ok(text) => {
                    let _ = tx.send(FromWorker::Telemetry(text));
                }
                Err(error) => tracing::warn!(
                    error = %format!("{error:#}"),
                    "encoding the detection answer failed"
                ),
            }
        });
    if let Err(error) = spawned {
        SCANNING.store(false, Ordering::Release);
        tracing::warn!(error = %error, "starting the detection worker failed");
    }
}

/// Scan this machine's loopback ports now.
pub fn scan(skip_ports: &BTreeSet<u16>) -> Vec<DetectedServer> {
    let listening = listening_ports();
    let candidates = candidate_ports(WELL_KNOWN_PORTS, &listening, skip_ports);
    let deadline = Instant::now() + SCAN_BUDGET;
    let queue = Arc::new(Mutex::new(candidates.clone().into_iter()));
    let found = Arc::new(Mutex::new(BTreeMap::<u16, DetectedServer>::new()));
    std::thread::scope(|scope| {
        for _ in 0..SCAN_WORKERS {
            let queue = Arc::clone(&queue);
            let found = Arc::clone(&found);
            let listening = &listening;
            scope.spawn(move || {
                loop {
                    if Instant::now() >= deadline {
                        return;
                    }
                    let next = queue.lock().ok().and_then(|mut queue| queue.next());
                    let Some(port) = next else { return };
                    if let Some(server) = probe_port(port, listening.get(&port).copied())
                        && let Ok(mut found) = found.lock()
                    {
                        found.insert(port, server);
                    }
                }
            });
        }
    });
    let found = found.lock().map(|found| found.clone()).unwrap_or_default();
    // Report in candidate order (well-known first), within the frame bound.
    candidates
        .iter()
        .filter_map(|port| found.get(port).cloned())
        .take(DETECTED_SERVERS_MAX)
        .collect()
}

/// Well-known ports first, then other listening ports in order, without the
/// skipped and never-probed ones, at most [`CANDIDATE_PORTS_MAX`].
pub fn candidate_ports(
    well_known: &[u16],
    listening: &BTreeMap<u16, Listening>,
    skip_ports: &BTreeSet<u16>,
) -> Vec<u16> {
    let mut seen = BTreeSet::new();
    well_known
        .iter()
        .copied()
        .chain(listening.keys().copied().filter(|port| *port >= 1024))
        .filter(|port| *port != 0 && !skip_ports.contains(port) && !NEVER_PROBED.contains(port))
        .filter(|port| seen.insert(*port))
        .take(CANDIDATE_PORTS_MAX)
        .collect()
}

/// The loopback address a port answers on: the family `/proc` reports, else
/// IPv4 then IPv6 by a short connect.
fn reachable(port: u16, listening: Option<Listening>) -> Option<IpAddr> {
    let v4 = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let v6 = IpAddr::V6(Ipv6Addr::LOCALHOST);
    let order: Vec<IpAddr> = match listening {
        Some(Listening { v4: true, .. }) => vec![v4, v6],
        Some(Listening { v6: true, .. }) => vec![v6, v4],
        _ => vec![v4, v6],
    };
    order
        .into_iter()
        .find(|ip| TcpStream::connect_timeout(&SocketAddr::new(*ip, port), CONNECT_TIMEOUT).is_ok())
}

fn probe_port(port: u16, listening: Option<Listening>) -> Option<DetectedServer> {
    let ip = reachable(port, listening)?;
    let root = match ip {
        IpAddr::V4(_) => format!("http://127.0.0.1:{port}/"),
        IpAddr::V6(_) => format!("http://[::1]:{port}/"),
    };
    let agent = loopback_agent();
    let fetch = |route: &str, limit: u64| -> Option<String> {
        let mut response = agent.get(format!("{root}{route}")).call().ok()?;
        engine::read_decoded_body(response.body_mut(), limit).ok()
    };
    let probed = probe_with(fetch)?;
    Some(DetectedServer {
        base_url: format!("{}v1", root),
        engine: probed.engine,
        api: RuntimeApi::Openai,
        models: probed.models,
        version: probed.version,
    })
}

/// An agent for loopback probes only: no proxy (ureq reads `*_PROXY` by
/// default, which would carry a loopback request elsewhere), no redirects,
/// strict timeouts. Requests carry no credentials.
fn loopback_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .timeout_global(Some(REQUEST_TIMEOUT))
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .http_status_as_error(true)
        .build()
        .into()
}

#[derive(Deserialize)]
struct ModelList {
    #[serde(default)]
    object: Option<String>,
    #[serde(default)]
    data: Option<Vec<ModelEntry>>,
}

#[derive(Deserialize)]
struct ModelEntry {
    #[serde(default)]
    id: Option<serde_json::Value>,
    #[serde(default)]
    owned_by: Option<serde_json::Value>,
}

/// An OpenAI `GET /v1/models` answer: model ids and the `owned_by` values.
/// `None` when the body is not a model list.
pub fn parse_model_list(body: &str) -> Option<(Vec<String>, Vec<String>)> {
    let list: ModelList = serde_json::from_str(body).ok()?;
    let rows = match (list.object.as_deref(), list.data) {
        (_, Some(rows)) => rows,
        // Ollama answers `"data": null` with no models pulled.
        (Some("list"), None) => Vec::new(),
        _ => return None,
    };
    let mut seen = BTreeSet::new();
    let mut ids = Vec::new();
    let mut owners = Vec::new();
    for row in rows {
        let Some(id) = row.id.as_ref().and_then(serde_json::Value::as_str) else {
            continue;
        };
        if let Some(owner) = row.owned_by.as_ref().and_then(serde_json::Value::as_str) {
            owners.push(owner.to_string());
        }
        if is_reportable_text(id, MODEL_ID_MAX_BYTES)
            && ids.len() < DETECTED_MODELS_MAX
            && seen.insert(id.to_string())
        {
            ids.push(id.to_string());
        }
    }
    Some((ids, owners))
}

/// Text that may leave the node: non-empty, untrimmed, bounded, no control
/// or invisible formatting characters.
fn is_reportable_text(text: &str, max_bytes: usize) -> bool {
    !text.is_empty()
        && text.len() <= max_bytes
        && text.trim() == text
        && !text.chars().any(|c| c.is_control() || is_invisible(c))
}

fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{FEFF}'
    )
}

fn version_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    is_reportable_text(trimmed, VERSION_MAX_BYTES).then(|| trimmed.to_string())
}

/// A `{"version": "..."}` field (vLLM `/version`, Ollama `/api/version`,
/// SGLang `/get_server_info`, TGI `/info`).
fn version_field(body: &str, key: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    version_text(value.get(key)?.as_str()?)
}

/// The engine `owned_by` names, when every model agrees on one we know.
fn engine_from_owners(owners: &[String]) -> Option<EngineKind> {
    let kind = |owner: &str| match owner {
        "vllm" => Some(EngineKind::Vllm),
        "sglang" => Some(EngineKind::Sglang),
        "llamacpp" => Some(EngineKind::LlamaCpp),
        _ => None,
    };
    let first = kind(owners.first()?)?;
    owners
        .iter()
        .all(|owner| kind(owner) == Some(first))
        .then_some(first)
}

#[derive(Deserialize)]
struct TgiInfo {
    model_id: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    router: Option<String>,
}

/// TGI `GET /info`: recognized by `model_id` with its router name.
pub fn parse_tgi_info(body: &str) -> Option<(String, Option<String>)> {
    let info: TgiInfo = serde_json::from_str(body).ok()?;
    if !info.router.as_deref().is_some_and(|router| {
        router.starts_with("text-generation-router") || router.starts_with("text-embeddings-router")
    }) {
        return None;
    }
    Some((
        info.model_id,
        info.version.as_deref().and_then(version_text),
    ))
}

fn wire_engine(kind: Option<EngineKind>) -> Engine {
    match kind {
        Some(EngineKind::Vllm) => Engine::Vllm,
        Some(EngineKind::Sglang) => Engine::Sglang,
        Some(EngineKind::LlamaCpp) => Engine::LlamaCpp,
        Some(EngineKind::Ollama) => Engine::Ollama,
        Some(EngineKind::LmStudio) => Engine::LmStudio,
        Some(EngineKind::Generic) | None => Engine::Other,
    }
}

/// Identify one server through `fetch(route, limit)` (routes relative to the
/// server root). `None` when it does not serve an OpenAI-compatible API.
/// Pure over `fetch`, so recorded fixtures drive it.
pub fn probe_with(fetch: impl Fn(&str, u64) -> Option<String>) -> Option<Probed> {
    let cache = RefCell::new(HashMap::<String, Option<String>>::new());
    let get = |route: &str, limit: u64| -> Option<String> {
        if let Some(hit) = cache.borrow().get(route) {
            return hit.clone();
        }
        let body = fetch(route, limit);
        cache.borrow_mut().insert(route.to_string(), body.clone());
        body
    };

    let listed = get("v1/models", JSON_BODY_LIMIT).and_then(|body| parse_model_list(&body));
    let tgi = || get("info", JSON_BODY_LIMIT).and_then(|body| parse_tgi_info(&body));
    let (models, owners) = match listed {
        Some(listed) => listed,
        // TGI builds without `/v1/models` still serve `/v1/chat/completions`.
        None => {
            let (model_id, version) = tgi()?;
            let models = is_reportable_text(&model_id, MODEL_ID_MAX_BYTES)
                .then_some(model_id)
                .into_iter()
                .collect();
            return Some(Probed {
                engine: Engine::Other,
                models,
                version,
            });
        }
    };

    let kind = engine_from_owners(&owners).or_else(|| {
        let ids: Vec<(String, Option<u64>)> = models.iter().map(|id| (id.clone(), None)).collect();
        engine::detect_with(None, &ids, |route, limit| get(route, limit)).kind
    });
    let version = match kind {
        Some(EngineKind::Vllm) => {
            get("version", JSON_BODY_LIMIT).and_then(|body| version_field(&body, "version"))
        }
        Some(EngineKind::Sglang) => {
            get("get_server_info", JSON_BODY_LIMIT).and_then(|body| version_field(&body, "version"))
        }
        Some(EngineKind::LlamaCpp) => {
            get("props", JSON_BODY_LIMIT).and_then(|body| version_field(&body, "build_info"))
        }
        Some(EngineKind::Ollama) => {
            get("api/version", JSON_BODY_LIMIT).and_then(|body| version_field(&body, "version"))
        }
        Some(EngineKind::LmStudio | EngineKind::Generic) => None,
        None => tgi().and_then(|(_, version)| version),
    };
    Some(Probed {
        engine: wire_engine(kind),
        models,
        version,
    })
}

/// TCP ports this machine listens on at loopback or a wildcard address
/// (Linux `/proc/net/tcp{,6}`); empty elsewhere.
pub fn listening_ports() -> BTreeMap<u16, Listening> {
    let mut ports = BTreeMap::new();
    for (path, v6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
        if let Ok(text) = std::fs::read_to_string(path) {
            merge_listening(&mut ports, &text, v6);
        }
    }
    ports
}

/// Fold one `/proc/net/tcp` (or `tcp6`) table into `ports`.
pub fn merge_listening(ports: &mut BTreeMap<u16, Listening>, table: &str, v6: bool) {
    for line in table.lines().skip(1) {
        let mut fields = line.split_whitespace();
        let (Some(_slot), Some(local), Some(_remote), Some(state)) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        // `0A` is TCP_LISTEN.
        if state != "0A" {
            continue;
        }
        let Some((address, port)) = local.split_once(':') else {
            continue;
        };
        let Ok(port) = u16::from_str_radix(port, 16) else {
            continue;
        };
        let reachable = if v6 {
            v6_loopback_or_any(address)
        } else {
            v4_loopback_or_any(address)
        };
        let Some(family_v6) = reachable else {
            continue;
        };
        let entry = ports.entry(port).or_default();
        if family_v6 {
            entry.v6 = true;
        } else {
            entry.v4 = true;
        }
    }
}

/// `/proc/net/tcp` stores the address as one host-order u32 in hex. Returns
/// `Some(false)` (an IPv4 listener) for 0.0.0.0 and 127.0.0.0/8.
fn v4_loopback_or_any(hex: &str) -> Option<bool> {
    if hex.len() != 8 {
        return None;
    }
    let raw = u32::from_str_radix(hex, 16).ok()?;
    // The kernel prints the network-order bytes as a host-order word.
    let ip = Ipv4Addr::from(if cfg!(target_endian = "little") {
        raw.swap_bytes()
    } else {
        raw
    });
    (ip.is_unspecified() || ip.is_loopback()).then_some(false)
}

/// `/proc/net/tcp6` stores four host-order u32 words. `::` and `::1` are an
/// IPv6 listener (`Some(true)`); a v4-mapped loopback or wildcard is an IPv4
/// one (`Some(false)`).
fn v6_loopback_or_any(hex: &str) -> Option<bool> {
    if hex.len() != 32 {
        return None;
    }
    let mut octets = [0u8; 16];
    for word in 0..4 {
        let raw = u32::from_str_radix(&hex[word * 8..word * 8 + 8], 16).ok()?;
        let bytes = if cfg!(target_endian = "little") {
            raw.swap_bytes().to_be_bytes()
        } else {
            raw.to_be_bytes()
        };
        octets[word * 4..word * 4 + 4].copy_from_slice(&bytes);
    }
    let ip = Ipv6Addr::from(octets);
    if ip.is_unspecified() || ip.is_loopback() {
        return Some(true);
    }
    match ip.to_ipv4_mapped() {
        Some(v4) if v4.is_loopback() || v4.is_unspecified() => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VLLM_MODELS: &str = include_str!("../../tests/fixtures/detect/vllm-models.json");
    const VLLM_VERSION: &str = include_str!("../../tests/fixtures/detect/vllm-version.json");
    const SGLANG_MODELS: &str = include_str!("../../tests/fixtures/detect/sglang-models.json");
    const SGLANG_INFO: &str = include_str!("../../tests/fixtures/engines/sglang-server-info.json");
    const LLAMA_MODELS: &str = include_str!("../../tests/fixtures/detect/llama-models.json");
    const LLAMA_PROPS: &str = include_str!("../../tests/fixtures/detect/llama-props.json");
    const OLLAMA_MODELS: &str = include_str!("../../tests/fixtures/detect/ollama-models.json");
    const OLLAMA_VERSION: &str = include_str!("../../tests/fixtures/engines/ollama-version.json");
    const LM_STUDIO_V1: &str = include_str!("../../tests/fixtures/detect/lm-studio-v1-models.json");
    const LM_STUDIO_V0: &str = include_str!("../../tests/fixtures/engines/lm-studio-models.json");
    const TGI_INFO: &str = include_str!("../../tests/fixtures/detect/tgi-info.json");
    const TGI_MODELS: &str = include_str!("../../tests/fixtures/detect/tgi-models.json");
    const SPEACHES_MODELS: &str = include_str!("../../tests/fixtures/detect/speaches-models.json");
    const PROC_TCP: &str = include_str!("../../tests/fixtures/detect/proc-net-tcp.txt");
    const PROC_TCP6: &str = include_str!("../../tests/fixtures/detect/proc-net-tcp6.txt");

    /// A fake server: routes to bodies; every other route fails. Records the
    /// routes asked for.
    fn server<'a>(
        routes: &'a [(&'a str, &'a str)],
        asked: &'a RefCell<Vec<String>>,
    ) -> impl Fn(&str, u64) -> Option<String> + 'a {
        move |route, limit| {
            asked.borrow_mut().push(route.to_string());
            routes
                .iter()
                .find(|(path, _)| *path == route)
                .map(|(_, body)| body.to_string())
                .filter(|body| body.len() as u64 <= limit)
        }
    }

    fn probe(routes: &[(&str, &str)]) -> (Option<Probed>, Vec<String>) {
        let asked = RefCell::new(Vec::new());
        let probed = probe_with(server(routes, &asked));
        (probed, asked.into_inner())
    }

    #[test]
    fn vllm_is_named_by_owned_by_and_reports_its_version() {
        let (probed, asked) = probe(&[("v1/models", VLLM_MODELS), ("version", VLLM_VERSION)]);
        let probed = probed.expect("vllm");
        assert_eq!(probed.engine, Engine::Vllm);
        assert_eq!(probed.models, vec!["Qwen/Qwen3-32B", "qwen3"]);
        assert_eq!(probed.version.as_deref(), Some("0.11.0"));
        // `owned_by` names it: no engine-route probing beyond the version.
        assert_eq!(asked, vec!["v1/models", "version"]);
    }

    #[test]
    fn sglang_llama_and_ollama_report_engine_and_version() {
        let (sglang, _) = probe(&[
            ("v1/models", SGLANG_MODELS),
            ("get_server_info", SGLANG_INFO),
        ]);
        let sglang = sglang.expect("sglang");
        assert_eq!(sglang.engine, Engine::Sglang);
        assert_eq!(sglang.models, vec!["qwen"]);
        assert_eq!(sglang.version.as_deref(), Some("0.4.9"));

        let (llama, _) = probe(&[("v1/models", LLAMA_MODELS), ("props", LLAMA_PROPS)]);
        let llama = llama.expect("llama.cpp");
        assert_eq!(llama.engine, Engine::LlamaCpp);
        assert_eq!(llama.models, vec!["gpt-oss-120b-mxfp4.gguf"]);
        assert_eq!(llama.version.as_deref(), Some("b6715-c7be9feb"));

        // Ollama's `owned_by` is a namespace: the `/api/version` route names it.
        let (ollama, _) = probe(&[
            ("v1/models", OLLAMA_MODELS),
            ("api/version", OLLAMA_VERSION),
        ]);
        let ollama = ollama.expect("ollama");
        assert_eq!(ollama.engine, Engine::Ollama);
        assert_eq!(ollama.models, vec!["gpt-oss:20b", "qwen3-embedding:8b"]);
        assert_eq!(ollama.version.as_deref(), Some("0.9.6"));
    }

    #[test]
    fn lm_studio_tgi_and_speech_servers_are_found() {
        let (lm, _) = probe(&[("v1/models", LM_STUDIO_V1), ("api/v0/models", LM_STUDIO_V0)]);
        let lm = lm.expect("lm studio");
        assert_eq!(lm.engine, Engine::LmStudio);
        assert_eq!(lm.version, None);

        let (tgi, _) = probe(&[("v1/models", TGI_MODELS), ("info", TGI_INFO)]);
        let tgi = tgi.expect("tgi");
        assert_eq!(tgi.engine, Engine::Other);
        assert_eq!(tgi.models, vec!["meta-llama/Llama-3.1-8B-Instruct"]);
        assert_eq!(tgi.version.as_deref(), Some("3.3.4"));

        // An older TGI without `/v1/models` is found through `/info`.
        let (tgi_info_only, _) = probe(&[("info", TGI_INFO)]);
        let tgi_info_only = tgi_info_only.expect("tgi via info");
        assert_eq!(
            tgi_info_only.models,
            vec!["meta-llama/Llama-3.1-8B-Instruct"]
        );

        let (speaches, _) = probe(&[("v1/models", SPEACHES_MODELS)]);
        let speaches = speaches.expect("speech server");
        assert_eq!(speaches.engine, Engine::Other);
        assert_eq!(
            speaches.models,
            vec![
                "Systran/faster-whisper-large-v3",
                "deepdml/faster-whisper-large-v3-turbo-ct2"
            ]
        );
    }

    #[test]
    fn a_server_without_an_openai_api_is_not_reported() {
        let (probed, _) = probe(&[("", "<html>whisper.cpp</html>"), ("health", "ok")]);
        assert_eq!(probed, None);
        let (probed, _) = probe(&[("v1/models", "{\"error\":\"not found\"}")]);
        assert_eq!(probed, None);
        let (probed, _) = probe(&[("info", "{\"model_id\":\"x\",\"router\":\"other\"}")]);
        assert_eq!(probed, None);
    }

    #[test]
    fn model_ids_and_versions_stay_within_the_frame_contract() {
        let long = "m".repeat(257);
        let mut rows: Vec<String> = (0..100)
            .map(|index| format!("{{\"id\":\"model-{index}\"}}"))
            .collect();
        rows.insert(0, format!("{{\"id\":\"{long}\"}}"));
        rows.insert(0, "{\"id\":\"bad\\u0007bell\"}".to_string());
        rows.insert(0, "{\"id\":\" padded\"}".to_string());
        rows.insert(0, "{\"id\":\"\"}".to_string());
        rows.insert(0, "{\"id\":7}".to_string());
        rows.insert(0, "{\"id\":\"model-0\"}".to_string());
        let body = format!("{{\"object\":\"list\",\"data\":[{}]}}", rows.join(","));
        let (models, _) = parse_model_list(&body).expect("list");
        assert_eq!(models.len(), DETECTED_MODELS_MAX);
        assert_eq!(models[0], "model-0");
        assert!(models.iter().all(|id| is_reportable_text(id, 256)));
        assert_eq!(version_text(&"9".repeat(81)), None);
        assert_eq!(version_text("  0.1.0 \n").as_deref(), Some("0.1.0"));
        assert_eq!(
            parse_model_list("{\"object\":\"list\",\"data\":null}"),
            Some((vec![], vec![]))
        );
    }

    #[test]
    fn the_frame_rules_hold_detected_servers_to_loopback_and_bounds() {
        let server = |base_url: &str, models: usize, version: Option<&str>| DetectedServer {
            base_url: base_url.into(),
            engine: Engine::Other,
            api: RuntimeApi::Openai,
            models: (0..models).map(|index| format!("m{index}")).collect(),
            version: version.map(str::to_string),
        };
        let frame = |servers: Vec<DetectedServer>| NodeFrame::RuntimeDetected {
            id: None,
            scanned_at: crate::telemetry::now_rfc3339(),
            servers,
        };
        for ok in [
            "http://127.0.0.1:8000/v1",
            "http://[::1]:30000",
            "http://localhost:11434/v1",
        ] {
            assert!(
                frame(vec![server(ok, 1, Some("1"))]).validate().is_ok(),
                "{ok}"
            );
        }
        for bad in [
            "http://10.0.0.5:8000/v1",
            "https://127.0.0.1:8000/v1",
            "http://127.0.0.1:123456/v1",
            "http://127.0.0.1:8000/v2",
            "http://127.0.0.1.evil:8000/v1",
        ] {
            assert!(
                frame(vec![server(bad, 1, None)]).validate().is_err(),
                "{bad}"
            );
        }
        let url = "http://127.0.0.1:8000/v1";
        assert!(frame(vec![server(url, 65, None)]).validate().is_err());
        assert!(frame(vec![server(url, 1, Some(" "))]).validate().is_err());
        assert!(frame(vec![server(url, 0, None); 17]).validate().is_err());
    }

    #[test]
    fn mixed_owners_fall_back_to_engine_routes() {
        // A proxy fronting several engines names none: the routes decide.
        let body = r#"{"object":"list","data":[{"id":"a","owned_by":"vllm"},{"id":"b","owned_by":"sglang"}]}"#;
        let (probed, asked) = probe(&[("v1/models", body)]);
        assert_eq!(probed.expect("generic").engine, Engine::Other);
        assert!(asked.contains(&"props".to_string()));
    }

    #[test]
    fn proc_net_tables_yield_loopback_and_wildcard_listeners_only() {
        let mut ports = BTreeMap::new();
        merge_listening(&mut ports, PROC_TCP, false);
        merge_listening(&mut ports, PROC_TCP6, true);
        // 127.0.0.1:8000 (vLLM), 0.0.0.0:11434, 0.0.0.0:22, [::1]:30000,
        // [::]:8080; 192.168.1.20:9000 is LAN-only and 127.0.0.1:43122 is an
        // established connection, not a listener.
        assert_eq!(
            ports,
            BTreeMap::from([
                (
                    22,
                    Listening {
                        v4: true,
                        v6: false
                    }
                ),
                (
                    8000,
                    Listening {
                        v4: true,
                        v6: false
                    }
                ),
                (
                    8080,
                    Listening {
                        v4: false,
                        v6: true
                    }
                ),
                (
                    11434,
                    Listening {
                        v4: true,
                        v6: false
                    }
                ),
                (
                    30000,
                    Listening {
                        v4: false,
                        v6: true
                    }
                ),
            ])
        );
        assert!(!ports.contains_key(&9000));
    }

    #[test]
    fn candidates_skip_instances_privileged_and_never_probed_ports_and_are_bounded() {
        let listening: BTreeMap<u16, Listening> = [22, 5432, 6379, 8000, 20001, 20002, 41000]
            .into_iter()
            .map(|port| {
                (
                    port,
                    Listening {
                        v4: true,
                        v6: false,
                    },
                )
            })
            .collect();
        let skip = BTreeSet::from([20001, 30000]);
        let ports = candidate_ports(&[8000, 30000, 11434], &listening, &skip);
        assert_eq!(ports, vec![8000, 11434, 20002, 41000]);

        let many: BTreeMap<u16, Listening> = (40000..40200)
            .map(|port| (port, Listening::default()))
            .collect();
        let ports = candidate_ports(WELL_KNOWN_PORTS, &many, &BTreeSet::new());
        assert_eq!(ports.len(), CANDIDATE_PORTS_MAX);
        assert_eq!(&ports[..WELL_KNOWN_PORTS.len()], WELL_KNOWN_PORTS);
    }

    #[test]
    fn a_live_loopback_server_is_detected_without_credentials() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let seen = std::thread::spawn(move || {
            let mut requests = Vec::new();
            // The connect check opens (and closes) one connection first.
            for stream in listener.incoming() {
                let mut stream = stream.expect("accept");
                let mut buffer = [0u8; 4096];
                let read = stream.read(&mut buffer).unwrap_or(0);
                if read == 0 {
                    continue;
                }
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let body = if request.starts_with("GET /v1/models ") {
                    VLLM_MODELS
                } else {
                    VLLM_VERSION
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                requests.push(request);
                if requests.len() == 2 {
                    return requests;
                }
            }
            requests
        });
        let server = probe_port(
            port,
            Some(Listening {
                v4: true,
                v6: false,
            }),
        )
        .expect("detected");
        assert_eq!(server.base_url, format!("http://127.0.0.1:{port}/v1"));
        assert_eq!(server.engine, Engine::Vllm);
        assert_eq!(server.version.as_deref(), Some("0.11.0"));
        let requests = seen.join().expect("server thread");
        for request in requests {
            let lower = request.to_ascii_lowercase();
            assert!(!lower.contains("authorization"), "{request}");
            assert!(!lower.contains("x-api-key"), "{request}");
            assert!(!lower.contains("cookie"), "{request}");
        }
        let frame = NodeFrame::RuntimeDetected {
            id: Some("det-1".into()),
            scanned_at: crate::telemetry::now_rfc3339(),
            servers: vec![server],
        };
        assert!(frame.validate().is_ok());
    }
}
